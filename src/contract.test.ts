import { afterEach, describe, expect, it, vi } from 'vitest';
import spec from '../openapi.json';
import worker from './index';
import { sealToken } from './crypto';
import { ERROR_TABLE, type ErrorSpec } from './errors';
import {
  TEST_FORM_ID,
  baseEnv,
  executionContext,
  installRoute,
  verifiedDestinationFetch,
} from './test-support';
import type { Env, PendingRoutePayload, StoredRouteRecord } from './types';

const table: Record<string, ErrorSpec> = ERROR_TABLE;
const activeCodes = Object.keys(table)
  .filter((code) => !table[code].planned)
  .sort();

function fetchWorker(request: Request, env: Env): Promise<Response> {
  return worker.fetch(request, env, executionContext().ctx);
}

function post(path: string, body: string, contentType = 'application/json'): Request {
  return new Request(`https://api.conform.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
}

function arbitraryEnv(routes?: Map<string, StoredRouteRecord>): Env {
  return { ...baseEnv({ routes }), DELIVERY_MODE: 'arbitrary' };
}

async function expiredPendingToken(env: Env, formName = 'Contact'): Promise<string> {
  const pending: PendingRoutePayload = {
    kind: 'pending',
    version: 1,
    ownerId: 'opaque-owner',
    routeId: TEST_FORM_ID,
    email: 'owner@example.com',
    formName,
    issuedAt: Date.now() - 100_000,
    expiresAt: Date.now() - 1_000,
  };
  return sealToken(pending, env.ROUTE_TOKEN_SECRET);
}

async function mismatchedPendingToken(env: Env): Promise<string> {
  const pending: PendingRoutePayload = {
    kind: 'pending',
    version: 1,
    ownerId: 'opaque-owner',
    routeId: TEST_FORM_ID,
    email: 'owner@example.com',
    formName: 'Different alias',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 100_000,
  };
  return sealToken(pending, env.ROUTE_TOKEN_SECRET);
}

function unverifiedDestinationFetch() {
  return vi.fn(async () =>
    Response.json({
      success: true,
      result: { id: 'destination-id', email: 'owner@example.com', verified: null },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('error taxonomy sync', () => {
  it('mirrors ERROR_TABLE exactly in x-conform-error-codes', () => {
    const expected = Object.fromEntries(
      Object.entries(table).map(([code, entry]) => [
        code,
        {
          status: entry.status,
          retryable: entry.retryable,
          ...(entry.planned ? { planned: true } : {}),
        },
      ]),
    );
    expect(spec['x-conform-error-codes']).toEqual(expected);
  });

  it('lists exactly the active codes in the ErrorCode schema enum', () => {
    expect([...spec.components.schemas.ErrorCode.enum].sort()).toEqual(activeCodes);
  });

  it('documents exactly the dispatched paths', () => {
    expect(Object.keys(spec.paths).sort()).toEqual(
      [
        '/',
        '/health',
        '/openapi.json',
        '/v1/routes',
        '/v1/routes/verify',
        '/v1/routes/{formId}',
        '/f/{formId}',
      ].sort(),
    );
  });
});

describe('every active error code is emitted as its documented envelope', () => {
  const recipes: Array<{ code: string; run: () => Promise<Response> }> = [
    {
      code: 'invalid_json',
      run: () => fetchWorker(post('/v1/routes', 'not json'), baseEnv()),
    },
    {
      code: 'invalid_email',
      run: () =>
        fetchWorker(
          post('/v1/routes', JSON.stringify({ email: 'nope', alias: 'Contact' })),
          baseEnv(),
        ),
    },
    {
      code: 'invalid_alias',
      run: () =>
        fetchWorker(
          post('/v1/routes', JSON.stringify({ email: 'owner@example.com', alias: '' })),
          baseEnv(),
        ),
    },
    {
      code: 'invalid_idempotency_key',
      run: () => {
        const request = new Request('https://api.conform.test/v1/routes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'a'.repeat(201),
          },
          body: JSON.stringify({ email: 'owner@example.com', alias: 'Contact' }),
        });
        return fetchWorker(request, baseEnv());
      },
    },
    {
      code: 'idempotency_key_conflict',
      run: async () => {
        const routes = new Map<string, StoredRouteRecord>();
        const env = arbitraryEnv(routes);
        const create = (alias: string) =>
          fetchWorker(
            new Request('https://api.conform.test/v1/routes', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': 'agent-key-1',
              },
              body: JSON.stringify({ email: 'owner@example.com', alias }),
            }),
            env,
          );
        await create('Contact');
        return create('Different');
      },
    },
    {
      code: 'delivery_config_unsupported',
      run: () =>
        fetchWorker(
          post(
            '/v1/routes',
            JSON.stringify({ email: 'owner@example.com', alias: 'Contact', delivery: {} }),
          ),
          baseEnv(),
        ),
    },
    {
      code: 'invalid_redirect_url',
      run: () =>
        fetchWorker(
          post(
            `/f/${TEST_FORM_ID}`,
            JSON.stringify({ message: 'x', _redirect: 'javascript:alert(1)' }),
          ),
          baseEnv(),
        ),
    },
    {
      code: 'management_token_required',
      run: () =>
        fetchWorker(
          new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}`, {
            method: 'DELETE',
          }),
          baseEnv(),
        ),
    },
    {
      code: 'management_token_invalid',
      run: () =>
        fetchWorker(
          new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}`, {
            method: 'DELETE',
            headers: { Authorization: 'Bearer garbage' },
          }),
          baseEnv(),
        ),
    },
    {
      code: 'rate_limited',
      run: () => {
        const env: Env = {
          ...baseEnv(),
          REGISTRATION_RATE_LIMITER: { limit: async () => ({ success: false }) },
        };
        return fetchWorker(
          post('/v1/routes', JSON.stringify({ email: 'owner@example.com', alias: 'Contact' })),
          env,
        );
      },
    },
    {
      code: 'verified_destination_capacity',
      run: () => {
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockResolvedValueOnce(
              Response.json({ success: true, result: [], result_info: { total_pages: 1 } }),
            )
            .mockResolvedValueOnce(
              Response.json(
                {
                  success: false,
                  errors: [{ message: 'maximum number of destination addresses reached' }],
                },
                { status: 403 },
              ),
            ),
        );
        return fetchWorker(
          post('/v1/routes', JSON.stringify({ email: 'owner@example.com', alias: 'Contact' })),
          baseEnv(),
        );
      },
    },
    {
      code: 'route_not_found',
      run: () =>
        fetchWorker(
          new Request('https://api.conform.test/v1/routes/cfm_QQQQQQQQQQQQQQQQ'),
          baseEnv(),
        ),
    },
    {
      code: 'verification_token_required',
      run: () =>
        fetchWorker(
          post('/v1/routes/verify', '', 'application/x-www-form-urlencoded'),
          arbitraryEnv(),
        ),
    },
    {
      code: 'verification_token_invalid',
      run: () =>
        fetchWorker(
          new Request('https://api.conform.test/v1/routes/verify?token=garbage'),
          arbitraryEnv(),
        ),
    },
    {
      code: 'verification_token_expired',
      run: async () => {
        const env = arbitraryEnv();
        const token = await expiredPendingToken(env);
        return fetchWorker(
          post(
            '/v1/routes/verify',
            new URLSearchParams({ token }).toString(),
            'application/x-www-form-urlencoded',
          ),
          env,
        );
      },
    },
    {
      code: 'verification_mismatch',
      run: async () => {
        const routes = new Map<string, StoredRouteRecord>();
        const env = arbitraryEnv(routes);
        await installRoute(env, routes, { status: 'pending' });
        const token = await mismatchedPendingToken(env);
        return fetchWorker(
          post(
            '/v1/routes/verify',
            new URLSearchParams({ token }).toString(),
            'application/x-www-form-urlencoded',
          ),
          env,
        );
      },
    },
    {
      code: 'verification_unavailable',
      run: () =>
        fetchWorker(
          new Request('https://api.conform.test/v1/routes/verify?token=any'),
          baseEnv(),
        ),
    },
    {
      code: 'submission_empty',
      run: () => fetchWorker(post(`/f/${TEST_FORM_ID}`, JSON.stringify({})), baseEnv()),
    },
    {
      code: 'submission_too_large',
      run: () => {
        const env: Env = { ...baseEnv(), MAX_REQUEST_SIZE: '1024' };
        return fetchWorker(post(`/f/${TEST_FORM_ID}`, 'a'.repeat(3000)), env);
      },
    },
    {
      code: 'unsupported_media_type',
      run: () => fetchWorker(post(`/f/${TEST_FORM_ID}`, 'hello', 'text/plain'), baseEnv()),
    },
    {
      code: 'file_uploads_unsupported',
      run: () => {
        const form = new FormData();
        form.append('file', new File(['x'], 'x.txt', { type: 'text/plain' }));
        return fetchWorker(
          new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
            method: 'POST',
            body: form,
          }),
          baseEnv(),
        );
      },
    },
    {
      code: 'inbox_not_verified',
      run: async () => {
        const routes = new Map<string, StoredRouteRecord>();
        const env = baseEnv({ routes });
        await installRoute(env, routes, { status: 'pending', destinationId: 'destination-id' });
        vi.stubGlobal('fetch', unverifiedDestinationFetch());
        return fetchWorker(post(`/f/${TEST_FORM_ID}`, JSON.stringify({ message: 'x' })), env);
      },
    },
    {
      code: 'monthly_allowance_exhausted',
      run: async () => {
        const routes = new Map<string, StoredRouteRecord>();
        const env = baseEnv({
          routes,
          reservation: { allowed: false, used: 250, limit: 250, month: '2026-07' },
        });
        await installRoute(env, routes);
        return fetchWorker(post(`/f/${TEST_FORM_ID}`, JSON.stringify({ message: 'x' })), env);
      },
    },
    {
      code: 'delivery_failed',
      run: async () => {
        const routes = new Map<string, StoredRouteRecord>();
        const env = baseEnv({
          routes,
          send: async () => {
            throw new Error('provider failure');
          },
        });
        await installRoute(env, routes);
        return fetchWorker(post(`/f/${TEST_FORM_ID}`, JSON.stringify({ message: 'x' })), env);
      },
    },
    {
      code: 'method_not_allowed',
      run: () =>
        fetchWorker(
          new Request('https://api.conform.test/v1/routes', { method: 'PUT' }),
          baseEnv(),
        ),
    },
    {
      code: 'not_found',
      run: () => fetchWorker(new Request('https://api.conform.test/nope'), baseEnv()),
    },
    {
      code: 'config_incomplete',
      run: () => {
        const env: Env = { ...baseEnv(), OWNER_HASH_SECRET: undefined };
        return fetchWorker(
          post('/v1/routes', JSON.stringify({ email: 'owner@example.com', alias: 'Contact' })),
          env,
        );
      },
    },
    {
      code: 'internal_error',
      run: () => {
        const env: Env = {
          ...baseEnv(),
          ROUTES: {
            idFromName: () => ({}) as DurableObjectId,
            get() {
              throw new Error('boom');
            },
          } as unknown as DurableObjectNamespace,
        };
        return fetchWorker(
          new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}`),
          env,
        );
      },
    },
  ];

  it('has a recipe for every active code and no others', () => {
    expect(recipes.map((recipe) => recipe.code).sort()).toEqual(activeCodes);
  });

  for (const { code, run } of recipes) {
    it(`emits ${code} as JSON with the documented status and retryability`, async () => {
      const response = await run();
      const entry = table[code];
      expect(response.status).toBe(entry.status);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ success: false, error: code, retryable: entry.retryable });
      expect(typeof body.message).toBe('string');
    });
  }

  it('adds an Allow header to method_not_allowed', async () => {
    const response = await fetchWorker(
      new Request('https://api.conform.test/v1/routes', { method: 'PUT' }),
      baseEnv(),
    );
    expect(response.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('adds used, limit, and resets_at to monthly_allowance_exhausted', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({
      routes,
      reservation: { allowed: false, used: 250, limit: 250, month: '2026-07' },
    });
    await installRoute(env, routes);
    const response = await fetchWorker(
      post(`/f/${TEST_FORM_ID}`, JSON.stringify({ message: 'x' })),
      env,
    );
    expect(await response.json()).toMatchObject({
      used: 250,
      limit: 250,
      resets_at: '2026-08-01T00:00:00.000Z',
    });
  });

  it('adds a poll next_action to inbox_not_verified', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes, { status: 'pending', destinationId: 'destination-id' });
    vi.stubGlobal('fetch', unverifiedDestinationFetch());
    const response = await fetchWorker(
      post(`/f/${TEST_FORM_ID}`, JSON.stringify({ message: 'x' })),
      env,
    );
    const body = (await response.json()) as {
      next_action: { type: string; poll: { url: string; interval_seconds: number } };
    };
    expect(body.next_action.type).toBe('human_verification');
    expect(body.next_action.poll.url).toBe(
      `https://api.conform.test/v1/routes/${TEST_FORM_ID}`,
    );
    expect(body.next_action.poll.interval_seconds).toBe(15);
  });
});

describe('next_action envelope on success paths', () => {
  it('returns human_verification with a poll block on arbitrary-mode 202', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = arbitraryEnv(routes);
    const response = await fetchWorker(
      post('/v1/routes', JSON.stringify({ email: 'owner@example.com', alias: 'Contact' })),
      env,
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe('pending_verification');
    expect(body.status_url).toBe(`https://api.conform.test/v1/routes/${body.form_id}`);
    expect(body.next_action.type).toBe('human_verification');
    expect(body.next_action.poll.url).toBe(body.status_url);
    expect(body.next_action.poll.interval_seconds).toBe(15);
    expect(Date.parse(body.verification_expires_at)).toBeGreaterThan(Date.now());
  });

  it('returns next_action none on a 201 for an already-verified inbox', async () => {
    vi.stubGlobal('fetch', verifiedDestinationFetch());
    const response = await fetchWorker(
      post('/v1/routes', JSON.stringify({ email: 'owner@example.com', alias: 'Contact' })),
      baseEnv(),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe('active');
    expect(body.next_action).toEqual({ type: 'none' });
  });

  it('keeps the landing-page compatibility fields on both creation responses', async () => {
    vi.stubGlobal('fetch', verifiedDestinationFetch());
    const created = (await (
      await fetchWorker(
        post('/v1/routes', JSON.stringify({ email: 'owner@example.com', alias: 'Contact' })),
        baseEnv(),
      )
    ).json()) as Record<string, unknown>;
    for (const field of ['endpoint', 'form_id', 'status', 'message']) {
      expect(created[field], `201 response is missing ${field}`).toBeDefined();
    }

    const reserved = (await (
      await fetchWorker(
        post('/v1/routes', JSON.stringify({ email: 'owner@example.com', alias: 'Contact' })),
        arbitraryEnv(),
      )
    ).json()) as Record<string, unknown>;
    for (const field of ['endpoint', 'form_id', 'status', 'message']) {
      expect(reserved[field], `202 response is missing ${field}`).toBeDefined();
    }
  });

  it('reports pending status with a poll next_action and created_at on the status endpoint', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes, { status: 'pending', destinationId: 'destination-id' });
    vi.stubGlobal('fetch', unverifiedDestinationFetch());
    const response = await fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}`),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe('pending_verification');
    expect(body.next_action.type).toBe('human_verification');
    expect(typeof body.created_at).toBe('string');
  });
});

describe('discovery and specification serving', () => {
  it('reports api_version and openapi_url in the descriptor', async () => {
    const response = await fetchWorker(new Request('https://api.conform.test/'), baseEnv());
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.api_version).toBe(spec.info.version);
    expect(body.openapi_url).toBe('https://api.conform.test/openapi.json');
  });

  it('serves the spec at /openapi.json with public caching', async () => {
    const response = await fetchWorker(
      new Request('https://api.conform.test/openapi.json'),
      baseEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public');
    const body = (await response.json()) as { info: { version: string } };
    expect(body.info.version).toBe(spec.info.version);
  });

  it('prepares CORS for idempotency and management in the preflight', async () => {
    const response = await fetchWorker(
      new Request('https://api.conform.test/v1/routes', { method: 'OPTIONS' }),
      baseEnv(),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Idempotency-Key');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
  });
});
