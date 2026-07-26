import { routeStatusUrl, submissionEndpoint } from './email';
import { ApiError, json } from './errors';
import { isValidEmail, normalizeEmail, ownerIdForEmail } from './crypto';
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
