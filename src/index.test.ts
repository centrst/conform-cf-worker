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
