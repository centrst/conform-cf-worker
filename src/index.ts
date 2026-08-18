import { handleMcp } from '../mcp/src/index';
import openapiSpec from '../openapi.json';
import { accountInsight, listAccountRoutes, setAccountPlans } from './account';
import {
  DestinationCapacityError,
  ensureDestinationAddress,
} from './cloudflare-destinations';
import {
  dailyLimit,
  deliveryMode,
  maxFieldLength,
  maxFields,
  maxRequestSize,
  monthlyLimit,
} from './config';
import { nextActionFor, quotaResetsAt, routeResource } from './contract';
import { discoveryDocument, llmsText } from './discovery';
import { genericInstall, routeInstall } from './install';
import {
  accessKeyHash,
  deriveRouteId,
  generateAccessKey,
  generateKeyId,
  isValidAccessKey,
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
  publicUrl,
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
import {
  InboxQuota,
  countThrottled,
  getInboxPlan,
  peekQuota,
  reserveQuota,
  rollbackQuota,
} from './quota';
import {
  acceptStoredAccessKey,
  activateStoredRoute,
  createStoredRoute,
  deleteStoredRoute,
  FormRoute,
  getStoredRoute,
  indexStoredRoute,
  mintStoredAccessKey,
  unindexStoredRoute,
  updateStoredRouteSettings,
} from './routes';
import { parseFormSchema, validateSubmission, type FormSchema } from './schema';
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
  RotateTokenPayload,
  RouteAccessKey,
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
  schema?: FormSchema,
): RouteTokenPayload {
  return {
    kind: 'route',
    version: schema ? 3 : delivery ? 2 : 1,
    email,
    formName,
    ownerId,
    routeId,
    issuedAt: Date.now(),
    ...(delivery ? { delivery } : {}),
    ...(schema ? { schema } : {}),
  };
}

interface ParsedRouteRequest {
  email: string;
  alias: string;
  delivery?: { mode: RouteDeliveryMode; webhookUrl?: string };
  schema?: FormSchema;
}

async function parseRouteRequest(request: Request): Promise<ParsedRouteRequest> {
  let body: {
    email?: unknown;
    alias?: unknown;
    formName?: unknown;
    form_name?: unknown;
    delivery?: unknown;
    schema?: unknown;
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

  const schema = body.schema === undefined ? undefined : parseFormSchema(body.schema);

  return {
    email: normalizeEmail(body.email),
    alias: rawFormName.trim(),
    delivery,
    ...(schema ? { schema } : {}),
  };
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
  schema?: FormSchema;
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
      params.schema,
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

async function mintRotationToken(
  env: Env,
  formId: string,
  ownerId: string,
): Promise<string> {
  const payload: RotateTokenPayload = {
    kind: 'rotate',
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
      rotation_token: await mintRotationToken(env, record.formId, record.ownerId),
      ...(payload.delivery?.webhook
        ? { webhook: { secret: payload.delivery.webhook.secret } }
        : {}),
    },
    200,
  );
}

async function createRoute(request: Request, env: Env): Promise<Response> {
  const {
    email,
    alias,
    delivery: requestedDelivery,
    schema,
  } = await parseRouteRequest(request);
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
      schema,
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
        rotation_token: await mintRotationToken(env, record.formId, ownerId),
        ...(deliveryConfig?.webhook
          ? { webhook: { secret: deliveryConfig.webhook.secret } }
          : {}),
      },
      destination.status === 'verified' ? 201 : 202,
    );
  }

  const now = Date.now();
  const formId = derivedId ?? randomRouteId();
  const route = routePayload(email, alias, ownerId, formId, deliveryConfig, schema);
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
    schema,
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
      rotation_token: await mintRotationToken(env, formId, ownerId),
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
 *
 * With no DOCS_URL the fallback is this deployment's own root, whose discovery
 * document names the create endpoint. It used to be a Centrst marketing page,
 * which meant a self-hosted install quietly sent its own users to the vendor.
 */
function createFormUrl(env: Env, origin: string): string {
  if (!env.DOCS_URL) return `${publicUrl(env, origin)}/`;
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

type SubmissionOutcome = 'sent' | 'not-sent' | 'dry-run';

const RESULT_HEADINGS: Record<SubmissionOutcome, string> = {
  sent: 'Submission sent',
  'not-sent': 'Submission not sent',
  // Never "sent". A dry run that renders a thank-you page is how a `_dry_run`
  // field shipped into a live form goes unnoticed for a month.
  'dry-run': 'Dry run — nothing was sent',
};

function submissionResultPage(
  outcome: SubmissionOutcome,
  message: string,
  status = 200,
): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>conForm</title>
<body>
  <main>
    <h1>${RESULT_HEADINGS[outcome]}</h1>
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
  // The declared shape is published, not guarded. It is derivable from the page
  // the form is installed on, and an agent that can read it can build a
  // submission that passes first time instead of guessing.
  const payload = await openToken<RouteTokenPayload>(
    record.encryptedRoute,
    'route',
    env.ROUTE_TOKEN_SECRET,
  );
  return json({
    ...routeResource({
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
    requires_access_key: Boolean(record.requireKey),
    ...(payload.schema ? { schema: payload.schema } : {}),
  });
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

/**
 * Authorises key rotation. Accepts a rotation token or the more powerful
 * management token, but a rotation token can do nothing else -- which is the
 * point of it existing, because this is the credential that lives in CI.
 */
async function rotatableRoute(
  request: Request,
  env: Env,
  formId: string,
): Promise<StoredRouteRecord> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new ApiError(
      'rotation_token_required',
      'Rotating access keys requires a rotation or management token as a Bearer Authorization header',
    );
  }
  const token = authorization.slice('Bearer '.length).trim();
  let payload: RotateTokenPayload | ManageTokenPayload;
  try {
    payload = await openToken<RotateTokenPayload>(token, 'rotate', env.ROUTE_TOKEN_SECRET);
  } catch (rotateError) {
    if (!(rotateError instanceof TokenError)) throw rotateError;
    try {
      payload = await openToken<ManageTokenPayload>(token, 'manage', env.ROUTE_TOKEN_SECRET);
    } catch (manageError) {
      if (manageError instanceof TokenError) {
        throw new ApiError('rotation_token_invalid', 'The rotation token is not valid');
      }
      throw manageError;
    }
  }
  if (!isValidFormId(formId)) {
    throw new ApiError('route_not_found', 'Form route not found');
  }
  const record = await getStoredRoute(env, formId);
  if (!record) throw new ApiError('route_not_found', 'Form route not found');
  if (payload.routeId !== formId || payload.ownerId !== record.ownerId) {
    throw new ApiError(
      'rotation_token_invalid',
      'The rotation token does not match this route',
    );
  }
  return record;
}

/** Keys are listed by label and state. The value itself is returned only at mint. */
function keyResource(key: RouteAccessKey, index: number) {
  return {
    key_id: key.keyId,
    state: index === 0 ? 'current' : 'previous',
    created_at: key.createdAt,
    ...(key.usedAt ? { first_used_at: key.usedAt } : {}),
  };
}

async function listRouteKeys(
  request: Request,
  env: Env,
  formId: string,
): Promise<Response> {
  const record = await rotatableRoute(request, env, formId);
  return json({
    success: true,
    form_id: formId,
    require_key: Boolean(record.requireKey),
    keys: (record.accessKeys ?? []).map(keyResource),
  });
}

async function mintRouteKey(request: Request, env: Env, formId: string): Promise<Response> {
  const record = await rotatableRoute(request, env, formId);

  if (env.ROTATION_RATE_LIMITER) {
    const allowed = await env.ROTATION_RATE_LIMITER.limit({ key: `rotate:${formId}` });
    if (!allowed.success) {
      throw new ApiError('rate_limited', 'Too many key rotations. Try again shortly.', {
        retry_after_seconds: 60,
      });
    }
  }

  const key = generateAccessKey();
  const minted: RouteAccessKey = {
    keyId: generateKeyId(),
    hash: await accessKeyHash(key, env.OWNER_HASH_SECRET),
    createdAt: new Date().toISOString(),
  };
  const keys = await mintStoredAccessKey(env, formId, minted);
  if (!keys) throw new ApiError('route_not_found', 'Form route not found');

  return json(
    {
      success: true,
      form_id: formId,
      key,
      key_id: minted.keyId,
      require_key: Boolean(record.requireKey),
      keys: keys.map(keyResource),
      message:
        'Send this value as the access_key field. It is returned once. The key it replaces ' +
        'stays valid until this one is first accepted, so a failed deploy costs nothing.',
    },
    201,
  );
}

/**
 * Schema validation is the paid feature on the hosted service, so entitlement
 * is checked here rather than on the delivery path: one plan read when a schema
 * is set, none per submission. A schema already attached keeps working if a
 * plan later lapses -- silently turning a form's own rules off would be a worse
 * failure than anything the rules prevent.
 *
 * Off unless an operator turns it on. This Worker is MIT and meant to be run by
 * other people: a deployment that gates by default would refuse the feature to
 * every self-hoster with no way to grant themselves the plan that unlocks it.
 * The gate is a billing control for whoever charges for this, not a lock on the
 * code.
 *
 * It is its own flag rather than a side effect of ACCOUNT_LOOKUP_SECRET, which
 * only says a dashboard exists. Someone can want route listings without selling
 * anything, and inferring "bills people" from "has a dashboard" would gate them
 * out of their own deployment. The default fails open, which costs an operator
 * who forgets to set it some revenue on their own service -- a mistake they can
 * see and fix, unlike a self-hoster hitting a wall they cannot.
 */
async function requireSchemaEntitlement(env: Env, record: StoredRouteRecord): Promise<void> {
  if (env.PLAN_ENFORCEMENT !== 'true') return;
  const plan = await getInboxPlan(env, record.quotaKey ?? record.ownerId);
  if (!plan.plan || plan.plan === 'free') {
    throw new ApiError(
      'schema_unavailable',
      'Declaring a form schema requires conForm+ on this inbox.',
    );
  }
}

async function updateRouteSettings(
  request: Request,
  env: Env,
  formId: string,
): Promise<Response> {
  const record = await managedRoute(request, env, formId);
  const body = (await request.json().catch(() => {
    throw new ApiError('invalid_json', 'Invalid JSON body');
  })) as { require_key?: unknown; schema?: unknown };

  if (body.require_key !== undefined && typeof body.require_key !== 'boolean') {
    throw new ApiError('invalid_json', 'require_key must be a boolean');
  }
  if (body.require_key === true && (record.accessKeys ?? []).length === 0) {
    throw new ApiError(
      'access_key_required',
      'Mint an access key before requiring one, or the form stops accepting submissions.',
    );
  }

  // `null` clears a schema; omitting the key leaves whatever is there.
  let encryptedRoute: string | undefined;
  let schema: FormSchema | undefined;
  if (body.schema !== undefined) {
    await requireSchemaEntitlement(env, record);
    schema = body.schema === null ? undefined : parseFormSchema(body.schema);
    const current = await openToken<RouteTokenPayload>(
      record.encryptedRoute,
      'route',
      env.ROUTE_TOKEN_SECRET,
    );
    // The schema lives inside the sealed payload, so changing it means
    // resealing rather than writing a column beside it.
    const next: RouteTokenPayload = {
      ...current,
      version: schema ? 3 : current.delivery ? 2 : 1,
      ...(schema ? { schema } : {}),
    };
    if (!schema) delete next.schema;
    encryptedRoute = await sealToken(next, env.ROUTE_TOKEN_SECRET);
  }

  const updated = await updateStoredRouteSettings(env, formId, {
    ...(body.require_key === undefined ? {} : { requireKey: body.require_key }),
    ...(encryptedRoute ? { encryptedRoute } : {}),
  });
  if (!updated) throw new ApiError('route_not_found', 'Form route not found');
  return json({
    success: true,
    form_id: formId,
    require_key: Boolean(updated.requireKey),
    ...(body.schema === undefined ? {} : { schema: schema ?? null }),
  });
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
    return submissionResultPage('sent', String(body.message));
  }
  return json(body);
}

/**
 * Matches the submitted `access_key` against the route's live keys.
 *
 * The key is not proof of origin -- it is inlined into a page a scraper
 * already reads. What it buys is rotation: the endpoint, the route and the
 * inbox all stay put while the value a harvested payload carries goes stale.
 *
 * Enforcement is a separate switch (`requireKey`). Until it is on, a wrong or
 * missing key still delivers, so a customer can mint keys, ship them, and only
 * then start refusing -- rather than breaking their own form at step one.
 */
async function checkAccessKey(
  env: Env,
  record: StoredRouteRecord,
  parsed: { allFields: Record<string, string | string[]> },
): Promise<RouteAccessKey | undefined> {
  const keys = record.accessKeys ?? [];
  if (keys.length === 0) return undefined;

  const raw = parsed.allFields.access_key;
  const presented = (Array.isArray(raw) ? raw[0] : raw)?.trim();

  if (!presented) {
    if (record.requireKey) {
      throw new ApiError(
        'access_key_required',
        'This form requires an access_key field.',
      );
    }
    return undefined;
  }

  const presentedHash = isValidAccessKey(presented)
    ? await accessKeyHash(presented, env.OWNER_HASH_SECRET)
    : undefined;
  const matched = presentedHash
    ? keys.find((key) => key.hash === presentedHash)
    : undefined;
  if (!matched && record.requireKey) {
    throw new ApiError('access_key_invalid', 'The access_key is not valid for this form.');
  }
  return matched;
}

/**
 * A dry run never redirects and never reports a plain success, however the
 * form was configured. A `_dry_run` field shipped into a live page by accident
 * would otherwise swallow every real submission behind a thank-you page.
 */
function dryRunSuccess(request: Request, extra: Record<string, unknown> = {}): Response {
  const message =
    'Dry run — nothing was delivered and no allowance was spent. ' +
    'Remove the _dry_run field to submit for real.';
  const body = {
    success: true,
    dry_run: true,
    delivered: false,
    ...extra,
    message,
  };
  if (acceptsHtml(request)) return submissionResultPage('dry-run', message);
  return json(body);
}

async function submit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  formId: string,
): Promise<Response> {
  const parsed = await parseSubmission(request, {
    maxBytes: maxRequestSize(env),
    maxFields: maxFields(env),
    maxFieldLength: maxFieldLength(env),
  });
  const redirect =
    parsed.redirect !== undefined ? validatedRedirect(parsed.redirect) : undefined;
  if (parsed.spam) {
    // A dry run answers identically whether or not the trap fired. The
    // honeypot's only property is that a caller cannot tell it caught them,
    // and a validate mode that reported it would hand that away for free.
    if (parsed.dryRun) return dryRunSuccess(request);
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

  // Sits after the honeypot (which costs nothing to reject) and before the
  // route lookup, so a burst is turned away without touching storage.
  //
  // This is the control that makes an unmetered allowance safe. A monthly
  // quota bounds the total but not the rate, so without this a scraped form
  // delivers its flood as fast as the attacker can send it -- into the
  // customer's own inbox. Two keys: the form, so one abused endpoint cannot
  // affect another, and the client, so a single source is capped regardless of
  // how many forms it found.
  if (env.SUBMISSION_RATE_LIMITER) {
    const clientAddress = request.headers.get('cf-connecting-ip') || 'unknown';
    const clientId = await ownerIdForEmail(
      `submission-client:${clientAddress}`,
      env.OWNER_HASH_SECRET,
    );
    // Two bindings, not one, because the ceilings differ: a form may legitimately
    // be busy, a single client never is. Sharing one binding is what made the
    // per-client limit silently equal to the per-form one.
    const clientLimiter = env.SUBMISSION_CLIENT_RATE_LIMITER ?? env.SUBMISSION_RATE_LIMITER;
    const [formLimit, clientLimit] = await Promise.all([
      env.SUBMISSION_RATE_LIMITER.limit({ key: `form:${formId}` }),
      clientLimiter.limit({ key: `client:${clientId}` }),
    ]);
    if (!formLimit.success || !clientLimit.success) {
      // Record that this inbox is being throttled, but at most once per form
      // per minute. An attack is unbounded, so counting every refused request
      // would turn the throttle into the storage amplification it exists to
      // prevent -- and the route lookup needed to find the inbox is itself the
      // work being avoided. The reporting limiter buys that lookup once a
      // minute, which is enough for the owner to see it happening.
      if (env.THROTTLE_REPORT_LIMITER) {
        const report = await env.THROTTLE_REPORT_LIMITER.limit({ key: `report:${formId}` });
        if (report.success) {
          ctx.waitUntil(
            (async () => {
              const throttledRoute = await getStoredRoute(env, formId);
              if (!throttledRoute) return;
              await countThrottled(env, throttledRoute.quotaKey ?? throttledRoute.ownerId);
            })().catch(() => undefined),
          );
        }
      }
      throw new ApiError('rate_limited', 'Too many submissions. Try again in a minute.', {
        retry_after_seconds: 60,
      });
    }
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
  const acceptedKey = await checkAccessKey(env, record, parsed);

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

  // Before the reservation, so a submission refused on its shape costs the
  // owner nothing. This is the only check that can reject on merits rather
  // than on fingerprints -- and it exists only because the form said what it
  // is. Errors are per-field and go to everyone: the schema is derivable from
  // the page an attacker already scraped, so withholding detail protects
  // nothing and leaves real integrators debugging blind.
  if (route.schema) {
    const errors = validateSubmission(route.schema, parsed.fields);
    if (errors.length > 0) {
      throw new ApiError('submission_invalid', 'This submission does not match the form.', {
        errors,
      });
    }
  }

  const quotaKey = record.quotaKey ?? record.ownerId;

  // Everything above this line is a check; everything below it spends
  // something. A dry run runs the checks and stops -- so it reports the exact
  // error a real submission would, and reports it having sent no mail, posted
  // no webhook, and consumed no allowance.
  //
  // The cost is honest: a dry run makes probing a form cheaper and quieter than
  // submitting for real. The rate limiter above bounds it to the same rate as
  // a real submission, which is the control that matters.
  if (parsed.dryRun) {
    const routeDelivery = route.delivery;
    const mode: RouteDeliveryMode = routeDelivery?.mode ?? 'email';
    const quota = await peekQuota(env, quotaKey, monthlyLimit(env));
    const withinMonth = quota.limit === 0 || quota.used < quota.limit;
    const withinDay = dailyLimit(env) === 0 || quota.day_used < dailyLimit(env);
    return dryRunSuccess(request, {
      would_deliver: withinMonth && withinDay,
      delivery:
        mode === 'email'
          ? { email: 'would send' }
          : mode === 'webhook'
            ? { webhook: 'would post' }
            : { email: 'would send', webhook: 'would post' },
      ...(quota.limit > 0
        ? {
            quota: {
              used: quota.used,
              limit: quota.limit,
              resets_at: quotaResetsAt(quota.month),
              day_used: quota.day_used,
              day_limit: dailyLimit(env),
            },
          }
        : {}),
    });
  }

  const reservation = await reserveQuota(
    env,
    quotaKey,
    monthlyLimit(env),
    dailyLimit(env),
  );
  if (!reservation.allowed && reservation.reason === 'daily') {
    throw new ApiError(
      'daily_allowance_exhausted',
      'This inbox has reached its daily submission ceiling.',
      {
        used: reservation.used,
        limit: reservation.limit,
        day: reservation.day,
      },
    );
  }
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

  // Retirement happens here, on a delivery that actually succeeded, and only
  // the first time. A key that has proved itself is what retires the keys it
  // superseded -- so a pipeline that mints a key and then fails to deploy
  // leaves the live site's key untouched, instead of quietly starting a clock
  // on it. Steady state costs nothing: `usedAt` is already set.
  if (acceptedKey && !acceptedKey.usedAt) {
    ctx.waitUntil(
      acceptStoredAccessKey(env, formId, acceptedKey.keyId).catch(() => undefined),
    );
  }

  // The quota Durable Object decides this, not the count. It claims each mark
  // once per month, so a rolled-back reservation reaching the same number again
  // — or two submissions landing together — cannot resend the same warning.
  if (reservation.warn) {
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

  if (url.pathname === '/v1/account/insight') {
    if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
    return accountInsight(request, env);
  }

  if (url.pathname === '/v1/account/plans') {
    if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
    return setAccountPlans(request, env);
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
    if (rest.endsWith('/keys')) {
      const formId = rest.slice(0, -'/keys'.length);
      if (request.method === 'GET') return listRouteKeys(request, env, formId);
      if (request.method === 'POST') return mintRouteKey(request, env, formId);
      return methodNotAllowed('GET, POST, OPTIONS');
    }
    if (rest.endsWith('/settings')) {
      const formId = rest.slice(0, -'/settings'.length);
      if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
      return updateRouteSettings(request, env, formId);
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
      const createUrl = createFormUrl(env, url.origin);
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
        return submissionResultPage('not-sent', error.message, ERROR_TABLE[error.code].status);
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
