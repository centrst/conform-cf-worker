import { describe, expect, it } from 'vitest';
import { KEY_LIFECYCLE_CASES } from './key-lifecycle-cases';
import { routeNamespace } from './test-support';
import type { RouteAccessKey, StoredRouteRecord } from './types';

/**
 * The same cases as key-lifecycle.workers.test.ts, against the fake Durable
 * Object the node suite runs on. If these two files disagree, the fake is
 * lying to every other test in the node suite.
 */

const FORM_ID = 'cfm_ABCDEFGHJKLMNPQR';

async function run(ops: string[]): Promise<string[]> {
  const records = new Map<string, StoredRouteRecord>([
    [
      FORM_ID,
      {
        formId: FORM_ID,
        alias: 'Contact',
        ownerId: 'opaque-owner',
        encryptedRoute: 'sealed',
        status: 'active',
        createdAt: '2026-08-18T00:00:00.000Z',
      },
    ],
  ]);
  const namespace = routeNamespace(records);
  const stub = namespace.get(namespace.idFromName(FORM_ID));

  for (const op of ops) {
    const keyId = op.slice(1);
    const path = op.startsWith('+') ? '/keys/mint' : '/keys/accept';
    const body = op.startsWith('+')
      ? { keyId, hash: `hash-${keyId}`, createdAt: '2026-08-18T00:00:00.000Z' }
      : { keyId };
    await stub.fetch(`https://route.internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const listed = (await (
    await stub.fetch('https://route.internal/keys')
  ).json()) as { keys: RouteAccessKey[] };
  return listed.keys.map((key) => key.keyId);
}

describe('key lifecycle — fake Durable Object', () => {
  for (const testCase of KEY_LIFECYCLE_CASES) {
    it(testCase.name, async () => {
      expect(await run(testCase.ops)).toEqual(testCase.expect);
    });
  }
});
