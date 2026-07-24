import openapiSpec from '../openapi.json';
import {
  DestinationCapacityError,
  destinationAddressStatus,
  ensureDestinationAddress,
} from './cloudflare-destinations';
import { nextActionFor, quotaResetsAt, routeResource } from './contract';
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
  publicUrl,
  routeStatusUrl,
  sendArbitraryVerification,
  sendQuotaWarning,
  sendSubmissionEmail,
  submissionEndpoint,
} from './email';
import { ApiError, ConfigError, TokenError, errorResponse, json } from './errors';
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
    throw new ApiError('invalid_json', 'A JSON body is required');
  }

  if (typeof body.email !== 'string' || !isValidEmail(normalizeEmail(body.email))) {
    throw new ApiError('invalid_email', 'A valid email address is required');
  }
  const rawFormName = body.alias ?? body.formName ?? body.form_name;
  if (
    typeof rawFormName !== 'string' ||
    !rawFormName.trim() ||
    rawFormName.trim().length > MAX_FORM_NAME_LENGTH
  ) {
    throw new ApiError(
      'invalid_alias',
      `Form name must be between 1 and ${MAX_FORM_NAME_LENGTH} characters`,
    );
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
      throw new ApiError('rate_limited', 'Too many form registrations. Try again in a minute.', {
        retry_after_seconds: 60,
      });
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
        throw new ApiError(
          'verified_destination_capacity',
          'Verified-inbox capacity is full. Set DELIVERY_MODE=arbitrary to continue onboarding.',
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
      routeResource({
        status,
        formId: record.formId,
        alias,
        endpoint: submissionEndpoint(env, origin, record.formId),
        statusUrl: routeStatusUrl(env, origin, record.formId),
        message:
          destination.status === 'verified'
            ? 'Your form endpoint is ready.'
            : 'Check your inbox for Cloudflare’s verification email. Your endpoint will begin delivering after you confirm it.',
      }),
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
    routeResource({
      status: 'pending',
      formId,
      alias,
      endpoint: submissionEndpoint(env, origin, formId),
      statusUrl: routeStatusUrl(env, origin, formId),
      verificationExpiresAt: new Date(pending.expiresAt).toISOString(),
      message: 'Check your inbox to confirm this form.',
    }),
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
<title>Confirm conForm route</title>
<body>
  <main>
    <h1>Confirm this conForm route</h1>
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
    if (!token) {
      throw new ApiError('verification_token_required', 'Verification token is required');
    }
    await openToken<PendingRoutePayload>(token, 'pending', env.ROUTE_TOKEN_SECRET);
    return verificationPage(token);
  }

  const form = await request.formData();
  const token = form.get('token');
  if (typeof token !== 'string') {
    throw new ApiError('verification_token_required', 'Verification token is required');
  }
  const pending = await openToken<PendingRoutePayload>(
    token,
    'pending',
    env.ROUTE_TOKEN_SECRET,
  );
  if (pending.expiresAt < Date.now()) {
    throw new ApiError('verification_token_expired', 'Verification token has expired');
  }
  if (!isValidFormId(pending.routeId)) {
    throw new ApiError('verification_token_invalid', 'Verification token is invalid');
  }
  const stored = await getStoredRoute(env, pending.routeId);
  if (!stored) throw new ApiError('route_not_found', 'Form route not found');
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
    throw new ApiError('verification_mismatch', 'Verification does not match this route');
  }
  const activated = await activateStoredRoute(env, pending.routeId);
  if (!activated) throw new ApiError('route_not_found', 'Form route not found');
  const origin = new URL(request.url).origin;
  return json(
    routeResource({
      status: 'active',
      formId: activated.formId,
      alias: activated.alias,
      endpoint: submissionEndpoint(env, origin, activated.formId),
      statusUrl: routeStatusUrl(env, origin, activated.formId),
      createdAt: activated.createdAt,
      message: 'Your form endpoint is ready.',
    }),
  );
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
    throw new ApiError('route_not_found', 'Form route not found');
  }
  const found = await getStoredRoute(env, formId);
  if (!found) throw new ApiError('route_not_found', 'Form route not found');
  const record = await refreshVerifiedRoute(env, found);
  const origin = new URL(request.url).origin;
  return json(
    routeResource({
      status: record.status,
      formId: record.formId,
      alias: record.alias,
      endpoint: submissionEndpoint(env, origin, record.formId),
      statusUrl: routeStatusUrl(env, origin, record.formId),
      createdAt: record.createdAt,
      message:
        record.status === 'active'
          ? 'This form endpoint is active.'
          : 'This form endpoint is waiting for its inbox to be verified.',
    }),
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
  formId: string,
): Promise<Response> {
  const parsed = await parseSubmission(request, maxRequestSize(env));
  if (parsed.spam) return json({ success: true, message: 'Submission received' });
  if (Object.keys(parsed.fields).length === 0) {
    throw new ApiError('submission_empty', 'Form data is required');
  }

  if (!isValidFormId(formId)) {
    throw new ApiError('route_not_found', 'Form route not found');
  }
  const found = await getStoredRoute(env, formId);
  if (!found) throw new ApiError('route_not_found', 'Form route not found');
  const record = await refreshVerifiedRoute(env, found);
  if (record.status !== 'active') {
    const origin = new URL(request.url).origin;
    throw new ApiError('inbox_not_verified', 'This inbox has not been verified yet.', {
      next_action: nextActionFor('pending', routeStatusUrl(env, origin, formId)),
    });
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
    throw new ApiError(
      'monthly_allowance_exhausted',
      'This inbox has reached its shared monthly submission allowance.',
      {
        used: reservation.used,
        limit: reservation.limit,
        resets_at: quotaResetsAt(reservation.month),
      },
    );
  }

  try {
    await sendSubmissionEmail(env, route, parsed.fields, {
      format: parsed.format,
      replyTo: parsed.replyTo,
      subject: parsed.subject,
    });
  } catch (error) {
    if (reservation.limit > 0) {
      try {
        await rollbackQuota(env, route.ownerId, reservation.month);
      } catch {
        // The delivery failed, so the response remains an error even if rollback
        // also fails. No form fields are included in logs or error messages.
      }
    }
    if (error instanceof ConfigError) throw error;
    throw new ApiError('delivery_failed', 'Email delivery failed');
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

function methodNotAllowed(allow: string): Response {
  return errorResponse(new ApiError('method_not_allowed', 'Method not allowed'), {
    Allow: allow,
  });
}

function descriptor(env: Env, origin: string): Response {
  return json({
    name: 'conform-cf-worker',
    api_version: openapiSpec.info.version,
    version: env.SOURCE_COMMIT || 'development',
    source: env.SOURCE_URL || 'https://github.com/centrst/conform-cf-worker',
    openapi_url: `${publicUrl(env, origin)}/openapi.json`,
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

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Idempotency-Key, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    if (request.method !== 'GET') return methodNotAllowed('GET, OPTIONS');
    return descriptor(env, url.origin);
  }

  if (url.pathname === '/openapi.json') {
    if (request.method !== 'GET') return methodNotAllowed('GET, OPTIONS');
    return json(openapiSpec, 200, { 'Cache-Control': 'public, max-age=300' });
  }

  if (url.pathname === '/v1/routes') {
    if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
    return createRoute(request, env);
  }

  if (url.pathname === '/v1/routes/verify') {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return methodNotAllowed('GET, POST, OPTIONS');
    }
    if (deliveryMode(env) !== 'arbitrary') {
      throw new ApiError('verification_unavailable', 'Cloudflare verifies this inbox directly');
    }
    return verifyArbitraryRoute(request, env);
  }

  if (url.pathname.startsWith('/v1/routes/')) {
    const formId = decodeURIComponent(url.pathname.slice('/v1/routes/'.length));
    if (request.method !== 'GET') return methodNotAllowed('GET, OPTIONS');
    return routeStatus(request, env, formId);
  }

  if (url.pathname.startsWith('/f/')) {
    const formId = decodeURIComponent(url.pathname.slice('/f/'.length));
    if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
    return submit(request, env, ctx, formId);
  }

  throw new ApiError('not_found', 'Not found');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error);
      if (error instanceof TokenError) {
        return errorResponse(new ApiError('verification_token_invalid', 'Invalid route'));
      }
      if (error instanceof ConfigError) {
        return errorResponse(new ApiError('config_incomplete', 'Worker configuration is incomplete'));
      }
      return errorResponse(new ApiError('internal_error', 'Request could not be processed'));
    }
  },
} satisfies ExportedHandler<Env>;
