import { describe, expect, it } from 'vitest';
import worker from './index';
import { baseEnv, executionContext } from './test-support';
import type { Env, StoredRouteRecord } from './types';

const LOOKUP_SECRET = 'dashboard-account-lookup-secret';

function fetchWorker(request: Request, env: Env): Promise<Response> {
  return worker.fetch(request, env, executionContext().ctx);
}

function createRequest(email: string): Request {
  return new Request('https://api.conform.test/v1/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, alias: 'Contact' }),
  });
}

function lookupRequest(emails: string[], secret = LOOKUP_SECRET): Request {
  return new Request('https://api.conform.test/v1/account/routes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ emails }),
  });
}

describe('account route listing', () => {
  it('keeps creation account-free and lists only metadata for a matching verified email', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const ownerRoutes = new Map<string, Map<string, string>>();
    const env: Env = {
      ...baseEnv({ routes, ownerRoutes }),
      ACCOUNT_LOOKUP_SECRET: LOOKUP_SECRET,
      DELIVERY_MODE: 'arbitrary',
    };

    const createdResponse = await fetchWorker(createRequest('owner@example.com'), env);
    expect(createdResponse.status).toBe(202);
    const created = (await createdResponse.json()) as {
      form_id: string;
      management_token: string;
    };

    const listedResponse = await fetchWorker(lookupRequest(['owner@example.com']), env);
    expect(listedResponse.status).toBe(200);
    const listed = (await listedResponse.json()) as {
      routes: Array<Record<string, unknown>>;
    };
    expect(listed.routes).toEqual([
      expect.objectContaining({
        form_id: created.form_id,
        alias: 'Contact',
        status: 'pending_verification',
        endpoint: `https://api.conform.test/f/${created.form_id}`,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain('owner@example.com');
    expect(JSON.stringify(listed)).not.toContain(created.management_token);

    const otherAccount = await fetchWorker(lookupRequest(['other@example.com']), env);
    expect(await otherAccount.json()).toMatchObject({ success: true, routes: [] });
  });

  it('requires the optional trusted broker secret', async () => {
    const unavailable = await fetchWorker(
      lookupRequest(['owner@example.com']),
      baseEnv(),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: 'account_lookup_unavailable' });

    const unauthorized = await fetchWorker(
      lookupRequest(['owner@example.com'], 'wrong'),
      { ...baseEnv(), ACCOUNT_LOOKUP_SECRET: LOOKUP_SECRET },
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ error: 'account_lookup_unauthorized' });
  });

  it('lets a management-token holder index a route created before the account index existed', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const ownerRoutes = new Map<string, Map<string, string>>();
    const env: Env = {
      ...baseEnv({ routes, ownerRoutes }),
      ACCOUNT_LOOKUP_SECRET: LOOKUP_SECRET,
      DELIVERY_MODE: 'arbitrary',
    };
    const created = (await (
      await fetchWorker(createRequest('owner@example.com'), env)
    ).json()) as { form_id: string; management_token: string };
    ownerRoutes.clear();

    const before = await fetchWorker(lookupRequest(['owner@example.com']), env);
    expect(await before.json()).toMatchObject({ routes: [] });

    const claim = await fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${created.form_id}/claim`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.management_token}` },
      }),
      env,
    );
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({
      success: true,
      status: 'indexed',
      form_id: created.form_id,
    });

    const after = await fetchWorker(lookupRequest(['owner@example.com']), env);
    expect(await after.json()).toMatchObject({
      routes: [expect.objectContaining({ form_id: created.form_id })],
    });
  });
});
