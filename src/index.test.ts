import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import {
  TEST_FORM_ID,
  baseEnv,
  executionContext,
  installRoute,
  verifiedDestinationFetch,
} from './test-support';
import type { EmailMessageBuilder, StoredRouteRecord } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conform worker', () => {
  it('serves the MCP endpoint from the same Worker as the API', async () => {
    const { ctx } = executionContext();
    const env = baseEnv();

    // Both surfaces answer on one Worker: no second script, no zone route
    // racing the Custom Domain.
    const mcp = await worker.fetch(new Request('https://api.conform.test/mcp'), env, ctx);
    expect(mcp.status).toBe(200);
    expect(await mcp.json()).toMatchObject({ transport: 'streamable-http' });

    // ...and the delivery engine is untouched by the delegation.
    const api = await worker.fetch(new Request('https://api.conform.test/'), env, ctx);
    expect(api.status).toBe(200);

    const missing = await worker.fetch(
      new Request('https://api.conform.test/mcp-not-a-real-path'),
      env,
      ctx,
    );
    expect(missing.status).toBe(404);
  });

  it('answers MCP preflight with the MCP CORS headers, not the API ones', async () => {
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request('https://api.conform.test/mcp', { method: 'OPTIONS' }),
      baseEnv(),
      ctx,
    );

    expect(response.status).toBe(204);
    // The engine's own preflight does not allow these, so reaching them proves
    // /mcp is dispatched ahead of the shared CORS block.
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Mcp-Session-Id');
  });

  it('routes MCP tool calls through the engine in process', async () => {
    const { ctx } = executionContext();
    const globalFetch = vi.spyOn(globalThis, 'fetch');

    const response = await worker.fetch(
      new Request('https://api.conform.test/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_form_status', arguments: { form_id: 'cfm_MISSING000000000' } },
        }),
      }),
      baseEnv(),
      ctx,
    );

    expect(response.status).toBe(200);
    // The tool really ran: it reached the engine and got the engine's own
    // route_not_found back, rather than failing earlier inside the MCP layer.
    const body = (await response.json()) as { result?: { content?: { text: string }[] } };
    expect(body.result?.content?.[0]?.text).toContain('route_not_found');
    // ...and it got there without the Worker re-entering itself over the
    // network, which is the point of the injected fetcher.
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('publishes its source version and exact storage boundary', async () => {
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request('https://api.conform.test/'),
      baseEnv(),
      ctx,
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.version).toBe('abc123');
    expect(body.persistence).toEqual({
      submission_fields: false,
      destination_email_plaintext: false,
      route: [
        'form id',
        'alias',
        'opaque inbox id',
        'encrypted destination',
        'verification status',
        'Cloudflare destination id',
      ],
      quota: ['opaque inbox id', 'UTC month', 'used count', 'limit'],
      account_form_index: ['opaque inbox id', 'form ids', 'created timestamps'],
      workers_kv: false,
    });
  });

  it('uses non-unique aliases and returns a different short ID for each form', async () => {
    vi.stubGlobal('fetch', verifiedDestinationFetch());
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    const { ctx } = executionContext();

    const create = () =>
      worker.fetch(
        new Request('https://api.conform.test/v1/routes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'owner@example.com', alias: 'Contact' }),
        }),
        env,
        ctx,
      );
    const first = (await (await create()).json()) as {
      form_id: string;
      alias: string;
      endpoint: string;
    };
    const second = (await (await create()).json()) as typeof first;

    expect(first.alias).toBe('Contact');
    expect(second.alias).toBe('Contact');
    expect(first.form_id).toMatch(/^cfm_[A-HJ-NP-Z2-9]{16}$/u);
    expect(second.form_id).toMatch(/^cfm_[A-HJ-NP-Z2-9]{16}$/u);
    expect(first.form_id).not.toBe(second.form_id);
    expect(first.endpoint).toBe(`https://api.conform.test/f/${first.form_id}`);
    expect(routes.get(first.form_id)?.ownerId).toBe(routes.get(second.form_id)?.ownerId);
    expect(routes.get(first.form_id)?.encryptedRoute).not.toContain('owner@example.com');
  });

  it('contains the arbitrary-recipient fallback and activates only after confirmation', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({
      messageId: 'verification-message',
    }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = {
      ...baseEnv({ send, routes }),
      DELIVERY_MODE: 'arbitrary' as const,
    };
    const { ctx } = executionContext();
    const registration = await worker.fetch(
      new Request('https://api.conform.test/v1/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com', alias: 'Contact' }),
      }),
      env,
      ctx,
    );
    const registrationBody = (await registration.json()) as {
      form_id: string;
      endpoint: string;
    };
    expect(registration.status).toBe(202);
    expect(registrationBody.endpoint).toBe(
      `https://api.conform.test/f/${registrationBody.form_id}`,
    );
    expect(routes.get(registrationBody.form_id)?.status).toBe('pending');

    const verificationText = send.mock.calls[0]?.[0].text ?? '';
    const verificationUrl = verificationText.match(
      /https:\/\/api\.conform\.test\/v1\/routes\/verify\?token=[^\s]+/u,
    )?.[0];
    const pendingToken = new URL(verificationUrl as string).searchParams.get('token');
    const confirmation = await worker.fetch(
      new Request('https://api.conform.test/v1/routes/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: pendingToken as string }),
      }),
      env,
      ctx,
    );
    const body = (await confirmation.json()) as {
      status: string;
      form_id: string;
      endpoint: string;
    };
    expect(body.status).toBe('active');
    expect(body.form_id).toBe(registrationBody.form_id);
    expect(body.endpoint).toBe(registrationBody.endpoint);
    expect(routes.get(body.form_id)?.status).toBe('active');
  });

  it('refreshes Cloudflare verification status without changing the form URL', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes, {
      status: 'pending',
      destinationId: 'destination-id',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          success: true,
          result: {
            id: 'destination-id',
            email: 'owner@example.com',
            verified: '2026-07-23T00:00:00Z',
          },
        }),
      ),
    );
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}`),
      env,
      ctx,
    );
    const body = (await response.json()) as { status: string; endpoint: string };
    expect(body.status).toBe('active');
    expect(body.endpoint).toBe(`https://api.conform.test/f/${TEST_FORM_ID}`);
    expect(routes.get(TEST_FORM_ID)?.status).toBe('active');
  });

  it('rejects submissions until the destination inbox is verified', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'message-id' }));
    const env = baseEnv({ routes, send });
    await installRoute(env, routes, {
      status: 'pending',
      destinationId: 'destination-id',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          success: true,
          result: {
            id: 'destination-id',
            email: 'owner@example.com',
            verified: null,
          },
        }),
      ),
    );
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Do not deliver yet' }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'inbox_not_verified',
      retryable: true,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns the same not-found response for malformed and unknown form ids', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    const { ctx } = executionContext();

    const malformed = await worker.fetch(
      new Request('https://api.conform.test/v1/routes/contact'),
      env,
      ctx,
    );
    const unknown = await worker.fetch(
      new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}`),
      env,
      ctx,
    );

    expect(malformed.status).toBe(404);
    expect(unknown.status).toBe(404);
    const malformedBody = (await malformed.json()) as Record<string, unknown>;
    expect(malformedBody.error).toBe('route_not_found');
    expect(malformedBody).toEqual(await unknown.json());
  });

  it('reserves shared inbox quota before delivering the form as text', async () => {
    const requests: string[] = [];
    const routes = new Map<string, StoredRouteRecord>();
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'message-id' }));
    const env = baseEnv({ send, requests, routes });
    await installRoute(env, routes);
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'name=Ada&email=ada%40example.com&message=Hello',
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(requests[0]?.endsWith('/reserve')).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({
      to: 'owner@example.com',
      replyTo: 'ada@example.com',
      subject: 'New submission from Contact',
    });
    expect(send.mock.calls[0][0].text).toContain('message\nHello');
  });

  it('takes reply-to from _replyto and keeps it out of the body', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'message-id' }));
    const env = baseEnv({ send, routes });
    await installRoute(env, routes);
    const { ctx } = executionContext();

    const response = await worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'name=Ada&_replyto=ada%40example.com&message=Hello',
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(send.mock.calls[0][0]).toMatchObject({ replyTo: 'ada@example.com' });
    // The control field must not surface as if a visitor had typed it.
    expect(send.mock.calls[0][0].text).not.toContain('_replyto');
    expect(send.mock.calls[0][0].text).toContain('message\nHello');
  });

  it('prefers an explicit _replyto over the email field', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'message-id' }));
    const env = baseEnv({ send, routes });
    await installRoute(env, routes);
    const { ctx } = executionContext();

    await worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=typed%40example.com&_replyto=explicit%40example.com&message=Hello',
      }),
      env,
      ctx,
    );

    expect(send.mock.calls[0][0]).toMatchObject({ replyTo: 'explicit@example.com' });
    // email is a visitor-supplied field and still belongs in the body.
    expect(send.mock.calls[0][0].text).toContain('typed@example.com');
  });

  it('does not send after the shared monthly allowance is exhausted', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'message-id' }));
    const env = baseEnv({
      routes,
      send,
      reservation: {
        allowed: false,
        used: 250,
        limit: 250,
        month: '2026-07',
      },
    });
    await installRoute(env, routes);
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Should not send' }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(429);
    expect(send).not.toHaveBeenCalled();
  });

  it('rolls back a reservation when email delivery fails', async () => {
    const requests: string[] = [];
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({
      routes,
      requests,
      send: async () => {
        throw new Error('provider failure');
      },
    });
    await installRoute(env, routes);
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(503);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.endsWith('/rollback')).toBe(true);
  });

  it('drops honeypot submissions without route lookup, quota, or email', async () => {
    const requests: string[] = [];
    const routes = new Map<string, StoredRouteRecord>();
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'message-id' }));
    const env = baseEnv({ requests, routes, send });
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'spam', _gotcha: 'bot' }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(0);
    expect(routes.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('submission rate limiting', () => {
  function limiter(results: boolean[]) {
    const keys: string[] = [];
    let call = 0;
    return {
      keys,
      binding: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          const success = results[call] ?? true;
          call += 1;
          return { success };
        },
      },
    };
  }

  async function submit(env: ReturnType<typeof baseEnv>) {
    const { ctx } = executionContext();
    return worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
        body: JSON.stringify({ message: 'hello' }),
      }),
      env,
      ctx,
    );
  }

  it('limits by form and by client, never by anything identifying', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    const { keys, binding } = limiter([true, true]);
    env.SUBMISSION_RATE_LIMITER = binding as unknown as typeof env.SUBMISSION_RATE_LIMITER;
    await installRoute(env, routes);

    await submit(env);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(`form:${TEST_FORM_ID}`);
    // The client key is an HMAC, never the raw address.
    expect(keys[1]).toMatch(/^client:/u);
    expect(keys[1]).not.toContain('203.0.113.7');
  });

  it('refuses a burst with a retryable rate_limited', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    const { binding } = limiter([false, true]);
    env.SUBMISSION_RATE_LIMITER = binding as unknown as typeof env.SUBMISSION_RATE_LIMITER;
    await installRoute(env, routes);

    const response = await submit(env);
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(429);
    expect(body.error).toBe('rate_limited');
    expect(body.retryable).toBe(true);
    expect(body.retry_after_seconds).toBe(60);
  });

  it('refuses when the client is over even if the form is not', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    const { binding } = limiter([true, false]);
    env.SUBMISSION_RATE_LIMITER = binding as unknown as typeof env.SUBMISSION_RATE_LIMITER;
    await installRoute(env, routes);

    expect((await submit(env)).status).toBe(429);
  });

  it('does not consume the allowance when a submission is refused', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const requests: string[] = [];
    const env = baseEnv({ routes, requests });
    const { binding } = limiter([false, true]);
    env.SUBMISSION_RATE_LIMITER = binding as unknown as typeof env.SUBMISSION_RATE_LIMITER;
    await installRoute(env, routes);

    await submit(env);

    // A throttled request must never reach the quota object: the whole point is
    // that the rate limit absorbs an attack instead of the allowance doing it.
    expect(requests.some((url) => url.endsWith('/reserve'))).toBe(false);
  });

  it('never rate-limits a honeypot submission, which costs nothing to drop', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    const { keys, binding } = limiter([true, true]);
    env.SUBMISSION_RATE_LIMITER = binding as unknown as typeof env.SUBMISSION_RATE_LIMITER;
    await installRoute(env, routes);

    const { ctx } = executionContext();
    await worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'x', _gotcha: 'caught' }),
      }),
      env,
      ctx,
    );

    expect(keys).toHaveLength(0);
  });

  it('still delivers when no limiter is bound', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    delete env.SUBMISSION_RATE_LIMITER;
    await installRoute(env, routes);

    expect((await submit(env)).status).toBe(200);
  });
});

describe('throttle reporting is sampled, not per-request', () => {
  function limiters(reportAllowed: boolean[]) {
    let call = 0;
    const reportKeys: string[] = [];
    return {
      reportKeys,
      submission: {
        limit: async () => ({ success: false }),
      },
      report: {
        limit: async ({ key }: { key: string }) => {
          reportKeys.push(key);
          const success = reportAllowed[call] ?? false;
          call += 1;
          return { success };
        },
      },
    };
  }

  async function burst(env: ReturnType<typeof baseEnv>, times: number) {
    for (let i = 0; i < times; i += 1) {
      const { ctx, promises } = executionContext();
      await worker.fetch(
        new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'x' }),
        }),
        env,
        ctx,
      );
      await Promise.all(promises);
    }
  }

  it('counts once per window however hard the burst pushes', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const requests: string[] = [];
    const env = baseEnv({ routes, requests });
    const { submission, report } = limiters([true, false, false, false, false]);
    env.SUBMISSION_RATE_LIMITER = submission as unknown as typeof env.SUBMISSION_RATE_LIMITER;
    env.THROTTLE_REPORT_LIMITER = report as unknown as typeof env.THROTTLE_REPORT_LIMITER;
    await installRoute(env, routes);

    await burst(env, 5);

    // Five refused requests, one counter write. Recording an attack must never
    // scale with the attack.
    const counted = requests.filter((url) => url.endsWith('/throttled'));
    expect(counted).toHaveLength(1);
  });

  it('keys the sampler by form, so one attacked form cannot mask another', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    const { submission, report, reportKeys } = limiters([true]);
    env.SUBMISSION_RATE_LIMITER = submission as unknown as typeof env.SUBMISSION_RATE_LIMITER;
    env.THROTTLE_REPORT_LIMITER = report as unknown as typeof env.THROTTLE_REPORT_LIMITER;
    await installRoute(env, routes);

    await burst(env, 1);

    expect(reportKeys[0]).toBe(`report:${TEST_FORM_ID}`);
  });

  it('still refuses the request when reporting is not configured', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const requests: string[] = [];
    const env = baseEnv({ routes, requests });
    const { submission } = limiters([]);
    env.SUBMISSION_RATE_LIMITER = submission as unknown as typeof env.SUBMISSION_RATE_LIMITER;
    delete env.THROTTLE_REPORT_LIMITER;
    await installRoute(env, routes);

    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'x' }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(429);
    expect(requests.some((url) => url.endsWith('/throttled'))).toBe(false);
  });

  it('does not count a throttle against a form that does not exist', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const requests: string[] = [];
    const env = baseEnv({ routes, requests });
    const { submission, report } = limiters([true]);
    env.SUBMISSION_RATE_LIMITER = submission as unknown as typeof env.SUBMISSION_RATE_LIMITER;
    env.THROTTLE_REPORT_LIMITER = report as unknown as typeof env.THROTTLE_REPORT_LIMITER;

    const { ctx, promises } = executionContext();
    await worker.fetch(
      new Request('https://api.conform.test/f/cfm_QQQQQQQQQQQQQQQQ', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'x' }),
      }),
      env,
      ctx,
    );
    await Promise.all(promises);

    expect(requests.some((url) => url.endsWith('/throttled'))).toBe(false);
  });
});
