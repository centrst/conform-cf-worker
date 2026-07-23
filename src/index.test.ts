import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { sealToken } from './index';
import type {
  EmailMessageBuilder,
  Env,
  QuotaReservation,
  RouteTokenPayload,
} from './types';

function secret(fill: number): string {
  const bytes = new Uint8Array(32);
  bytes.fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function executionContext() {
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

function quotaNamespace(
  reservation: QuotaReservation,
  requests: string[],
): DurableObjectNamespace {
  return {
    idFromName() {
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

function baseEnv(options?: {
  reservation?: QuotaReservation;
  send?: (message: EmailMessageBuilder) => Promise<{ messageId: string }>;
  requests?: string[];
}): Env {
  const requests = options?.requests ?? [];
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
    ),
    DELIVERY_MODE: 'verified',
    MONTHLY_LIMIT: '250',
    FROM_EMAIL: 'forms@conform.test',
    FROM_NAME: 'Conform',
    PUBLIC_URL: 'https://api.conform.test',
    SOURCE_COMMIT: 'abc123',
    ROUTE_TOKEN_SECRET: secret(1),
    OWNER_HASH_SECRET: secret(2),
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_API_TOKEN: 'api-token',
  };
}

async function routeToken(env: Env): Promise<string> {
  const payload: RouteTokenPayload = {
    kind: 'route',
    version: 1,
    ownerId: 'opaque-owner',
    routeId: 'route-id',
    email: 'owner@example.com',
    formName: 'Contact',
    issuedAt: Date.now(),
  };
  return sealToken(payload, env.ROUTE_TOKEN_SECRET);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conform worker', () => {
  it('publishes its exact source version and storage boundary', async () => {
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
      new_route_destination_email_in_quota_or_route_storage: false,
      legacy_destination_records: 'not_bound',
      quota: ['opaque inbox id', 'UTC month', 'used count', 'limit'],
    });
  });

  it('registers a verified inbox and returns a stateless endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
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
      ),
    );
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request('https://api.conform.test/v1/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com', form_name: 'Contact' }),
      }),
      baseEnv(),
      ctx,
    );
    const body = (await response.json()) as {
      status: string;
      endpoint: string;
    };
    expect(response.status).toBe(201);
    expect(body.status).toBe('active');
    expect(body.endpoint).toMatch(/^https:\/\/api\.conform\.test\/f\/cf1\.r\./u);
    expect(body.endpoint).not.toContain('owner@example.com');
  });

  it('contains the arbitrary-recipient fallback and activates only after confirmation', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({
      messageId: 'verification-message',
    }));
    const env = {
      ...baseEnv({ send }),
      DELIVERY_MODE: 'arbitrary' as const,
    };
    const { ctx } = executionContext();
    const registration = await worker.fetch(
      new Request('https://api.conform.test/v1/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com', form_name: 'Contact' }),
      }),
      env,
      ctx,
    );
    expect(registration.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();

    const verificationText = send.mock.calls[0]?.[0].text ?? '';
    const verificationUrl = verificationText.match(
      /https:\/\/api\.conform\.test\/v1\/routes\/verify\?token=[^\s]+/u,
    )?.[0];
    expect(verificationUrl).toBeTruthy();
    const pendingToken = new URL(verificationUrl as string).searchParams.get('token');
    expect(pendingToken).toBeTruthy();

    const confirmation = await worker.fetch(
      new Request('https://api.conform.test/v1/routes/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: pendingToken as string }),
      }),
      env,
      ctx,
    );
    const body = (await confirmation.json()) as { status: string; endpoint: string };
    expect(body.status).toBe('active');
    expect(body.endpoint).toMatch(/^https:\/\/api\.conform\.test\/f\/cf1\.r\./u);
  });

  it('reserves shared inbox quota before delivering the form as text', async () => {
    const requests: string[] = [];
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'message-id' }));
    const env = baseEnv({ send, requests });
    const token = await routeToken(env);
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request(`https://api.conform.test/f/${token}`, {
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
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'message-id' }));
    const env = baseEnv({
      send,
      reservation: {
        allowed: false,
        used: 250,
        limit: 250,
        month: '2026-07',
      },
    });
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request(`https://api.conform.test/f/${await routeToken(env)}`, {
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
    const env = baseEnv({
      requests,
      send: async () => {
        throw new Error('provider failure');
      },
    });
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request(`https://api.conform.test/f/${await routeToken(env)}`, {
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

  it('drops honeypot submissions without consuming quota or sending', async () => {
    const requests: string[] = [];
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'message-id' }));
    const env = baseEnv({ requests, send });
    const { ctx } = executionContext();
    const response = await worker.fetch(
      new Request(`https://api.conform.test/f/${await routeToken(env)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'spam', _gotcha: 'bot' }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
});
