import { routeStatusUrl, submissionEndpoint } from './email';
import { ApiError, json } from './errors';
import { getInboxInsight, setInboxPlan } from './quota';
import { isValidEmail, normalizeEmail, ownerIdForEmail, quotaKeyForEmail } from './crypto';
import {
  getStoredRoute,
  listStoredRouteIds,
  unindexStoredRoute,
} from './routes';
import type { Env, StoredRouteRecord } from './types';
import { refreshVerifiedRoute } from './verification';

const MAX_ACCOUNT_EMAILS = 10;
const encoder = new TextEncoder();

async function secretMatches(provided: string, expected: string): Promise<boolean> {
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < providedBytes.length; index += 1) {
    difference |= providedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

async function authorizeAccountLookup(request: Request, env: Env): Promise<void> {
  if (!env.ACCOUNT_LOOKUP_SECRET) {
    throw new ApiError(
      'account_lookup_unavailable',
      'Account route lookup is not configured for this deployment',
    );
  }
  const authorization = request.headers.get('Authorization');
  const provided = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
  if (!provided || !(await secretMatches(provided, env.ACCOUNT_LOOKUP_SECRET))) {
    throw new ApiError('account_lookup_unauthorized', 'Account route lookup is not authorized');
  }
}

async function parseVerifiedEmails(request: Request): Promise<string[]> {
  let body: { emails?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw new ApiError('invalid_json', 'A JSON body is required');
  }
  if (
    !Array.isArray(body.emails) ||
    body.emails.length === 0 ||
    body.emails.length > MAX_ACCOUNT_EMAILS
  ) {
    throw new ApiError(
      'invalid_email',
      `Between 1 and ${MAX_ACCOUNT_EMAILS} verified email addresses are required`,
    );
  }
  const emails = [...new Set(body.emails.map((email) =>
    typeof email === 'string' ? normalizeEmail(email) : '',
  ))];
  if (emails.some((email) => !isValidEmail(email))) {
    throw new ApiError('invalid_email', 'Every account email must be valid');
  }
  return emails;
}

function accountRouteResource(
  env: Env,
  origin: string,
  record: StoredRouteRecord,
): Record<string, unknown> {
  return {
    form_id: record.formId,
    alias: record.alias,
    status: record.status === 'active' ? 'active' : 'pending_verification',
    endpoint: submissionEndpoint(env, origin, record.formId),
    status_url: routeStatusUrl(env, origin, record.formId),
    created_at: record.createdAt,
  };
}

export async function listAccountRoutes(request: Request, env: Env): Promise<Response> {
  await authorizeAccountLookup(request, env);
  const emails = await parseVerifiedEmails(request);
  const ownerIds = await Promise.all(
    emails.map((email) => ownerIdForEmail(email, env.OWNER_HASH_SECRET)),
  );
  const ownerIdSet = new Set(ownerIds);
  const indexed = await Promise.all(
    ownerIds.map(async (ownerId) => ({
      ownerId,
      routes: await listStoredRouteIds(env, ownerId),
    })),
  );

  const candidates = new Map<string, string>();
  for (const owner of indexed) {
    for (const route of owner.routes) candidates.set(route.formId, owner.ownerId);
  }

  const resolved = await Promise.all(
    [...candidates].map(async ([formId, indexedOwnerId]) => {
      const record = await getStoredRoute(env, formId);
      if (!record || record.ownerId !== indexedOwnerId || !ownerIdSet.has(record.ownerId)) {
        await unindexStoredRoute(env, indexedOwnerId, formId);
        return null;
      }
      return refreshVerifiedRoute(env, record);
    }),
  );
  const routes = resolved
    .filter((record): record is StoredRouteRecord => record !== null)
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt))
    .map((record) => accountRouteResource(env, new URL(request.url).origin, record));

  return json({ success: true, routes });
}

interface PlanGrant {
  email: string;
  plan: string;
  monthly_limit: number | null;
}

/**
 * Applies a plan to the inboxes an authenticated broker has verified.
 *
 * The broker (the account dashboard) is the only component that knows who paid
 * — it owns identity and billing. It sends verified addresses; the Worker
 * derives the same opaque quota keys it already uses and writes the grant into
 * the quota object. No email is stored, and the delivery path performs no
 * lookup: it reads the limit from the object it was already talking to.
 *
 * `monthly_limit` takes three kinds of value, and two of them look alike to a
 * caller while meaning opposite things:
 *
 *   null  — no ceiling is granted, so the deployment default applies. This is
 *           how a lapsed subscription is expressed: forms keep delivering on
 *           the free allowance rather than breaking.
 *   0     — no ceiling at all, the same convention as MONTHLY_LIMIT="0" on a
 *           deployment. This is what an unlimited tier needs.
 *   n     — exactly n submissions a month.
 *
 * Only null was ever documented, which left the tier sold as having no monthly
 * ceiling with no documented way to be granted one — and the natural guess,
 * null, handed it the free allowance instead. Absent and zero must never
 * collapse into each other; plan-grant.workers.test.ts pins all three.
 *
 * There is deliberately no value meaning "block this inbox". Suspension is not
 * a feature here, and 0 is taken.
 */
export async function setAccountPlans(request: Request, env: Env): Promise<Response> {
  await authorizeAccountLookup(request, env);

  let body: { grants?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw new ApiError('invalid_json', 'A JSON body is required');
  }
  if (!Array.isArray(body.grants) || body.grants.length === 0) {
    throw new ApiError('invalid_json', 'grants must be a non-empty array');
  }
  if (body.grants.length > MAX_ACCOUNT_EMAILS) {
    throw new ApiError('invalid_json', `At most ${MAX_ACCOUNT_EMAILS} grants per request`);
  }

  const grants: PlanGrant[] = body.grants.map((entry) => {
    const grant = entry as Partial<PlanGrant>;
    if (typeof grant.email !== 'string' || !isValidEmail(normalizeEmail(grant.email))) {
      throw new ApiError('invalid_email', 'Each grant needs a valid email');
    }
    if (typeof grant.plan !== 'string' || !grant.plan.trim()) {
      throw new ApiError('invalid_json', 'Each grant needs a plan name');
    }
    const limit = grant.monthly_limit;
    if (limit !== null && limit !== undefined && !Number.isFinite(limit)) {
      throw new ApiError('invalid_json', 'monthly_limit must be a number or null');
    }
    return {
      email: normalizeEmail(grant.email),
      plan: grant.plan.trim(),
      monthly_limit: limit === undefined || limit === null ? null : Number(limit),
    };
  });

  const applied = await Promise.all(
    grants.map(async (grant) => {
      const quotaKey = await quotaKeyForEmail(
        grant.email,
        env.OWNER_HASH_SECRET,
        env.QUOTA_IDENTITY_EXCEPTIONS,
      );
      const result = await setInboxPlan(env, quotaKey, grant.plan, grant.monthly_limit);
      return { plan: result.plan, monthly_limit: result.monthly_limit };
    }),
  );

  return json({ success: true, applied: applied.length, plans: applied });
}

/**
 * Delivery counters for the inboxes an authenticated broker has verified.
 *
 * Counts only: delivered, failed, and blocked per inbox-month, alongside the
 * limit that applied. There are no per-submission rows, no timestamps, and no
 * field contents anywhere in the path, so this cannot reconstruct a submission
 * — which is exactly what the trust page says about quota storage, and what
 * this endpoint must not quietly change.
 */
export async function accountInsight(request: Request, env: Env): Promise<Response> {
  await authorizeAccountLookup(request, env);
  const emails = await parseVerifiedEmails(request);

  const inboxes = await Promise.all(
    emails.map(async (email) => {
      const quotaKey = await quotaKeyForEmail(
        email,
        env.OWNER_HASH_SECRET,
        env.QUOTA_IDENTITY_EXCEPTIONS,
      );
      const insight = await getInboxInsight(env, quotaKey);
      return { plan: insight.plan, months: insight.months };
    }),
  );

  return json({ success: true, inboxes });
}
