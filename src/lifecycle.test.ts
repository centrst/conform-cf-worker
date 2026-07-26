import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import {
  TEST_FORM_ID,
  baseEnv,
  executionContext,
  installRoute,
  verifiedDestinationFetch,
} from './test-support';
import type { EmailMessageBuilder, Env, StoredRouteRecord } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function fetchWorker(request: Request, env: Env): Promise<Response> {
  return worker.fetch(request, env, executionContext().ctx);
}

function createRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://api.conform.test/v1/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function submitRequest(formId: string, body: Record<string, unknown>): Request {
  return new Request(`https://api.conform.test/f/${formId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('idempotent provisioning', () => {
  it('returns the same form for the same key without re-sending verification', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = { ...baseEnv({ send, routes }), DELIVERY_MODE: 'arbitrary' };

    const first = await fetchWorker(
      createRequest({ email: 'owner@example.com', alias: 'Contact' }, { 'Idempotency-Key': 'k1' }),
      env,
    );
    const firstBody = (await first.json()) as Record<string, any>;
    expect(first.status).toBe(202);
    expect(typeof firstBody.management_token).toBe('string');
    expect(firstBody.replayed).toBeUndefined();

    const second = await fetchWorker(
      createRequest({ email: 'owner@example.com', alias: 'Contact' }, { 'Idempotency-Key': 'k1' }),
      env,
    );
    const secondBody = (await second.json()) as Record<string, any>;
    expect(second.status).toBe(200);
    expect(secondBody.form_id).toBe(firstBody.form_id);
    expect(secondBody.replayed).toBe(true);
    expect(typeof secondBody.management_token).toBe('string');
    expect(routes.size).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports the current state on replay after verification completes', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ success: true, result: [], result_info: { total_pages: 1 } }),
        )
        .mockResolvedValueOnce(
          Response.json({
            success: true,
            result: { id: 'destination-id', email: 'owner@example.com', verified: null },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            success: true,
            result: { id: 'destination-id', verified: '2026-07-24T00:00:00Z' },
          }),
        ),
    );

    const first = await fetchWorker(
      createRequest({ email: 'owner@example.com', alias: 'Contact' }, { 'Idempotency-Key': 'k2' }),
      env,
    );
    expect(first.status).toBe(202);

    const replay = await fetchWorker(
      createRequest({ email: 'owner@example.com', alias: 'Contact' }, { 'Idempotency-Key': 'k2' }),
      env,
    );
    const body = (await replay.json()) as Record<string, any>;
    expect(replay.status).toBe(200);
    expect(body.replayed).toBe(true);
    expect(body.status).toBe('active');
    expect(body.next_action).toEqual({ type: 'none' });
  });

  it('scopes keys per destination inbox', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = { ...baseEnv({ routes }), DELIVERY_MODE: 'arbitrary' };
    const first = (await (
      await fetchWorker(
        createRequest({ email: 'a@example.com', alias: 'Contact' }, { 'Idempotency-Key': 'k' }),
        env,
      )
    ).json()) as { form_id: string };
    const second = (await (
      await fetchWorker(
        createRequest({ email: 'b@example.com', alias: 'Contact' }, { 'Idempotency-Key': 'k' }),
        env,
      )
    ).json()) as { form_id: string };
    expect(first.form_id).not.toBe(second.form_id);
    expect(routes.size).toBe(2);
  });
});

describe('management token and DELETE', () => {
  async function createdRoute(env: Env, key: string, email = 'owner@example.com') {
    const response = await fetchWorker(
      createRequest({ email, alias: 'Contact' }, { 'Idempotency-Key': key }),
      env,
    );
    return (await response.json()) as { form_id: string; management_token: string };
  }

  it('deletes a route with its own token, after which status is 404', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = { ...baseEnv({ routes }), DELIVERY_MODE: 'arbitrary' };
    const created = await createdRoute(env, 'delete-key');
    const deletion = await fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${created.form_id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${created.management_token}` },
      }),
      env,
    );
    expect(deletion.status).toBe(200);
    expect(await deletion.json()).toMatchObject({ status: 'deleted', form_id: created.form_id });
    expect(routes.size).toBe(0);

    const status = await fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${created.form_id}`),
      env,
    );
    expect(status.status).toBe(404);
  });

  it('rejects a management token that belongs to a different route', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = { ...baseEnv({ routes }), DELIVERY_MODE: 'arbitrary' };
    const target = await createdRoute(env, 'target-key');
    const other = await createdRoute(env, 'other-key', 'someone-else@example.com');
    const deletion = await fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${target.form_id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${other.management_token}` },
      }),
      env,
    );
    expect(deletion.status).toBe(403);
    expect(await deletion.json()).toMatchObject({ error: 'management_token_invalid' });
    expect(routes.size).toBe(2);
  });
});

describe('quota identity in the pipeline', () => {
  it('assigns the same quota key to identity variants with distinct owner IDs', async () => {
    vi.stubGlobal('fetch', verifiedDestinationFetch());
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await fetchWorker(createRequest({ email: 'hello+work@gmail.com', alias: 'A' }), env);
    await fetchWorker(createRequest({ email: 'hello@gmail.com', alias: 'B' }), env);
    const records = [...routes.values()];
    expect(records).toHaveLength(2);
    expect(records[0].quotaKey).toBeDefined();
    expect(records[0].quotaKey).toBe(records[1].quotaKey);
    expect(records[0].ownerId).not.toBe(records[1].ownerId);
  });

  it('reserves quota under the stored quota key', async () => {
    const quotaNames: string[] = [];
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, quotaNames });
    await installRoute(env, routes, { quotaKey: 'qk-test' });
    await fetchWorker(submitRequest(TEST_FORM_ID, { message: 'hi' }), env);
    expect(quotaNames).toEqual(['qk-test']);
  });

  it('falls back to the owner ID for legacy rows without a quota key', async () => {
    const quotaNames: string[] = [];
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, quotaNames });
    await installRoute(env, routes);
    await fetchWorker(submitRequest(TEST_FORM_ID, { message: 'hi' }), env);
    expect(quotaNames).toEqual(['opaque-owner']);
  });
});

describe('test-marked submissions', () => {
  it('delivers a [Test] email, consumes quota, and echoes proof', async () => {
    const requests: string[] = [];
    const routes = new Map<string, StoredRouteRecord>();
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const env = baseEnv({ routes, send, requests });
    await installRoute(env, routes);
    const response = await fetchWorker(
      submitRequest(TEST_FORM_ID, { message: 'hello', _test: 'true' }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      test: true,
      echo: null,
      message: 'Test submission delivered',
    });
    expect(requests[0]?.endsWith('/reserve')).toBe(true);
    expect(send.mock.calls[0][0].subject).toBe('[Test] New submission from Contact');
    expect(send.mock.calls[0][0].text).toContain('test submission');
  });

  it('echoes a non-boolean _test value as the nonce', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);
    const response = await fetchWorker(
      submitRequest(TEST_FORM_ID, { message: 'hello', _test: 'ref-42' }),
      env,
    );
    const body = (await response.json()) as { echo: string };
    expect(body.echo).toBe('ref-42');
  });

  it('lets the honeypot win over _test with no test acknowledgement', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, send });
    await installRoute(env, routes);
    const response = await fetchWorker(
      submitRequest(TEST_FORM_ID, { message: 'x', _test: 'true', _gotcha: 'bot' }),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.message).toBe('Submission received');
    expect(body.test).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('human-facing submission responses', () => {
  it('redirects with 303 after delivery when _redirect is a valid https URL', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, send });
    await installRoute(env, routes);
    const response = await fetchWorker(
      submitRequest(TEST_FORM_ID, { message: 'hi', _redirect: 'https://example.com/thanks' }),
      env,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://example.com/thanks');
    expect(send).toHaveBeenCalledOnce();
  });

  it('redirects honeypot hits identically without sending anything', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, send });
    const response = await fetchWorker(
      submitRequest(TEST_FORM_ID, {
        message: 'x',
        _gotcha: 'bot',
        _redirect: 'https://example.com/thanks',
      }),
      env,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://example.com/thanks');
    expect(send).not.toHaveBeenCalled();
  });

  it('serves an HTML result page to browser form posts, for success and failure', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);
    const success = await worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html,application/xhtml+xml',
        },
        body: 'message=Hello',
      }),
      env,
      executionContext().ctx,
    );
    expect(success.status).toBe(200);
    expect(success.headers.get('content-type')).toContain('text/html');
    expect(await success.text()).toContain('Submission sent');

    const failure = await worker.fetch(
      new Request('https://api.conform.test/f/cfm_QQQQQQQQQQQQQQQQ', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html,application/xhtml+xml',
        },
        body: 'message=Hello',
      }),
      env,
      executionContext().ctx,
    );
    expect(failure.status).toBe(404);
    expect(failure.headers.get('content-type')).toContain('text/html');
    expect(await failure.text()).toContain('Submission not sent');
  });
});
