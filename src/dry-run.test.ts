import { describe, expect, it, vi } from 'vitest';
import worker from './index';
import { accessKeyHash } from './crypto';
import { parseFormSchema } from './schema';
import { TEST_FORM_ID, baseEnv, executionContext, installRoute } from './test-support';
import type { EmailMessageBuilder, Env, StoredRouteRecord } from './types';

function fetchWorker(request: Request, env: Env) {
  return worker.fetch(request, env, executionContext().ctx);
}

function submit(
  env: Env,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetchWorker(
    new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

const SCHEMA = parseFormSchema({
  fields: {
    name: { type: 'text', required: true },
    email: { type: 'email', required: true },
    adults: { type: 'integer', min: 1, max: 6 },
  },
});

function harness(options: Parameters<typeof baseEnv>[0] = {}) {
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
  const routes = new Map<string, StoredRouteRecord>();
  const requests: string[] = [];
  const env = baseEnv({ ...options, routes, send, requests });
  return { send, routes, requests, env };
}

describe('dry run', () => {
  it('sends nothing and spends nothing', async () => {
    const { send, routes, requests, env } = harness();
    await installRoute(env, routes);

    const response = await submit(env, { name: 'A Guest', _dry_run: 'true' });
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.dry_run).toBe(true);
    expect(body.delivered).toBe(false);
    expect(body.would_deliver).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(requests.some((url) => url.endsWith('/reserve'))).toBe(false);
  });

  it('reports the allowance to a caller holding an accepted key', async () => {
    const { routes, requests, env } = harness({
      reservation: { allowed: true, used: 12, limit: 250, month: '2026-08' },
    });
    const key = `cfk_${'H'.repeat(32)}`;
    await installRoute(env, routes, {
      accessKeys: [
        {
          keyId: 'AAAAAAAA',
          hash: await accessKeyHash(key, env.OWNER_HASH_SECRET),
          createdAt: '2026-08-18T00:00:00.000Z',
        },
      ],
    });

    const body = (await (
      await submit(env, { name: 'x', access_key: key, _dry_run: '1' })
    ).json()) as any;

    expect(body.quota).toMatchObject({ used: 12, limit: 250 });
    expect(requests.some((url) => url.endsWith('/peek'))).toBe(true);
    expect(requests.some((url) => url.endsWith('/reserve'))).toBe(false);
  });

  it('withholds the allowance from an anonymous caller', async () => {
    // `/f/{id}` is unauthenticated and the form ID is in the page source, so
    // publishing month-to-date volume here makes an inbox's enquiry rate
    // pollable by anyone who scraped a form.
    const { routes, env } = harness({
      reservation: { allowed: true, used: 12, limit: 250, month: '2026-08' },
    });
    await installRoute(env, routes);

    const body = (await (await submit(env, { name: 'x', _dry_run: '1' })).json()) as any;

    expect(body.would_deliver).toBe(true);
    expect(body.quota).toBeUndefined();
    expect(body.delivery).toBeUndefined();
  });

  it('says a full allowance would not deliver', async () => {
    const { routes, env } = harness({
      reservation: { allowed: false, used: 250, limit: 250, month: '2026-08' },
    });
    await installRoute(env, routes);

    const body = (await (await submit(env, { name: 'x', _dry_run: 'true' })).json()) as any;

    expect(body.would_deliver).toBe(false);
  });

  it('returns the same error a real submission would', async () => {
    const { send, routes, env } = harness();
    await installRoute(env, routes, { schema: SCHEMA });

    const dry = await submit(env, { name: '', adults: '9', _dry_run: 'true' });
    const real = await submit(env, { name: '', adults: '9' });
    const dryBody = (await dry.json()) as any;
    const realBody = (await real.json()) as any;

    expect(dry.status).toBe(422);
    expect(dry.status).toBe(real.status);
    expect(dryBody.errors).toEqual(realBody.errors);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports an unverified inbox rather than pretending it would deliver', async () => {
    const { routes, env } = harness();
    await installRoute(env, routes, { status: 'pending' });

    const response = await submit(env, { name: 'x', _dry_run: 'true' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as any).error).toBe('inbox_not_verified');
  });

  it('checks the access key, which is the point of running one from CI', async () => {
    const { routes, env } = harness();
    const key = 'cfk_' + 'D'.repeat(32);
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

    const wrong = await submit(env, {
      name: 'x',
      access_key: 'cfk_' + 'E'.repeat(32),
      _dry_run: 'true',
    });
    expect(wrong.status).toBe(403);

    const right = await submit(env, { name: 'x', access_key: key, _dry_run: 'true' });
    expect(right.status).toBe(200);
    expect(((await right.json()) as any).dry_run).toBe(true);
  });

  it('does not mark a key used, so a dry run cannot retire the live one', async () => {
    const { routes, env } = harness();
    const key = 'cfk_' + 'F'.repeat(32);
    await installRoute(env, routes, {
      accessKeys: [
        {
          keyId: 'AAAAAAAA',
          hash: await accessKeyHash(key, env.OWNER_HASH_SECRET),
          createdAt: '2026-08-18T00:00:00.000Z',
        },
      ],
    });

    await submit(env, { name: 'x', access_key: key, _dry_run: 'true' });

    expect(routes.get(TEST_FORM_ID)?.accessKeys?.[0].usedAt).toBeUndefined();
  });

  it('never posts a webhook', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { routes, env } = harness();
      await installRoute(env, routes, {
        delivery: { mode: 'webhook', webhook: { url: 'https://hook.example/x', secret: 'whsec_x' } },
      });

      const key = `cfk_${'J'.repeat(32)}`;
      const withKey = await submit(env, { name: 'x', access_key: key, _dry_run: 'true' });
      void withKey;
      const body = (await (await submit(env, { name: 'x', _dry_run: 'true' })).json()) as any;

      expect(body.dry_run).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers a honeypot hit identically, so it cannot be used to find the trap', async () => {
    const { routes, env } = harness();
    await installRoute(env, routes);

    const trapped = await submit(env, { name: 'x', _gotcha: 'filled', _dry_run: 'true' });
    const clean = await submit(env, { name: 'x', _dry_run: 'true' });
    const trappedBody = (await trapped.json()) as Record<string, unknown>;
    const cleanBody = (await clean.json()) as Record<string, unknown>;

    expect(trapped.status).toBe(clean.status);
    // Whole body, not just the status. Asserting only the status is what let
    // the clean answer grow a `would_deliver` field the trapped one lacked,
    // turning its absence into a free oracle for the trap.
    expect(trappedBody).toEqual(cleanBody);
  });

  it('never redirects, however the form is configured', async () => {
    const { send, routes, env } = harness();
    await installRoute(env, routes);

    const response = await submit(env, {
      name: 'x',
      _redirect: 'https://example.com/thanks',
      _dry_run: 'true',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Location')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('tells an HTML client it was not delivered', async () => {
    const { routes, env } = harness();
    await installRoute(env, routes);

    const response = await submit(env, { name: 'x', _dry_run: 'true' }, { Accept: 'text/html' });
    const html = await response.text();

    expect(html).toContain('Dry run — nothing was sent');
    expect(html).not.toContain('<h1>Submission sent</h1>');
    expect(html).toContain('_dry_run');
  });

  it('treats _dry_run=false as a real submission', async () => {
    const { send, routes, env } = harness();
    await installRoute(env, routes);

    const response = await submit(env, { name: 'x', _dry_run: 'false' });

    expect(response.status).toBe(200);
    expect(((await response.json()) as any).dry_run).toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it('keeps the flag out of the delivered submission', async () => {
    const { send, routes, env } = harness();
    await installRoute(env, routes);

    await submit(env, { name: 'x', _dry_run: 'no' });

    expect(send.mock.calls[0][0].text).not.toContain('_dry_run');
  });

  it('wins over _test, which would otherwise send real mail', async () => {
    const { send, routes, env } = harness();
    await installRoute(env, routes);

    const response = await submit(env, { name: 'x', _test: 'true', _dry_run: 'true' });

    expect(((await response.json()) as any).dry_run).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('is still rate limited, so it is no cheaper to probe with than to submit', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const seen: string[] = [];
    const env: Env = {
      ...baseEnv({ routes }),
      SUBMISSION_RATE_LIMITER: {
        async limit({ key }) {
          seen.push(key);
          return { success: false };
        },
      },
    };
    await installRoute(env, routes);

    const response = await submit(env, { name: 'x', _dry_run: 'true' });

    expect(response.status).toBe(429);
    expect(seen.length).toBeGreaterThan(0);
  });
});
