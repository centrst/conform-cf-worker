import {
  DestinationCapacityError,
  destinationAddressStatus,
  ensureDestinationAddress,
} from './cloudflare-destinations';
import {
  isValidEmail,
  isValidFormId,
  normalizeEmail,
  openToken,
  ownerIdForEmail,
  randomRouteId,
  sealToken,
} from './crypto';
import {
  sendArbitraryVerification,
  sendQuotaWarning,
  sendSubmissionEmail,
  submissionEndpoint,
} from './email';
import { InboxQuota, reserveQuota, rollbackQuota } from './quota';
import {
  activateStoredRoute,
  createStoredRoute,
  FormRoute,
  getStoredRoute,
} from './routes';
import { parseSubmission } from './submission';
import type {
  DeliveryMode,
  Env,
  PendingRoutePayload,
  RouteTokenPayload,
  StoredRouteRecord,
} from './types';

export { FormRoute, InboxQuota };
export { openToken, ownerIdForEmail, sealToken } from './crypto';

const ROUTE_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MAX_FORM_NAME_LENGTH = 120;

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function deliveryMode(env: Env): DeliveryMode {
  return env.DELIVERY_MODE === 'arbitrary' ? 'arbitrary' : 'verified';
}

function monthlyLimit(env: Env): number {
  const parsed = Number.parseInt(env.MONTHLY_LIMIT ?? '250', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 250;
}

function maxRequestSize(env: Env): number {
  const parsed = Number.parseInt(env.MAX_REQUEST_SIZE ?? '102400', 10);
  return Number.isFinite(parsed) ? Math.max(1024, parsed) : 102400;
}

function routePayload(
  email: string,
  formName: string,
  ownerId: string,
  routeId = randomRouteId(),
): RouteTokenPayload {
  return {
    kind: 'route',
    version: 1,
    email,
    formName,
    ownerId,
    routeId,
    issuedAt: Date.now(),
  };
}

async function parseRouteRequest(request: Request): Promise<{ email: string; alias: string }> {
  let body: {
    email?: unknown;
    alias?: unknown;
    formName?: unknown;
    form_name?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw new Response('A JSON body is required', { status: 400 });
  }

  if (typeof body.email !== 'string' || !isValidEmail(normalizeEmail(body.email))) {
    throw new Response('A valid email address is required', { status: 400 });
  }
  const rawFormName = body.alias ?? body.formName ?? body.form_name;
  if (
    typeof rawFormName !== 'string' ||
    !rawFormName.trim() ||
    rawFormName.trim().length > MAX_FORM_NAME_LENGTH
  ) {
    throw new Response(`Form name must be between 1 and ${MAX_FORM_NAME_LENGTH} characters`, {
      status: 400,
    });
  }
  return { email: normalizeEmail(body.email), alias: rawFormName.trim() };
}

async function storeNewRoute(
  env: Env,
  email: string,
  alias: string,
  ownerId: string,
  status: StoredRouteRecord['status'],
  destinationId?: string,
): Promise<{ route: RouteTokenPayload; record: StoredRouteRecord }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const formId = randomRouteId();
    const route = routePayload(email, alias, ownerId, formId);
    const record: StoredRouteRecord = {
      formId,
      alias,
      ownerId,
      encryptedRoute: await sealToken(route, env.ROUTE_TOKEN_SECRET),
      status,
      destinationId,
      createdAt: new Date().toISOString(),
    };
    if (await createStoredRoute(env, record)) return { route, record };
  }
  throw new Error('Could not allocate a unique form ID');
}

async function createRoute(request: Request, env: Env): Promise<Response> {
  const { email, alias } = await parseRouteRequest(request);
  const ownerId = await ownerIdForEmail(email, env.OWNER_HASH_SECRET);
  if (env.REGISTRATION_RATE_LIMITER) {
    const clientAddress = request.headers.get('cf-connecting-ip') || 'unknown';
    const clientId = await ownerIdForEmail(
      `registration-client:${clientAddress}`,
      env.OWNER_HASH_SECRET,
    );
    const [clientLimit, inboxLimit] = await Promise.all([
      env.REGISTRATION_RATE_LIMITER.limit({ key: `client:${clientId}` }),
      env.REGISTRATION_RATE_LIMITER.limit({ key: `inbox:${ownerId}` }),
    ]);
    if (!clientLimit.success || !inboxLimit.success) {
      return json(
        {
          success: false,
          message: 'Too many form registrations. Try again in a minute.',
        },
        429,
      );
    }
  }
  const origin = new URL(request.url).origin;

  if (deliveryMode(env) === 'verified') {
    let destination;
    try {
      destination = await ensureDestinationAddress(
        email,
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_TOKEN,
      );
    } catch (error) {
      if (error instanceof DestinationCapacityError) {
        return json(
          {
            success: false,
            error: 'verified_destination_capacity',
            message:
              'Verified-inbox capacity is full. Set DELIVERY_MODE=arbitrary to continue onboarding.',
          },
          503,
        );
      }
      throw error;
    }

    const status = destination.status === 'verified' ? 'active' : 'pending';
    const { record } = await storeNewRoute(
      env,
      email,
      alias,
      ownerId,
      status,
      destination.addressId,
    );
    return json(
      {
        success: true,
        status: status === 'active' ? 'active' : 'pending_verification',
        form_id: record.formId,
        alias,
        endpoint: submissionEndpoint(env, origin, record.formId),
        message:
          destination.status === 'verified'
            ? 'Your form endpoint is ready.'
            : 'Check your inbox for Cloudflare’s verification email. Your endpoint will begin delivering after you confirm it.',
      },
      destination.status === 'verified' ? 201 : 202,
    );
  }

  const now = Date.now();
  const formId = randomRouteId();
  const route = routePayload(email, alias, ownerId, formId);
  const pending: PendingRoutePayload = {
    ...route,
    kind: 'pending',
    issuedAt: now,
    expiresAt: now + ROUTE_TOKEN_TTL_SECONDS * 1000,
  };
  const pendingToken = await sealToken(pending, env.ROUTE_TOKEN_SECRET);
  await sendArbitraryVerification(env, pending, pendingToken, origin);
  const record: StoredRouteRecord = {
    formId,
    alias,
    ownerId,
    encryptedRoute: await sealToken(route, env.ROUTE_TOKEN_SECRET),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  if (!(await createStoredRoute(env, record))) {
    throw new Error('Could not allocate a unique form ID');
  }
  return json(
    {
      success: true,
      status: 'pending_verification',
      form_id: formId,
      alias,
      endpoint: submissionEndpoint(env, origin, formId),
      message: 'Check your inbox to confirm this form.',
    },
    202,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function verificationPage(token: string): Response {
  const safeToken = escapeHtml(token);
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm Conform route</title>
<body>
  <main>
    <h1>Confirm this Conform route</h1>
    <p>Confirm that this inbox should receive the form submissions.</p>
    <form method="post" action="/v1/routes/verify">
      <input type="hidden" name="token" value="${safeToken}">
      <button type="submit">Confirm inbox</button>
    </form>
  </main>
</body>
</html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      },
    },
  );
}

async function verifyArbitraryRoute(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') {
    const token = new URL(request.url).searchParams.get('token');
    if (!token) return json({ success: false, message: 'Verification token is required' }, 400);
    await openToken<PendingRoutePayload>(token, 'pending', env.ROUTE_TOKEN_SECRET);
    return verificationPage(token);
  }

  const form = await request.formData();
  const token = form.get('token');
  if (typeof token !== 'string') {
    return json({ success: false, message: 'Verification token is required' }, 400);
  }
  const pending = await openToken<PendingRoutePayload>(
    token,
    'pending',
    env.ROUTE_TOKEN_SECRET,
  );
  if (pending.expiresAt < Date.now()) {
    return json({ success: false, message: 'Verification token has expired' }, 410);
  }
  if (!isValidFormId(pending.routeId)) {
    return json({ success: false, message: 'Invalid form ID' }, 400);
  }
  const stored = await getStoredRoute(env, pending.routeId);
  if (!stored) return json({ success: false, message: 'Form route not found' }, 404);
  const route = await openToken<RouteTokenPayload>(
    stored.encryptedRoute,
    'route',
    env.ROUTE_TOKEN_SECRET,
  );
  if (
    route.routeId !== pending.routeId ||
    route.ownerId !== pending.ownerId ||
    route.email !== pending.email ||
    route.formName !== pending.formName
  ) {
    return json({ success: false, message: 'Verification does not match this route' }, 409);
  }
  const activated = await activateStoredRoute(env, pending.routeId);
  if (!activated) return json({ success: false, message: 'Form route not found' }, 404);
  return json({
    success: true,
    status: 'active',
    form_id: activated.formId,
    alias: activated.alias,
    endpoint: submissionEndpoint(env, new URL(request.url).origin, activated.formId),
    message: 'Your form endpoint is ready.',
  });
}

async function refreshVerifiedRoute(
  env: Env,
  record: StoredRouteRecord,
): Promise<StoredRouteRecord> {
  if (
    record.status === 'active' ||
    deliveryMode(env) !== 'verified' ||
    !record.destinationId
  ) {
    return record;
  }
  const destination = await destinationAddressStatus(
    record.destinationId,
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_API_TOKEN,
  );
  if (destination.status !== 'verified') return record;
  return (await activateStoredRoute(env, record.formId)) ?? record;
}

async function routeStatus(
  request: Request,
  env: Env,
  formId: string,
): Promise<Response> {
  if (!isValidFormId(formId)) {
    return json({ success: false, message: 'Form route not found' }, 404);
  }
  const found = await getStoredRoute(env, formId);
  if (!found) return json({ success: false, message: 'Form route not found' }, 404);
  const record = await refreshVerifiedRoute(env, found);
  return json({
    success: true,
    status: record.status === 'active' ? 'active' : 'pending_verification',
    form_id: record.formId,
    alias: record.alias,
    endpoint: submissionEndpoint(env, new URL(request.url).origin, record.formId),
  });
}

function thresholdCrossed(used: number, limit: number): boolean {
  if (limit <= 0) return false;
  return used === Math.max(1, Math.ceil(limit * 0.8)) || used === limit;
}

async function submit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  formId: string,
): Promise<Response> {
  const parsed = await parseSubmission(request, maxRequestSize(env));
  if (parsed.spam) return json({ success: true, message: 'Submission received' });
  if (Object.keys(parsed.fields).length === 0) {
    return json({ success: false, message: 'Form data is required' }, 400);
  }

  if (!isValidFormId(formId)) {
    return json({ success: false, message: 'Form route not found' }, 404);
  }
  const found = await getStoredRoute(env, formId);
  if (!found) return json({ success: false, message: 'Form route not found' }, 404);
  const record = await refreshVerifiedRoute(env, found);
  if (record.status !== 'active') {
    return json(
      {
        success: false,
        error: 'inbox_not_verified',
        message: 'This inbox has not been verified yet.',
      },
      409,
    );
  }
  const route = await openToken<RouteTokenPayload>(
    record.encryptedRoute,
    'route',
    env.ROUTE_TOKEN_SECRET,
  );
  if (
    route.routeId !== record.formId ||
    route.ownerId !== record.ownerId ||
    route.formName !== record.alias
  ) {
    throw new Error('Stored route metadata does not match its encrypted payload');
  }

  const reservation = await reserveQuota(env, route.ownerId, monthlyLimit(env));
  if (!reservation.allowed) {
    return json(
      {
        success: false,
        error: 'monthly_allowance_exhausted',
        message: 'This inbox has reached its shared monthly submission allowance.',
        used: reservation.used,
        limit: reservation.limit,
      },
      429,
    );
  }

  try {
    await sendSubmissionEmail(env, route, parsed.fields, {
      format: parsed.format,
      replyTo: parsed.replyTo,
      subject: parsed.subject,
    });
  } catch {
    if (reservation.limit > 0) {
      try {
        await rollbackQuota(env, route.ownerId, reservation.month);
      } catch {
        // The delivery failed, so the response remains an error even if rollback
        // also fails. No form fields are included in logs or error messages.
      }
    }
    return json({ success: false, message: 'Email delivery failed' }, 503);
  }

  if (thresholdCrossed(reservation.used, reservation.limit)) {
    ctx.waitUntil(
      sendQuotaWarning(env, route, reservation.used, reservation.limit).catch(() => undefined),
    );
  }

  return json({
    success: true,
    message: 'Submission delivered',
    used: reservation.limit > 0 ? reservation.used : undefined,
    limit: reservation.limit > 0 ? reservation.limit : undefined,
  });
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return json({
      name: 'conform-cf-worker',
      version: env.SOURCE_COMMIT || 'development',
      source: env.SOURCE_URL || 'https://github.com/centrst/conform-cf-worker',
      delivery_mode: deliveryMode(env),
      persistence: {
        submission_fields: false,
        destination_email_plaintext: false,
        route: [
          'form id',
          'alias',
          'opaque inbox id',
          'encrypted destination',
          'verification status',
          'Cloudflare destination id',
        ],
        quota: ['opaque inbox id', 'UTC month', 'used count', 'limit'],
        workers_kv: false,
      },
    });
  }

  if (url.pathname === '/v1/routes' && request.method === 'POST') {
    return createRoute(request, env);
  }

  if (
    url.pathname === '/v1/routes/verify' &&
    (request.method === 'GET' || request.method === 'POST')
  ) {
    if (deliveryMode(env) !== 'arbitrary') {
      return json({ success: false, message: 'Cloudflare verifies this inbox directly' }, 404);
    }
    return verifyArbitraryRoute(request, env);
  }

  if (request.method === 'GET' && url.pathname.startsWith('/v1/routes/')) {
    const formId = decodeURIComponent(url.pathname.slice('/v1/routes/'.length));
    return routeStatus(request, env, formId);
  }

  if (request.method === 'POST' && url.pathname.startsWith('/f/')) {
    const formId = decodeURIComponent(url.pathname.slice('/f/'.length));
    return submit(request, env, ctx, formId);
  }

  return json({ success: false, message: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      if (error instanceof Response) return error;
      if (
        error instanceof Error &&
        (error.message.includes('token') || error.message.includes('not configured'))
      ) {
        const configurationError = error.message.includes('not configured');
        return json(
          {
            success: false,
            message: configurationError ? 'Worker configuration is incomplete' : 'Invalid route',
          },
          configurationError ? 500 : 401,
        );
      }
      return json({ success: false, message: 'Request could not be processed' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
