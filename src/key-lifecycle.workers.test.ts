import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { KEY_LIFECYCLE_CASES } from './key-lifecycle-cases';
import type { RouteAccessKey, StoredRouteRecord } from './types';

declare global {
  namespace Cloudflare {
    interface Env {
      ROUTES: DurableObjectNamespace;
    }
  }
}

/**
 * The key lifecycle against the real Durable Object and real SQL.
 *
 * Its twin, key-lifecycle.test.ts, drives the identical cases through the fake
 * the node suite uses. Both must agree, because the flagship tests for this
 * feature used to assert against the fake alone — so the fake and the prose
 * agreed with each other while the SQL quietly did something else.
 */

let counter = 0;

async function freshRoute(): Promise<DurableObjectStub> {
  counter += 1;
  const formId = `cfm_LIFE${String(counter).padStart(12, '0')}`;
  const stub = env.ROUTES.get(env.ROUTES.idFromName(formId));
  await stub.fetch('https://route.internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      formId,
      alias: 'Contact',
      ownerId: 'opaque-owner',
      encryptedRoute: 'sealed',
      status: 'active',
      createdAt: '2026-08-18T00:00:00.000Z',
    } satisfies StoredRouteRecord),
  });
  return stub;
}

async function run(ops: string[]): Promise<string[]> {
  const stub = await freshRoute();
  for (const op of ops) {
    const keyId = op.slice(1);
    if (op.startsWith('+')) {
      await stub.fetch('https://route.internal/keys/mint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyId,
          hash: `hash-${keyId}`,
          createdAt: '2026-08-18T00:00:00.000Z',
        }),
      });
    } else {
      await stub.fetch('https://route.internal/keys/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId }),
      });
    }
  }
  const body = (await (await stub.fetch('https://route.internal/keys')).json()) as {
    keys: RouteAccessKey[];
  };
  return body.keys.map((key) => key.keyId);
}

describe('key lifecycle — real Durable Object', () => {
  for (const testCase of KEY_LIFECYCLE_CASES) {
    it(testCase.name, async () => {
      expect(await run(testCase.ops)).toEqual(testCase.expect);
    });
  }
});
