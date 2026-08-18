import { describe, expect, it, vi } from 'vitest';
import worker from './index';
import { accessKeyHash, sealToken } from './crypto';
import { TEST_FORM_ID, baseEnv, executionContext, installRoute } from './test-support';
import type {
  EmailMessageBuilder,
  Env,
  RotateTokenPayload,
  StoredRouteRecord,
} from './types';

const OWNER = 'opaque-owner';

function fetchWorker(request: Request, env: Env) {
  return worker.fetch(request, env, executionContext().ctx);
}

/**
 * Submissions are the only thing that retires a key, and retirement happens in
 * waitUntil. Tests that assert on it must drain those promises, or they read
 * the state from before the acceptance landed.
 */
async function submit(
  env: Env,
  body: Record<string, unknown>,
  formId = TEST_FORM_ID,
): Promise<Response> {
  const { ctx, promises } = executionContext();
  const response = await worker.fetch(
    new Request(`https://api.conform.test/f/${formId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await Promise.all(promises);
  return response;
}

async function rotationToken(env: Env, formId = TEST_FORM_ID, ownerId = OWNER) {
  const payload: RotateTokenPayload = {
    kind: 'rotate',
    version: 1,
    routeId: formId,
    ownerId,
    issuedAt: Date.now(),
  };
  return sealToken(payload, env.ROUTE_TOKEN_SECRET);
}

async function mintKey(env: Env, token: string, formId = TEST_FORM_ID) {
  const response = await fetchWorker(
    new Request(`https://api.conform.test/v1/routes/${formId}/keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

async function setRequireKey(env: Env, manageToken: string, requireKey: boolean) {
  return fetchWorker(
    new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}/settings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${manageToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ require_key: requireKey }),
    }),
    env,
  );
}

describe('access key enforcement', () => {
  it('ignores an access_key on a route that has never minted one', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, send });
    await installRoute(env, routes);

    const response = await submit(env, { message: 'hello', access_key: 'anything' });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it('never surfaces the key to the delivered submission', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, send });
    const key = 'cfk_' + 'A'.repeat(32);
    await installRoute(env, routes, {
      accessKeys: [
        {
          keyId: 'AAAAAAAA',
          hash: await accessKeyHash(key, env.OWNER_HASH_SECRET),
          createdAt: '2026-08-18T00:00:00.000Z',
        },
      ],
    });

    await submit(env, { message: 'hello', access_key: key });

    expect(send.mock.calls[0][0].text).not.toContain(key);
    expect(send.mock.calls[0][0].text).not.toContain('access_key');
  });

  it('delivers a wrong key while enforcement is off, so shipping keys cannot break a form', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, send });
    await installRoute(env, routes, {
      accessKeys: [
        { keyId: 'AAAAAAAA', hash: 'a-stored-hash', createdAt: '2026-08-18T00:00:00.000Z' },
      ],
    });

    const response = await submit(env, { message: 'hello', access_key: 'cfk_wrong' });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it('refuses a missing key once enforcement is on', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, send });
    await installRoute(env, routes, {
      requireKey: true,
      accessKeys: [
        { keyId: 'AAAAAAAA', hash: 'a-stored-hash', createdAt: '2026-08-18T00:00:00.000Z' },
      ],
    });

    const response = await submit(env, { message: 'hello' });

    expect(response.status).toBe(403);
    expect((await response.json() as any).error).toBe('access_key_required');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an unrecognised key once enforcement is on', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes, {
      requireKey: true,
      accessKeys: [
        { keyId: 'AAAAAAAA', hash: 'a-stored-hash', createdAt: '2026-08-18T00:00:00.000Z' },
      ],
    });

    const response = await submit(env, {
      message: 'hello',
      access_key: 'cfk_' + 'B'.repeat(32),
    });

    expect(response.status).toBe(403);
    expect((await response.json() as any).error).toBe('access_key_invalid');
  });

  it('accepts the matching key', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, send });
    const key = 'cfk_' + 'C'.repeat(32);
    await installRoute(env, routes, {
      requireKey: true,
      accessKeys: [
        {
          keyId: 'AAAAAAAA',
          hash: await accessKeyHash(key, env.OWNER_HASH_SECRET),
          createdAt: '2026-08-18T00:00:00.000Z',
        },
      ],
    });

    const response = await submit(env, { message: 'hello', access_key: key });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it('refuses to turn enforcement on before a key exists', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);

    const manage = await sealToken(
      { kind: 'manage', version: 1, routeId: TEST_FORM_ID, ownerId: OWNER, issuedAt: Date.now() },
      env.ROUTE_TOKEN_SECRET,
    );
    const response = await setRequireKey(env, manage, true);

    expect(response.status).toBe(403);
    expect((await response.json() as any).error).toBe('access_key_required');
  });
});

describe('key rotation', () => {
  it('requires a token to mint', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);

    const response = await fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}/keys`, {
        method: 'POST',
      }),
      env,
    );

    expect(response.status).toBe(401);
  });

  it('rejects a rotation token minted for a different route', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);
    const token = await rotationToken(env, 'cfm_ZZZZZZZZZZZZZZZZ');

    const { response } = await mintKey(env, token);

    expect(response.status).toBe(403);
  });

  it('returns the key value exactly once, at mint', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);
    const token = await rotationToken(env);

    const { response, body } = await mintKey(env, token);
    expect(response.status).toBe(201);
    expect(body.key).toMatch(/^cfk_[A-HJ-NP-Z2-9]{32}$/u);

    const listed = await fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}/keys`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    const listing = (await listed.json()) as any;
    expect(JSON.stringify(listing)).not.toContain(body.key);
    expect(listing.keys[0].state).toBe('current');
  });

  it('cannot delete the route it can rotate', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);
    const token = await rotationToken(env);

    const response = await fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(routes.has(TEST_FORM_ID)).toBe(true);
  });

  it('keeps the superseded key working until the new one is first used', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, send });
    await installRoute(env, routes, { requireKey: true });
    const token = await rotationToken(env);

    const first = (await mintKey(env, token)).body.key as string;
    // The route must accept the first key before enforcement has anything to
    // enforce against, which is also what marks it used.
    await submit(env, { message: 'one', access_key: first });

    const second = (await mintKey(env, token)).body.key as string;

    // A visitor still holding the pre-deploy page.
    const stale = await submit(env, { message: 'two', access_key: first });
    expect(stale.status).toBe(200);

    // The deploy lands and the new key delivers.
    const fresh = await submit(env, { message: 'three', access_key: second });
    expect(fresh.status).toBe(200);

    // Now the old key is gone.
    const retired = await submit(env, { message: 'four', access_key: first });
    expect(retired.status).toBe(403);
    expect((await retired.json() as any).error).toBe('access_key_invalid');
  });

  it('a mint that is never deployed does not evict the live key', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes, { requireKey: true });
    const token = await rotationToken(env);

    const live = (await mintKey(env, token)).body.key as string;
    await submit(env, { message: 'one', access_key: live });

    // Two builds mint and then fail before shipping.
    await mintKey(env, token);
    await mintKey(env, token);

    const response = await submit(env, { message: 'two', access_key: live });
    expect(response.status).toBe(200);
    expect(routes.get(TEST_FORM_ID)?.accessKeys).toHaveLength(2);
  });
});

describe('submission ceilings', () => {
  it('reports the daily ceiling separately from the monthly one', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({
      routes,
      reservation: {
        allowed: false,
        reason: 'daily',
        used: 50,
        limit: 50,
        month: '2026-08',
        day: '2026-08-18',
      },
    });
    await installRoute(env, routes);

    const response = await submit(env, { message: 'hello' });
    const body = (await response.json()) as any;

    expect(response.status).toBe(429);
    expect(body.error).toBe('daily_allowance_exhausted');
    expect(body.retryable).toBe(true);
    expect(body.day).toBe('2026-08-18');
  });

  it('holds a client to a lower ceiling than the form', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const seen: string[] = [];
    const env: Env = {
      ...baseEnv({ routes }),
      SUBMISSION_RATE_LIMITER: {
        async limit({ key }) {
          seen.push(key);
          return { success: true };
        },
      },
      SUBMISSION_CLIENT_RATE_LIMITER: {
        async limit({ key }) {
          seen.push(key);
          return { success: false };
        },
      },
    };
    await installRoute(env, routes);

    const response = await submit(env, { message: 'hello' });

    expect(response.status).toBe(429);
    expect(seen.some((key) => key.startsWith('form:'))).toBe(true);
    expect(seen.some((key) => key.startsWith('client:'))).toBe(true);
  });

  it('refuses a body with too many fields', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = { ...baseEnv({ routes }), MAX_FIELDS: '2' };
    await installRoute(env, routes);

    const response = await submit(env, { a: '1', b: '2', c: '3' });

    expect(response.status).toBe(413);
    expect((await response.json() as any).error).toBe('too_many_fields');
  });

  it('refuses one oversized field inside an otherwise normal body', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = { ...baseEnv({ routes }), MAX_FIELD_LENGTH: '100' };
    await installRoute(env, routes);

    const response = await submit(env, { name: 'ok', message: 'x'.repeat(500) });

    expect(response.status).toBe(413);
    expect((await response.json() as any).error).toBe('field_too_large');
  });
});

describe('generated install artifacts', () => {
  async function install(env: Env, framework: string) {
    const response = await fetchWorker(
      new Request(
        `https://api.conform.test/v1/routes/${TEST_FORM_ID}/install?framework=${framework}`,
      ),
      env,
    );
    return (await response.json()) as any;
  }

  it('omits the field until the route has a key', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);

    const body = await install(env, 'html');

    expect(body.files[0].content).not.toContain('access_key');
    expect(body.requires_access_key).toBe(false);
  });

  it('carries a build-time placeholder in every framework once a key exists', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes, {
      requireKey: true,
      accessKeys: [
        { keyId: 'AAAAAAAA', hash: 'a-stored-hash', createdAt: '2026-08-18T00:00:00.000Z' },
      ],
    });

    for (const framework of ['html', 'js', 'react', 'vue', 'svelte', 'astro', 'nextjs']) {
      const body = await install(env, framework);
      expect(body.files[0].content, framework).toContain(
        'name="access_key" value="{{CONFORM_ACCESS_KEY}}"',
      );
      expect(body.requires_access_key, framework).toBe(true);
      expect(body.notes.join(' '), framework).toContain('not proof of origin');
    }
  });

  it('never puts a real key value in an artifact', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);
    const token = await rotationToken(env);
    const minted = (await mintKey(env, token)).body.key as string;

    const body = await install(env, 'html');

    // The Worker stores only a hash, and a pipeline mints a new key per build.
    // An artifact carrying a literal key would be stale the moment it shipped.
    expect(body.files[0].content).not.toContain(minted);
    expect(body.files[0].content).toContain('{{CONFORM_ACCESS_KEY}}');
  });
});
