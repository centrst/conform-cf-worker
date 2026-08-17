import { handleMcp } from '../mcp/src/index';
import openapiSpec from '../openapi.json';
import { listAccountRoutes } from './account';
import {
  DestinationCapacityError,
  ensureDestinationAddress,
} from './cloudflare-destinations';
import { deliveryMode, maxRequestSize, monthlyLimit } from './config';
import { nextActionFor, quotaResetsAt, routeResource } from './contract';
import { discoveryDocument, llmsText } from './discovery';
import { genericInstall, routeInstall } from './install';
import {
  deriveRouteId,
  isValidEmail,
  isValidFormId,
  normalizeEmail,
  openToken,
  ownerIdForEmail,
  quotaKeyForEmail,
  randomRouteId,
  requestFingerprint,
  sealToken,
} from './crypto';
import {
  routeStatusUrl,
  sendArbitraryVerification,
  sendQuotaWarning,
  sendSubmissionEmail,
  submissionEndpoint,
} from './email';
import {
  ApiError,
  ConfigError,
  ERROR_TABLE,
  TokenError,
  errorResponse,
  json,
} from './errors';
import { isPlaceholderFormId } from './placeholders';
import { InboxQuota, reserveQuota, rollbackQuota } from './quota';
import {
  activateStoredRoute,
  createStoredRoute,
  deleteStoredRoute,
  FormRoute,
  getStoredRoute,
  indexStoredRoute,
  unindexStoredRoute,
} from './routes';
import { parseSubmission } from './submission';
import {
  deliverWebhook,
  generateWebhookSecret,
  submissionEvent,
  validateWebhookUrl,
} from './webhook';
import { refreshVerifiedRoute } from './verification';
import type {
  Env,
  ManageTokenPayload,
  PendingRoutePayload,
  RouteDeliveryConfig,
  RouteDeliveryMode,
  RouteTokenPayload,
  StoredRouteRecord,
} from './types';

export { FormRoute, InboxQuota };
export { openToken, ownerIdForEmail, sealToken } from './crypto';

const ROUTE_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MAX_FORM_NAME_LENGTH = 120;
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,200}$/u;

function routePayload(
  email: string,
  formName: string,
  ownerId: string,
  routeId = randomRouteId(),
  delivery?: RouteDeliveryConfig,
): RouteTokenPayload {
  return {
    kind: 'route',
    version: delivery ? 2 : 1,
    email,
    formName,
    ownerId,
    routeId,
    issuedAt: Date.now(),
    ...(delivery ? { delivery } : {}),
  };
}

interface ParsedRouteRequest {
  email: string;
  alias: string;
  delivery?: { mode: RouteDeliveryMode; webhookUrl?: string };
}

async function parseRouteRequest(request: Request): Promise<ParsedRouteRequest> {
  let body: {
    email?: unknown;
    alias?: unknown;
    formName?: unknown;
    form_name?: unknown;
    delivery?: unknown;
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

  let delivery: ParsedRouteRequest['delivery'];
  if (body.delivery !== undefined) {
    if (!body.delivery || typeof body.delivery !== 'object' || Array.isArray(body.delivery)) {
      throw new ApiError(
        'delivery_config_unsupported',
        'delivery must be an object with a mode of "email", "webhook", or "both"',
      );
    }
    const raw = body.delivery as { mode?: unknown; webhook?: unknown };
    const mode = raw.mode === undefined ? 'email' : raw.mode;
    if (mode !== 'email' && mode !== 'webhook' && mode !== 'both') {
      throw new ApiError(
        'delivery_config_unsupported',
        'Delivery mode must be "email", "webhook", or "both"',
      );
    }
    let webhookUrl: string | undefined;
    if (mode !== 'email') {
      const webhook = raw.webhook as { url?: unknown } | undefined;
      if (!webhook || typeof webhook.url !== 'string') {
        throw new ApiError(
          'invalid_webhook_url',
          'delivery.webhook.url is required for webhook delivery',
        );
      }
      webhookUrl = validateWebhookUrl(webhook.url);
    }
    delivery = { mode, ...(webhookUrl ? { webhookUrl } : {}) };
  }

  return { email: normalizeEmail(body.email), alias: rawFormName.trim(), delivery };
}

interface StoreNewRouteParams {
  email: string;
  alias: string;
  ownerId: string;
  status: StoredRouteRecord['status'];
  destinationId?: string;
  formId?: string;
  requestHash?: string;
  quotaKey?: string;
  delivery?: RouteDeliveryConfig;
}

/**
 * Stores a fresh route. Returns null only when a fixed (idempotency-derived)
 * form ID already exists — the caller then replays the existing route.
 */
async function storeNewRoute(
  env: Env,
  params: StoreNewRouteParams,
): Promise<StoredRouteRecord | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const formId = params.formId ?? randomRouteId();
    const route = routePayload(
      params.email,
      params.alias,
      params.ownerId,
      formId,
      params.delivery,
    );
    const record: StoredRouteRecord = {
      formId,
      alias: params.alias,
      ownerId: params.ownerId,
      encryptedRoute: await sealToken(route, env.ROUTE_TOKEN_SECRET),
      status: params.status,
      destinationId: params.destinationId,
      createdAt: new Date().toISOString(),
      requestHash: params.requestHash,
      quotaKey: params.quotaKey,
    };
    if (await createStoredRoute(env, record)) {
      await indexStoredRoute(env, record.ownerId, record.formId, record.createdAt);
      return record;
    }
    if (params.formId) return null;
  }
  throw new Error('Could not allocate a unique form ID');
}

async function mintManagementToken(
  env: Env,
  formId: string,
  ownerId: string,
): Promise<string> {
  const payload: ManageTokenPayload = {
    kind: 'manage',
    version: 1,
    routeId: formId,
    ownerId,
    issuedAt: Date.now(),
  };
  return sealToken(payload, env.ROUTE_TOKEN_SECRET);
}

function pendingMessage(env: Env): string {
  return deliveryMode(env) === 'verified'
    ? 'Check your inbox for Cloudflare’s verification email. Your endpoint will begin delivering after you confirm it.'
    : 'Check your inbox to confirm this form.';
}

async function replayRoute(
  request: Request,
  env: Env,
  existing: StoredRouteRecord,
  requestHash: string,
): Promise<Response> {
  if (existing.requestHash !== requestHash) {
    throw new ApiError(
      'idempotency_key_conflict',
      'This Idempotency-Key was already used with a different request body.',
    );
  }
  const record = await refreshVerifiedRoute(env, existing);
  await indexStoredRoute(env, record.ownerId, record.formId, record.createdAt);
  const payload = await openToken<RouteTokenPayload>(
    record.encryptedRoute,
    'route',
    env.ROUTE_TOKEN_SECRET,
  );
  const origin = new URL(request.url).origin;
  return json(
    {
      ...routeResource({
        status: record.status,
        formId: record.formId,
        alias: record.alias,
        endpoint: submissionEndpoint(env, origin, record.formId),
        statusUrl: routeStatusUrl(env, origin, record.formId),
        createdAt: record.createdAt,
        message:
          record.status === 'active' ? 'Your form endpoint is ready.' : pendingMessage(env),
      }),
      replayed: true,
      management_token: await mintManagementToken(env, record.formId, record.ownerId),
      ...(payload.delivery?.webhook
        ? { webhook: { secret: payload.delivery.webhook.secret } }
        : {}),
    },
    200,
  );
}

async function createRoute(request: Request, env: Env): Promise<Response> {
  const { email, alias, delivery: requestedDelivery } = await parseRouteRequest(request);
  const deliveryConfig: RouteDeliveryConfig | undefined =
    requestedDelivery && requestedDelivery.mode !== 'email'
      ? {
          mode: requestedDelivery.mode,
          webhook: {
            url: requestedDelivery.webhookUrl as string,
            secret: generateWebhookSecret(),
          },
        }
      : undefined;

  const idempotencyHeader = request.headers.get('Idempotency-Key');
  if (idempotencyHeader !== null && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyHeader)) {
    throw new ApiError(
      'invalid_idempotency_key',
      'Idempotency-Key must be 1-200 printable ASCII characters',
    );
  }
  const idempotencyKey = idempotencyHeader ?? undefined;

  const ownerId = await ownerIdForEmail(email, env.OWNER_HASH_SECRET);
  const quotaKey = await quotaKeyForEmail(
    email,
    env.OWNER_HASH_SECRET,
    env.QUOTA_IDENTITY_EXCEPTIONS,
  );
  if (env.REGISTRATION_RATE_LIMITER) {
    const clientAddress = request.headers.get('cf-connecting-ip') || 'unknown';
    const clientId = await ownerIdForEmail(
      `registration-client:${clientAddress}`,
      env.OWNER_HASH_SECRET,
    );
    const [clientLimit, inboxLimit] = await Promise.all([
      env.REGISTRATION_RATE_LIMITER.limit({ key: `client:${clientId}` }),
      env.REGISTRATION_RATE_LIMITER.limit({ key: `inbox:${quotaKey}` }),
    ]);
    if (!clientLimit.success || !inboxLimit.success) {
      throw new ApiError('rate_limited', 'Too many form registrations. Try again in a minute.', {
        retry_after_seconds: 60,
      });
    }
  }

  const requestHash = idempotencyKey
    ? await requestFingerprint({
        email,
        alias,
        delivery: requestedDelivery
          ? { mode: requestedDelivery.mode, url: requestedDelivery.webhookUrl ?? null }
          : null,
      })
    : undefined;
  const derivedId = idempotencyKey
    ? await deriveRouteId(ownerId, idempotencyKey, env.OWNER_HASH_SECRET)
    : undefined;
  if (derivedId && requestHash) {
    const existing = await getStoredRoute(env, derivedId);
    if (existing) return replayRoute(request, env, existing, requestHash);
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
    const record = await storeNewRoute(env, {
      email,
      alias,
      ownerId,
      status,
      destinationId: destination.addressId,
      formId: derivedId,
      requestHash,
      quotaKey,
      delivery: deliveryConfig,
    });
    if (!record) {
      const existing = await getStoredRoute(env, derivedId as string);
      if (existing && requestHash) return replayRoute(request, env, existing, requestHash);
      throw new Error('Route creation failed');
    }
    return json(
      {
        ...routeResource({
          status,
          formId: record.formId,
          alias,
          endpoint: submissionEndpoint(env, origin, record.formId),
          statusUrl: routeStatusUrl(env, origin, record.formId),
          message:
            destination.status === 'verified' ? 'Your form endpoint is ready.' : pendingMessage(env),
        }),
        management_token: await mintManagementToken(env, record.formId, ownerId),
        ...(deliveryConfig?.webhook
          ? { webhook: { secret: deliveryConfig.webhook.secret } }
          : {}),
      },
      destination.status === 'verified' ? 201 : 202,
    );
  }

  const now = Date.now();
  const formId = derivedId ?? randomRouteId();
  const route = routePayload(email, alias, ownerId, formId, deliveryConfig);
  const pending: PendingRoutePayload = {
    ...route,
    kind: 'pending',
    issuedAt: now,
    expiresAt: now + ROUTE_TOKEN_TTL_SECONDS * 1000,
  };
  const pendingToken = await sealToken(pending, env.ROUTE_TOKEN_SECRET);
  await sendArbitraryVerification(env, pending, pendingToken, origin);
  const record = await storeNewRoute(env, {
    email,
    alias,
    ownerId,
    status: 'pending',
    formId,
    requestHash,
    quotaKey,
    delivery: deliveryConfig,
  });
  if (!record) {
    const existing = await getStoredRoute(env, formId);
    if (existing && requestHash) return replayRoute(request, env, existing, requestHash);
    throw new Error('Route creation failed');
  }
  return json(
    {
      ...routeResource({
        status: 'pending',
        formId,
        alias,
        endpoint: submissionEndpoint(env, origin, formId),
        statusUrl: routeStatusUrl(env, origin, formId),
        verificationExpiresAt: new Date(pending.expiresAt).toISOString(),
        message: 'Check your inbox to confirm this form.',
      }),
      management_token: await mintManagementToken(env, formId, ownerId),
      ...(deliveryConfig?.webhook
        ? { webhook: { secret: deliveryConfig.webhook.secret } }
        : {}),
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

const HTML_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

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
    { headers: HTML_PAGE_HEADERS },
  );
}

function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('text/html') && !accept.includes('application/json');
}

/**
 * Someone posted to a documentation sample. They are mid-evaluation with a form
 * already wired up, so answer in the browser they are standing in rather than
 * leaving them with a bare 404. Nothing they submitted is read, logged or kept.
 */
function placeholderGuidancePage(createUrl: string): Response {
  const href = escapeHtml(createUrl);
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>conForm — example endpoint</title>
<body>
  <main>
    <h1>That was the example endpoint</h1>
    <p>
      The form ID in that snippet is a sample from the documentation, so it is
      not connected to any inbox and your submission was not delivered or
      stored.
    </p>
    <p>Your form markup is already correct. It needs your own endpoint:</p>
    <ol>
      <li><a href="${href}">Create a form endpoint</a> with the inbox that should receive submissions.</li>
      <li>Confirm the verification email so delivery can begin.</li>
      <li>Swap the sample ID in your <code>action</code> for the one you were given.</li>
    </ol>
    <p>No account is required and nothing is retained after delivery.</p>
  </main>
</body>
</html>`,
    { status: ERROR_TABLE.placeholder_endpoint.status, headers: HTML_PAGE_HEADERS },
  );
}

/**
 * Where someone is sent to create their own endpoint. Derived from DOCS_URL,
 * which points at the docs index one level below the product page. The trailing
 * slash is forced because `new URL('../x', '…/docs')` resolves a segment too far
 * up — silently producing the wrong host path for a self-hoster who omits it.
 */
function createFormUrl(env: Env): string {
  if (!env.DOCS_URL) return 'https://centrst.com/conform/#create-form';
  const docs = env.DOCS_URL.endsWith('/') ? env.DOCS_URL : `${env.DOCS_URL}/`;
  return new URL('../#create-form', docs).toString();
}

/**
 * A copied sample being tried is a funnel signal worth counting. Only the
 * placeholder ID — a value we publish ourselves — is recorded. Submitted
 * fields are never read here, so nothing about the sender is logged.
 */
function countPlaceholderAttempt(formId: string): void {
  console.log(
    JSON.stringify({ event: 'placeholder_endpoint_attempt', form_id: formId }),
  );
}

function submissionResultPage(ok: boolean, message: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>conForm</title>
<body>
  <main>
    <h1>${ok ? 'Submission sent' : 'Submission not sent'}</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="javascript:history.back()">Go back</a></p>
  </main>
</body>
</html>`,
    { status, headers: HTML_PAGE_HEADERS },
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
  await indexStoredRoute(env, record.ownerId, record.formId, record.createdAt);
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

async function managedRoute(
  request: Request,
  env: Env,
  formId: string,
): Promise<StoredRouteRecord> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new ApiError(
      'management_token_required',
      'Managing a route requires its management token as a Bearer Authorization header',
    );
  }
  let payload: ManageTokenPayload;
  try {
    payload = await openToken<ManageTokenPayload>(
      authorization.slice('Bearer '.length).trim(),
      'manage',
      env.ROUTE_TOKEN_SECRET,
    );
  } catch (error) {
    if (error instanceof TokenError) {
      throw new ApiError('management_token_invalid', 'The management token is not valid');
    }
    throw error;
  }
  if (!isValidFormId(formId)) {
    throw new ApiError('route_not_found', 'Form route not found');
  }
  const record = await getStoredRoute(env, formId);
  if (!record) throw new ApiError('route_not_found', 'Form route not found');
  if (payload.routeId !== formId || payload.ownerId !== record.ownerId) {
    throw new ApiError(
      'management_token_invalid',
      'The management token does not match this route',
    );
  }
  return record;
}

async function claimRoute(request: Request, env: Env, formId: string): Promise<Response> {
  const record = await managedRoute(request, env, formId);
  await indexStoredRoute(env, record.ownerId, record.formId, record.createdAt);
  return json({ success: true, status: 'indexed', form_id: formId });
}

async function deleteRoute(request: Request, env: Env, formId: string): Promise<Response> {
  const record = await managedRoute(request, env, formId);
  await deleteStoredRoute(env, formId);
  await unindexStoredRoute(env, record.ownerId, formId);
  return json({ success: true, status: 'deleted', form_id: formId });
}

/** Exported for tests: the warning marks are the only quota copy trigger. */
export function thresholdCrossed(used: number, limit: number): boolean {
  if (limit <= 0) return false;
  return used === Math.max(1, Math.ceil(limit * 0.8)) || used === limit;
}

function validatedRedirect(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError('invalid_redirect_url', 'Redirect must be an absolute https:// URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new ApiError('invalid_redirect_url', 'Redirect must be an absolute https:// URL');
  }
  return parsed.toString();
}

function submissionSuccess(
  request: Request,
  redirect: string | undefined,
  body: Record<string, unknown>,
): Response {
  if (redirect) {
    return new Response(null, {
      status: 303,
      headers: { Location: redirect, 'Cache-Control': 'no-store' },
    });
  }
  if (acceptsHtml(request)) {
    return submissionResultPage(true, String(body.message));
  }
  return json(body);
}

async function submit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  formId: string,
): Promise<Response> {
  const parsed = await parseSubmission(request, maxRequestSize(env));
  const redirect =
    parsed.redirect !== undefined ? validatedRedirect(parsed.redirect) : undefined;
  if (parsed.spam) {
    return submissionSuccess(request, redirect, {
      success: true,
      message: 'Submission received',
    });
  }
  if (Object.keys(parsed.fields).length === 0) {
    throw new ApiError('submission_empty', 'Form data is required');
  }

  if (!isValidFormId(formId)) {
    throw new ApiError('route_not_found', 'Form route not found');
  }
  const found = await getStoredRoute(env, formId);
  if (!found) throw new ApiError('route_not_found', 'Form route not found');
  const record = await refreshVerifiedRoute(env, found);
  await indexStoredRoute(env, record.ownerId, record.formId, record.createdAt);
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

  const quotaKey = record.quotaKey ?? record.ownerId;
  const reservation = await reserveQuota(env, quotaKey, monthlyLimit(env));
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

  const routeDelivery = route.delivery;
  const routeDeliveryMode: RouteDeliveryMode = routeDelivery?.mode ?? 'email';
  const event =
    routeDeliveryMode !== 'email' && routeDelivery?.webhook
      ? submissionEvent(route, parsed.fields, {
          test: parsed.test,
          replyTo: parsed.replyTo,
          subject: parsed.subject,
        })
      : undefined;

  async function rollback(): Promise<void> {
    if (reservation.limit > 0) {
      try {
        await rollbackQuota(env, quotaKey, reservation.month);
      } catch {
        // The delivery failed, so the response remains an error even if rollback
        // also fails. No form fields are included in logs or error messages.
      }
    }
  }

  let deliveryReport: Record<string, string>;
  if (routeDeliveryMode === 'webhook' && routeDelivery?.webhook && event) {
    // Synchronous, at-most-once delivery: on failure the reservation is rolled
    // back and nothing was delivered, so the request is safe to retry.
    // Receivers deduplicate on the webhook-id header.
    const result = await deliverWebhook(routeDelivery.webhook, event, {
      retryWaitsMs: [1000],
      timeoutMs: 10_000,
    });
    if (!result.ok) {
      await rollback();
      throw new ApiError('webhook_delivery_failed', 'Webhook delivery failed');
    }
    deliveryReport = { webhook: 'delivered' };
  } else {
    try {
      await sendSubmissionEmail(env, route, parsed.fields, {
        format: parsed.format,
        replyTo: parsed.replyTo,
        subject: parsed.subject,
        test: parsed.test,
        testNonce: parsed.testNonce,
      });
    } catch (error) {
      await rollback();
      if (error instanceof ConfigError) throw error;
      throw new ApiError('delivery_failed', 'Email delivery failed');
    }
    if (routeDeliveryMode === 'both' && routeDelivery?.webhook && event) {
      // Email is authoritative and already delivered; the webhook is
      // best-effort in the background — the human inbox is the durable record.
      ctx.waitUntil(
        deliverWebhook(routeDelivery.webhook, event, {
          retryWaitsMs: [1000, 4000],
          timeoutMs: 10_000,
        }).catch(() => undefined),
      );
      deliveryReport = { email: 'delivered', webhook: 'queued' };
    } else {
      deliveryReport = { email: 'delivered' };
    }
  }

  if (thresholdCrossed(reservation.used, reservation.limit)) {
    ctx.waitUntil(
      sendQuotaWarning(env, route, reservation.used, reservation.limit, reservation.month).catch(() => undefined),
    );
  }

  return submissionSuccess(request, redirect, {
    success: true,
    message: parsed.test ? 'Test submission delivered' : 'Submission delivered',
    ...(parsed.test ? { test: true, echo: parsed.testNonce ?? null } : {}),
    delivery: deliveryReport,
    used: reservation.limit > 0 ? reservation.used : undefined,
    limit: reservation.limit > 0 ? reservation.limit : undefined,
  });
}

function methodNotAllowed(allow: string): Response {
  return errorResponse(new ApiError('method_not_allowed', 'Method not allowed'), {
    Allow: allow,
  });
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  // The MCP server is served from this Worker rather than a second one. It has
  // to be dispatched before the CORS block below, because its preflight allows
  // Mcp-Session-Id and Mcp-Protocol-Version, which the engine's does not.
  //
  // Tool calls are given an in-process fetcher so they reach the engine
  // directly instead of making this Worker re-enter itself over the network.
  // It routes through respond(), not handle(), because the tools read
  // response.ok and need a real status rather than a thrown ApiError.
  if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
    const inProcess: typeof fetch = (input, init) =>
      respond(new Request(input, init), env, ctx);
    return handleMcp(request, env, inProcess);
  }

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

  if (
    url.pathname === '/' ||
    url.pathname === '/health' ||
    url.pathname === '/.well-known/conform.json'
  ) {
    if (request.method !== 'GET') return methodNotAllowed('GET, OPTIONS');
    return json(discoveryDocument(env, url.origin));
  }

  if (url.pathname === '/openapi.json') {
    if (request.method !== 'GET') return methodNotAllowed('GET, OPTIONS');
    return json(openapiSpec, 200, { 'Cache-Control': 'public, max-age=300' });
  }

  if (url.pathname === '/llms.txt') {
    if (request.method !== 'GET') return methodNotAllowed('GET, OPTIONS');
    return new Response(llmsText(env, url.origin), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  if (url.pathname === '/v1/install') {
    if (request.method !== 'GET') return methodNotAllowed('GET, OPTIONS');
    return genericInstall(request);
  }

  if (url.pathname === '/v1/routes') {
    if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
    return createRoute(request, env);
  }

  if (url.pathname === '/v1/account/routes') {
    if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
    return listAccountRoutes(request, env);
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
    const rest = decodeURIComponent(url.pathname.slice('/v1/routes/'.length));
    if (rest.endsWith('/claim')) {
      const formId = rest.slice(0, -'/claim'.length);
      if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
      return claimRoute(request, env, formId);
    }
    if (rest.endsWith('/install')) {
      const formId = rest.slice(0, -'/install'.length);
      if (request.method !== 'GET') return methodNotAllowed('GET, OPTIONS');
      return routeInstall(request, env, formId);
    }
    if (request.method === 'GET') return routeStatus(request, env, rest);
    if (request.method === 'DELETE') return deleteRoute(request, env, rest);
    return methodNotAllowed('GET, DELETE, OPTIONS');
  }

  if (url.pathname.startsWith('/f/')) {
    const formId = decodeURIComponent(url.pathname.slice('/f/'.length));
    if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
    if (isPlaceholderFormId(formId)) {
      countPlaceholderAttempt(formId);
      const createUrl = createFormUrl(env);
      if (acceptsHtml(request)) return placeholderGuidancePage(createUrl);
      throw new ApiError(
        'placeholder_endpoint',
        'This form ID is a documentation sample and is not connected to an inbox',
        {
          next_action: {
            type: 'create_route',
            message:
              'Create your own form endpoint, then replace the sample ID in the form action.',
            create_url: createUrl,
          },
        },
      );
    }
    try {
      return await submit(request, env, ctx, formId);
    } catch (error) {
      if (error instanceof ApiError && acceptsHtml(request)) {
        return submissionResultPage(false, error.message, ERROR_TABLE[error.code].status);
      }
      throw error;
    }
  }

  throw new ApiError('not_found', 'Not found');
}

/** Run a request and map every failure onto the error contract. Never throws. */
async function respond(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    // internal_error is deliberately opaque to the caller, so log the cause.
    // Without this a 500 says nothing anywhere and the reason has to be
    // deduced from the outside.
    console.error(
      'Unhandled request failure:',
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return errorResponse(new ApiError('internal_error', 'Request could not be processed'));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return respond(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
