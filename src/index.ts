import {
  DestinationCapacityError,
  ensureDestinationAddress,
} from './cloudflare-destinations';
import {
  isValidEmail,
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
import { parseSubmission } from './submission';
import type {
  DeliveryMode,
  Env,
  LegacyAccessKeyData,
  PendingRoutePayload,
  RouteTokenPayload,
} from './types';

export { InboxQuota };
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

async function parseRouteRequest(request: Request): Promise<{ email: string; formName: string }> {
  let body: { email?: unknown; formName?: unknown; form_name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw new Response('A JSON body is required', { status: 400 });
  }

  if (typeof body.email !== 'string' || !isValidEmail(normalizeEmail(body.email))) {
    throw new Response('A valid email address is required', { status: 400 });
  }
  const rawFormName = body.formName ?? body.form_name;
  if (
    typeof rawFormName !== 'string' ||
    !rawFormName.trim() ||
    rawFormName.trim().length > MAX_FORM_NAME_LENGTH
  ) {
    throw new Response(`Form name must be between 1 and ${MAX_FORM_NAME_LENGTH} characters`, {
      status: 400,
    });
  }
  return { email: normalizeEmail(body.email), formName: rawFormName.trim() };
}

async function createRoute(request: Request, env: Env): Promise<Response> {
  const { email, formName } = await parseRouteRequest(request);
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
  const route = routePayload(email, formName, ownerId);
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

    const token = await sealToken(route, env.ROUTE_TOKEN_SECRET);
    return json(
      {
        success: true,
        status: destination.status === 'verified' ? 'active' : 'pending_verification',
        endpoint: submissionEndpoint(env, origin, token),
        form_name: formName,
        message:
          destination.status === 'verified'
            ? 'Your form endpoint is ready.'
            : 'Check your inbox for Cloudflare’s verification email. Your endpoint will begin delivering after you confirm it.',
      },
      destination.status === 'verified' ? 201 : 202,
    );
  }

  const now = Date.now();
  const pending: PendingRoutePayload = {
    ...route,
    kind: 'pending',
    issuedAt: now,
    expiresAt: now + ROUTE_TOKEN_TTL_SECONDS * 1000,
  };
  const pendingToken = await sealToken(pending, env.ROUTE_TOKEN_SECRET);
  await sendArbitraryVerification(env, pending, pendingToken, origin);
  return json(
    {
      success: true,
      status: 'pending_verification',
      form_name: formName,
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
  const route = routePayload(
    pending.email,
    pending.formName,
    pending.ownerId,
    pending.routeId,
  );
  const routeToken = await sealToken(route, env.ROUTE_TOKEN_SECRET);
  return json({
    success: true,
    status: 'active',
    endpoint: submissionEndpoint(env, new URL(request.url).origin, routeToken),
    form_name: route.formName,
    message: 'Your form endpoint is ready.',
  });
}

async function resolveLegacyRoute(
  accessKey: string | undefined,
  env: Env,
): Promise<RouteTokenPayload | null> {
  if (!accessKey || !env.LEGACY_ACCESS_KEYS) return null;
  const legacy = (await env.LEGACY_ACCESS_KEYS.get(
    accessKey,
    'json',
  )) as LegacyAccessKeyData | null;
  if (!legacy?.email || !isValidEmail(normalizeEmail(legacy.email))) return null;
  const email = normalizeEmail(legacy.email);
  return routePayload(
    email,
    legacy.form_name?.trim() || 'Conform form',
    await ownerIdForEmail(email, env.OWNER_HASH_SECRET),
    `legacy-${accessKey.slice(0, 16)}`,
  );
}

function thresholdCrossed(used: number, limit: number): boolean {
  if (limit <= 0) return false;
  return used === Math.max(1, Math.ceil(limit * 0.8)) || used === limit;
}

async function submit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  token?: string,
): Promise<Response> {
  const parsed = await parseSubmission(request, maxRequestSize(env));
  if (parsed.spam) return json({ success: true, message: 'Submission received' });
  if (Object.keys(parsed.fields).length === 0) {
    return json({ success: false, message: 'Form data is required' }, 400);
  }

  let route: RouteTokenPayload;
  if (token) {
    route = await openToken<RouteTokenPayload>(token, 'route', env.ROUTE_TOKEN_SECRET);
  } else {
    const rawAccessKey = parsed.allFields.access_key;
    const accessKey = Array.isArray(rawAccessKey) ? rawAccessKey[0] : rawAccessKey;
    const legacy = await resolveLegacyRoute(accessKey, env);
    if (!legacy) return json({ success: false, message: 'Invalid access key' }, 401);
    route = legacy;
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
        new_route_destination_email_in_quota_or_route_storage: false,
        legacy_destination_records: env.LEGACY_ACCESS_KEYS ? 'read_only' : 'not_bound',
        quota: ['opaque inbox id', 'UTC month', 'used count', 'limit'],
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

  if (request.method === 'POST' && url.pathname.startsWith('/f/')) {
    const token = decodeURIComponent(url.pathname.slice('/f/'.length));
    return submit(request, env, ctx, token);
  }

  if (request.method === 'POST' && url.pathname === '/submit') {
    return submit(request, env, ctx);
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
