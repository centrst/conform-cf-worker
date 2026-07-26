import { vi } from 'vitest';
import { sealToken } from './crypto';
import type {
  EmailMessageBuilder,
  Env,
  QuotaReservation,
  RouteTokenPayload,
  StoredRouteRecord,
} from './types';

export const TEST_FORM_ID = 'cfm_ABCDEFGHJKLMNPQR';

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
          return Response.json(reservation);
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

export function routeNamespace(records: Map<string, StoredRouteRecord>): DurableObjectNamespace {
  const formIds = new WeakMap<object, string>();
  return {
    idFromName(formId: string) {
      const id = {} as DurableObjectId;
      formIds.set(id as object, formId);
      return id;
    },
    get(id: DurableObjectId) {
      const formId = formIds.get(id as object);
      if (!formId) throw new Error('Unknown fake Durable Object ID');
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const url = new URL(typeof input === 'string' ? input : input.toString());
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
  quotaNames?: string[];
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
    ),
    ROUTES: routeNamespace(routes),
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
  },
): Promise<string> {
  const formId = options?.formId ?? TEST_FORM_ID;
  const route: RouteTokenPayload = {
    kind: 'route',
    version: 1,
    ownerId: options?.ownerId ?? 'opaque-owner',
    routeId: formId,
    email: options?.email ?? 'owner@example.com',
    formName: options?.alias ?? 'Contact',
    issuedAt: Date.now(),
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
