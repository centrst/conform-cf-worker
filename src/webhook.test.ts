import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import {
  TEST_FORM_ID,
  baseEnv,
  executionContext,
  installRoute,
} from './test-support';
import {
  deliverWebhook,
  generateWebhookSecret,
  signWebhook,
  submissionEvent,
  validateWebhookUrl,
} from './webhook';
import type { EmailMessageBuilder, Env, RouteTokenPayload, StoredRouteRecord } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

const WEBHOOK_CONFIG = {
  mode: 'webhook' as const,
  webhook: { url: 'https://hooks.example.com/receiver', secret: generateWebhookSecret() },
};

function headerRecord(init?: HeadersInit): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function submitRequest(body: Record<string, unknown>): Request {
  return new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function verifySignature(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const expected = await signWebhook(secret, id, Number(timestamp), body);
  return expected === signature;
}

describe('webhook primitives', () => {
  it('produces verifiable Standard Webhooks signatures', async () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]+$/u);
    const signature = await signWebhook(secret, 'msg_1', 1_753_000_000, '{"a":1}');
    expect(signature).toMatch(/^v1,[A-Za-z0-9+/=]+$/u);
    expect(await verifySignature(secret, 'msg_1', '1753000000', '{"a":1}', signature)).toBe(true);
    expect(await verifySignature(secret, 'msg_2', '1753000000', '{"a":1}', signature)).toBe(false);
  });

  it('rejects non-public webhook URLs', () => {
    for (const url of [
      'http://example.com/hook',
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://internal/hook',
      'https://service.internal/hook',
      'not a url',
    ]) {
      expect(() => validateWebhookUrl(url), url).toThrowError();
    }
    expect(validateWebhookUrl('https://hooks.example.com/receiver')).toBe(
      'https://hooks.example.com/receiver',
    );
  });

  it('keeps webhook-id stable across retries and retries only on 5xx or network errors', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
        seen.push(headerRecord(init.headers));
        return new Response(null, { status: 500 });
      })
      .mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
        seen.push(headerRecord(init.headers));
        return new Response(null, { status: 200 });
      });
    const event = submissionEvent(
      {
        kind: 'route',
        version: 2,
        ownerId: 'o',
        routeId: TEST_FORM_ID,
        email: 'owner@example.com',
        formName: 'Contact',
        issuedAt: Date.now(),
      },
      { message: 'hello' },
      { test: false },
    );
    const result = await deliverWebhook(WEBHOOK_CONFIG.webhook, event, {
      retryWaitsMs: [1],
      timeoutMs: 1000,
      fetcher: fetcher as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]['webhook-id']).toBe(seen[1]['webhook-id']);
    expect(seen[0]['webhook-id']).toMatch(/^msg_/u);

    const permanent = vi.fn(async () => new Response(null, { status: 400 }));
    const rejected = await deliverWebhook(WEBHOOK_CONFIG.webhook, event, {
      retryWaitsMs: [1, 1],
      timeoutMs: 1000,
      fetcher: permanent as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(rejected.ok).toBe(false);
    expect(permanent).toHaveBeenCalledTimes(1);
  });
});

describe('webhook provisioning', () => {
  it('returns the signing secret once and re-reveals it on idempotent replay', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = { ...baseEnv({ routes }), DELIVERY_MODE: 'arbitrary' };
    const create = () =>
      worker.fetch(
        new Request('https://api.conform.test/v1/routes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'wh-key' },
          body: JSON.stringify({
            email: 'owner@example.com',
            alias: 'Contact',
            delivery: { mode: 'both', webhook: { url: 'https://hooks.example.com/receiver' } },
          }),
        }),
        env,
        executionContext().ctx,
      );
    const first = (await (await create()).json()) as Record<string, any>;
    expect(first.webhook.secret).toMatch(/^whsec_/u);
    const replay = (await (await create()).json()) as Record<string, any>;
    expect(replay.replayed).toBe(true);
    expect(replay.webhook.secret).toBe(first.webhook.secret);
    expect(routes.size).toBe(1);
  });

  it('treats a different webhook URL under the same key as a conflict', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = { ...baseEnv({ routes }), DELIVERY_MODE: 'arbitrary' };
    const create = (url: string) =>
      worker.fetch(
        new Request('https://api.conform.test/v1/routes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'wh-conflict' },
          body: JSON.stringify({
            email: 'owner@example.com',
            alias: 'Contact',
            delivery: { mode: 'both', webhook: { url } },
          }),
        }),
        env,
        executionContext().ctx,
      );
    await create('https://hooks.example.com/a');
    const second = await create('https://hooks.example.com/b');
    expect(second.status).toBe(422);
    expect(await second.json()).toMatchObject({ error: 'idempotency_key_conflict' });
  });

  it('discloses the webhook URL in the arbitrary-mode verification email', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const env: Env = { ...baseEnv({ send }), DELIVERY_MODE: 'arbitrary' };
    await worker.fetch(
      new Request('https://api.conform.test/v1/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'owner@example.com',
          alias: 'Contact',
          delivery: { mode: 'webhook', webhook: { url: 'https://hooks.example.com/receiver' } },
        }),
      }),
      env,
      executionContext().ctx,
    );
    expect(send.mock.calls[0][0].text).toContain('https://hooks.example.com/receiver');
    expect(send.mock.calls[0][0].text).toContain('signed webhooks');
  });
});

describe('webhook delivery on submission', () => {
  it('delivers synchronously for webhook-only routes with valid signatures', async () => {
    const requests: string[] = [];
    const routes = new Map<string, StoredRouteRecord>();
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const env = baseEnv({ routes, requests, send });
    await installRoute(env, routes, { delivery: WEBHOOK_CONFIG });

    let captured: { headers: Record<string, string>; body: string } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        captured = {
          headers: headerRecord(init.headers),
          body: String(init.body),
        };
        return new Response(null, { status: 200 });
      }),
    );

    const response = await worker.fetch(
      submitRequest({ message: 'hello', email: 'ada@example.com' }),
      env,
      executionContext().ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivery: { webhook: 'delivered' } });
    expect(send).not.toHaveBeenCalled();
    expect(requests[0]?.endsWith('/reserve')).toBe(true);

    const event = JSON.parse(captured!.body) as Record<string, any>;
    expect(event.type).toBe('submission.received');
    expect(event.version).toBe('2026-07');
    expect(event.form_id).toBe(TEST_FORM_ID);
    expect(event.data.fields.message).toBe('hello');
    expect(event.data.reply_to).toBe('ada@example.com');
    expect(
      await verifySignature(
        WEBHOOK_CONFIG.webhook.secret,
        captured!.headers['webhook-id'],
        captured!.headers['webhook-timestamp'],
        captured!.body,
        captured!.headers['webhook-signature'],
      ),
    ).toBe(true);
  });

  it('rolls back quota and reports 502 when a webhook-only delivery fails', async () => {
    const requests: string[] = [];
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, requests });
    await installRoute(env, routes, { delivery: WEBHOOK_CONFIG });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 410 })));

    const response = await worker.fetch(
      submitRequest({ message: 'hello' }),
      env,
      executionContext().ctx,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: 'webhook_delivery_failed',
      retryable: true,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.endsWith('/rollback')).toBe(true);
  });

  it('answers immediately in both mode and fires the webhook in the background', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const env = baseEnv({ routes, send });
    await installRoute(env, routes, { delivery: { ...WEBHOOK_CONFIG, mode: 'both' } });
    const hook = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', hook);

    const { ctx, promises } = executionContext();
    const response = await worker.fetch(submitRequest({ message: 'hello' }), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      delivery: { email: 'delivered', webhook: 'queued' },
    });
    expect(send).toHaveBeenCalledOnce();
    await Promise.all(promises);
    expect(hook).toHaveBeenCalledOnce();
  });

  it('does not attempt the webhook when the authoritative email fails in both mode', async () => {
    const requests: string[] = [];
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({
      routes,
      requests,
      send: async () => {
        throw new Error('provider failure');
      },
    });
    await installRoute(env, routes, { delivery: { ...WEBHOOK_CONFIG, mode: 'both' } });
    const hook = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', hook);

    const { ctx, promises } = executionContext();
    const response = await worker.fetch(submitRequest({ message: 'hello' }), env, ctx);
    expect(response.status).toBe(503);
    await Promise.all(promises);
    expect(hook).not.toHaveBeenCalled();
    expect(requests[1]?.endsWith('/rollback')).toBe(true);
  });

  it('keeps version-1 email-only tokens working unchanged', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const env = baseEnv({ routes, send });
    await installRoute(env, routes);
    const response = await worker.fetch(
      submitRequest({ message: 'hello' }),
      env,
      executionContext().ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivery: { email: 'delivered' } });
    expect(send).toHaveBeenCalledOnce();
  });
});
