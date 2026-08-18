import { vi } from 'vitest';
import { sealToken } from './crypto';
import type { FormSchema } from './schema';
import { ROUTE_PAYLOAD_VERSION } from './types';
import type {
  EmailMessageBuilder,
  Env,
  QuotaReservation,
  RouteAccessKey,
  RouteTokenPayload,
  StoredRouteRecord,
} from './types';

export const TEST_FORM_ID = 'cfm_ABCDEFGHJKLMNPQR';

/** Must match MAX_LIVE_KEYS in routes.ts. Pinned by key-lifecycle.workers.test.ts. */
const MAX_LIVE_KEYS = 5;

export function secret(fill: number): string {
  const bytes = new Uint8Array(32);
  bytes.fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function executionContext() {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        promises.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  };
}

export function quotaNamespace(
  reservation: QuotaReservation,
  requests: string[],
  names?: string[],
  plan: { plan: string; monthly_limit: number | null } = {
    plan: 'free',
    monthly_limit: null,
  },
): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      names?.push(name);
      return {} as DurableObjectId;
    },
    get() {
      return {
        async fetch(input: RequestInfo | URL) {
          const url = typeof input === 'string' ? input : input.toString();
          requests.push(url);
          if (url.endsWith('/rollback')) return Response.json({ rolledBack: true });
          if (url.endsWith('/plan')) return Response.json(plan);
          if (url.endsWith('/peek')) {
            return Response.json({
              used: reservation.used,
              limit: reservation.limit,
              month: reservation.month,
              day: reservation.day ?? '2026-08-18',
              day_used: 0,
            });
          }
          return Response.json(reservation);
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

export function routeNamespace(
  records: Map<string, StoredRouteRecord>,
  ownerRoutes: Map<string, Map<string, string>> = new Map(),
): DurableObjectNamespace {
  const objectNames = new WeakMap<object, string>();
  return {
    idFromName(name: string) {
      const id = {} as DurableObjectId;
      objectNames.set(id as object, name);
      return id;
    },
    get(id: DurableObjectId) {
      const objectName = objectNames.get(id as object);
      if (!objectName) throw new Error('Unknown fake Durable Object ID');
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const url = new URL(typeof input === 'string' ? input : input.toString());
          if (objectName.startsWith('owner:')) {
            const ownerId = objectName.slice('owner:'.length);
            const indexed = ownerRoutes.get(ownerId) ?? new Map<string, string>();
            ownerRoutes.set(ownerId, indexed);
            if (url.pathname === '/owner-routes' && (!init?.method || init.method === 'GET')) {
              return Response.json({
                routes: [...indexed]
                  .map(([formId, createdAt]) => ({ formId, createdAt }))
                  .sort((first, second) => second.createdAt.localeCompare(first.createdAt)),
              });
            }
            if (url.pathname === '/owner-routes/add' && init?.method === 'POST') {
              const route = JSON.parse(String(init.body)) as {
                formId: string;
                createdAt: string;
              };
              indexed.set(route.formId, route.createdAt);
              return Response.json({ indexed: true });
            }
            if (url.pathname === '/owner-routes/remove' && init?.method === 'POST') {
              const route = JSON.parse(String(init.body)) as { formId: string };
              indexed.delete(route.formId);
              return Response.json({ removed: true });
            }
            return Response.json({ error: 'Not found' }, { status: 404 });
          }
          const formId = objectName;
          if (url.pathname === '/' && (!init?.method || init.method === 'GET')) {
            const record = records.get(formId);
            return record
              ? Response.json(record)
              : Response.json({ error: 'Route not found' }, { status: 404 });
          }
          if (url.pathname === '/create' && init?.method === 'POST') {
            if (records.has(formId)) {
              return Response.json({ error: 'Form ID already exists' }, { status: 409 });
            }
            const record = JSON.parse(String(init.body)) as StoredRouteRecord;
            records.set(formId, record);
            return Response.json(record, { status: 201 });
          }
          if (url.pathname === '/activate' && init?.method === 'POST') {
            const record = records.get(formId);
            if (!record) {
              return Response.json({ error: 'Route not found' }, { status: 404 });
            }
            const active = { ...record, status: 'active' as const };
            records.set(formId, active);
            return Response.json(active);
          }
          if (url.pathname === '/keys' && (!init?.method || init.method === 'GET')) {
            const record = records.get(formId);
            if (!record) return Response.json({ error: 'Route not found' }, { status: 404 });
            return Response.json({ keys: record.accessKeys ?? [] });
          }
          if (url.pathname === '/keys/mint' && init?.method === 'POST') {
            const record = records.get(formId);
            if (!record) return Response.json({ error: 'Route not found' }, { status: 404 });
            const existing = record.accessKeys ?? [];
            const nextSeq =
              existing.reduce((highest, key) => Math.max(highest, key.seq ?? 0), 0) + 1;
            const minted = {
              ...(JSON.parse(String(init.body)) as RouteAccessKey),
              seq: nextSeq,
            };
            // Ordered by the sequence FormRoute assigns, not the clock.
            const all = [minted, ...existing].sort(
              (first, second) => (second.seq ?? 0) - (first.seq ?? 0),
            );
            // Mirrors FormRoute: a bounded window of recent keys, plus the
            // newest key that has been accepted. See routes.ts for why the
            // object stops trying to guess which key a deploy shipped.
            const newestUsed = all.find((key) => key.usedAt);
            const window = all.slice(0, MAX_LIVE_KEYS);
            const keys = all.filter((key) => window.includes(key) || key === newestUsed);
            records.set(formId, { ...record, accessKeys: keys });
            return Response.json({ keys }, { status: 201 });
          }
          if (url.pathname === '/keys/accept' && init?.method === 'POST') {
            const record = records.get(formId);
            if (!record) return Response.json({ error: 'Route not found' }, { status: 404 });
            const { keyId } = JSON.parse(String(init.body)) as { keyId: string };
            const target = (record.accessKeys ?? []).find((key) => key.keyId === keyId);
            if (!target) return Response.json({ accepted: false }, { status: 404 });
            if (target.usedAt) return Response.json({ accepted: true, retired: 0 });
            const accepted = { ...target, usedAt: new Date().toISOString() };
            const keys = (record.accessKeys ?? [])
              .filter((key) => (key.seq ?? 0) >= (target.seq ?? 0))
              .map((key) => (key.keyId === keyId ? accepted : key));
            records.set(formId, { ...record, accessKeys: keys });
            return Response.json({ accepted: true, retired: 1 });
          }
          if (url.pathname === '/settings' && init?.method === 'POST') {
            const record = records.get(formId);
            if (!record) return Response.json({ error: 'Route not found' }, { status: 404 });
            const body = JSON.parse(String(init.body)) as {
              requireKey?: boolean;
              encryptedRoute?: string;
            };
            const updated = {
              ...record,
              ...(body.requireKey === undefined ? {} : { requireKey: body.requireKey }),
              ...(body.encryptedRoute ? { encryptedRoute: body.encryptedRoute } : {}),
            };
            records.set(formId, updated);
            return Response.json(updated);
          }
          if (url.pathname === '/delete' && init?.method === 'POST') {
            if (!records.has(formId)) {
              return Response.json({ error: 'Route not found' }, { status: 404 });
            }
            records.delete(formId);
            return Response.json({ deleted: true });
          }
          return Response.json({ error: 'Not found' }, { status: 404 });
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

export function baseEnv(options?: {
  reservation?: QuotaReservation;
  send?: (message: EmailMessageBuilder) => Promise<{ messageId: string }>;
  requests?: string[];
  routes?: Map<string, StoredRouteRecord>;
  ownerRoutes?: Map<string, Map<string, string>>;
  quotaNames?: string[];
  plan?: { plan: string; monthly_limit: number | null };
}): Env {
  const requests = options?.requests ?? [];
  const routes = options?.routes ?? new Map<string, StoredRouteRecord>();
  return {
    EMAIL: {
      send:
        options?.send ??
        (async () => {
          return { messageId: 'message-id' };
        }),
    },
    QUOTAS: quotaNamespace(
      options?.reservation ?? {
        allowed: true,
        used: 1,
        limit: 250,
        month: '2026-07',
      },
      requests,
      options?.quotaNames,
      options?.plan,
    ),
    ROUTES: routeNamespace(routes, options?.ownerRoutes),
    DELIVERY_MODE: 'verified',
    MONTHLY_LIMIT: '250',
    FROM_EMAIL: 'forms@conform.test',
    FROM_NAME: 'conForm',
    PUBLIC_URL: 'https://api.conform.test',
    SOURCE_COMMIT: 'abc123',
    ROUTE_TOKEN_SECRET: secret(1),
    OWNER_HASH_SECRET: secret(2),
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_API_TOKEN: 'api-token',
  };
}

export async function installRoute(
  env: Env,
  records: Map<string, StoredRouteRecord>,
  options?: {
    formId?: string;
    alias?: string;
    ownerId?: string;
    email?: string;
    status?: StoredRouteRecord['status'];
    destinationId?: string;
    quotaKey?: string;
    requestHash?: string;
    delivery?: RouteTokenPayload['delivery'];
    accessKeys?: RouteAccessKey[];
    requireKey?: boolean;
    schema?: FormSchema;
  },
): Promise<string> {
  const formId = options?.formId ?? TEST_FORM_ID;
  const route: RouteTokenPayload = {
    kind: 'route',
    version: ROUTE_PAYLOAD_VERSION,
    ownerId: options?.ownerId ?? 'opaque-owner',
    routeId: formId,
    email: options?.email ?? 'owner@example.com',
    formName: options?.alias ?? 'Contact',
    issuedAt: Date.now(),
    ...(options?.delivery ? { delivery: options.delivery } : {}),
    ...(options?.schema ? { schema: options.schema } : {}),
  };
  records.set(formId, {
    formId,
    alias: route.formName,
    ownerId: route.ownerId,
    encryptedRoute: await sealToken(route, env.ROUTE_TOKEN_SECRET),
    status: options?.status ?? 'active',
    destinationId: options?.destinationId,
    createdAt: new Date().toISOString(),
    quotaKey: options?.quotaKey,
    requestHash: options?.requestHash,
    ...(options?.accessKeys ? { accessKeys: options.accessKeys } : {}),
    ...(options?.requireKey ? { requireKey: true } : {}),
  });
  return formId;
}

export function verifiedDestinationFetch() {
  return vi.fn(async () =>
    Response.json({
      success: true,
      result: [
        {
          id: 'destination-id',
          email: 'owner@example.com',
          verified: '2026-07-23T00:00:00Z',
        },
      ],
      result_info: { total_pages: 1 },
    }),
  );
}
