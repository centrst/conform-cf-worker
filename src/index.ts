import { handleMcp } from '../mcp/src/index';
import { accountInsight, listAccountRoutes, setAccountPlans } from './account';
import {
  DestinationCapacityError,
  ensureDestinationAddress,
} from './cloudflare-destinations';
import {
  deliveryMode,
} from './config';
import { routeResource } from './contract';
import { deploymentSpec, discoveryDocument, llmsText } from './discovery';
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
import {
  listRouteKeys,
  mintRotationToken,
  mintRouteKey,
} from './access-keys';
import {
  acceptsHtml,
  createFormUrl,
  placeholderGuidancePage,
  submissionResultPage,
  verificationPage,
} from './pages';
import { isPlaceholderFormId } from './placeholders';
import {
  InboxQuota,
  getInboxPlan,
} from './quota';
import {
  activateStoredRoute,
  createStoredRoute,
  deleteStoredRoute,
  FormRoute,
  getStoredRoute,
  indexStoredRoute,
  unindexStoredRoute,
  updateStoredRouteSettings,
} from './routes';
import { parseFormSchema, type FormSchema, type SubmissionError } from './schema';
import { submit } from './submit';
import {
  generateWebhookSecret,
  validateWebhookUrl,
} from './webhook';
import { refreshVerifiedRoute } from './verification';
import { ROUTE_PAYLOAD_VERSION } from './types';
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
  schema?: FormSchema,
): RouteTokenPayload {
  return {
    kind: 'route',
    version: ROUTE_PAYLOAD_VERSION,
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

  // Create is configuration time too. Gating only the settings endpoint left
  // "declare it at creation" as a one-request workaround, which made the gate
  // decorative -- routes are free and replayable.
  if (schema) await requireSchemaEntitlement(env, quotaKey);
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
        // Included, or retrying a create with a corrected schema returns
        // `replayed: true` and keeps the old one -- the exact 200 an agent
        // iterating on a declaration would read as success. `delivery`
        // produces `idempotency_key_conflict` for the same divergence, and a
        // schema is no less part of the request.
        schema: schema ?? null,
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
async function requireSchemaEntitlement(env: Env, quotaKey: string): Promise<void> {
  if (env.PLAN_ENFORCEMENT !== 'true') return;
  const plan = await getInboxPlan(env, quotaKey);
  if (!plan.plan || plan.plan === 'free') {
    throw new ApiError(
      'schema_unavailable',
      'Declaring a form schema requires a paid plan on this inbox.',
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
  // Removing a schema is never gated. A customer whose plan lapsed would
  // otherwise be refused permission to stop using the feature they can no
  // longer pay for.
  if (body.schema !== undefined && body.schema !== null) {
    await requireSchemaEntitlement(env, record.quotaKey ?? record.ownerId);
  }
  if (body.schema !== undefined) {
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
      version: ROUTE_PAYLOAD_VERSION,
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
    // Rewritten per deployment, like the discovery document and llms.txt beside
    // it. Served verbatim, this told every agent reading a self-hoster's own
    // discovery chain that the API was "by Centrst" and lived at
    // api.conform.centrst.com -- so an agent following servers[0].url would
    // create the customer's form on somebody else's service.
    return json(deploymentSpec(env, url.origin), 200, {
      'Cache-Control': 'public, max-age=300',
    });
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
        const details = Array.isArray(error.extras?.errors)
          ? (error.extras.errors as SubmissionError[]).map((entry) =>
              String(entry?.message ?? ''),
            )
          : [];
        return submissionResultPage(
          'not-sent',
          error.message,
          ERROR_TABLE[error.code].status,
          details,
        );
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
