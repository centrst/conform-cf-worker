import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { RouteAccessKey, StoredRouteRecord } from './types';

declare global {
  namespace Cloudflare {
    interface Env {
      ROUTES: DurableObjectNamespace;
    }
  }
}

/**
 * Exercises the real FormRoute Durable Object on real Durable Object storage.
 *
 * The node suites drive a fake SqlStorage that whitelists statements by prefix,
 * so a malformed query passes there and fails only in production. The key
 * retirement rules are almost entirely SQL — "keep the newest key and the
 * newest used key", "retire everything older than the key that just proved
 * itself" — which means a fake proves nothing about them.
 */

let counter = 0;
function freshRoute(): { stub: DurableObjectStub; formId: string } {
  counter += 1;
  const formId = `cfm_ROUTE${String(counter).padStart(11, '0')}`;
  return { stub: env.ROUTES.get(env.ROUTES.idFromName(formId)), formId };
}

function record(formId: string, requireKey = false): StoredRouteRecord {
  return {
    formId,
    alias: 'Contact',
    ownerId: 'opaque-owner',
    encryptedRoute: 'sealed',
    status: 'active',
    createdAt: '2026-08-18T00:00:00.000Z',
    requireKey,
  };
}

async function call(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return stub.fetch(`https://route.internal${path}`, init);
}

async function post(
  stub: DurableObjectStub,
  path: string,
  body: unknown,
): Promise<Response> {
  return call(stub, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function key(id: string, createdAt: string, usedAt?: string): RouteAccessKey {
  return { keyId: id, hash: `hash-${id}`, createdAt, ...(usedAt ? { usedAt } : {}) };
}

async function keyIds(stub: DurableObjectStub): Promise<string[]> {
  const body = (await (await call(stub, '/keys')).json()) as { keys: RouteAccessKey[] };
  return body.keys.map((entry) => entry.keyId);
}

async function create(requireKey = false) {
  const { stub, formId } = freshRoute();
  await post(stub, '/create', record(formId, requireKey));
  return { stub, formId };
}

describe('FormRoute access keys', () => {
  it('lists the newest key first', async () => {
    const { stub } = await create();
    await post(stub, '/keys/mint', key('OLD', '2026-08-01T00:00:00.000Z'));
    await post(stub, '/keys/mint', key('NEW', '2026-08-02T00:00:00.000Z'));

    expect(await keyIds(stub)).toEqual(['NEW', 'OLD']);
  });

  // Retention as a whole is pinned by key-lifecycle.workers.test.ts, which runs
  // the same cases through the fake the node suite uses. What is left here is
  // the SQL those cases cannot reach.

  it('retires older keys only when a successor is first accepted', async () => {
    const { stub } = await create();
    await post(stub, '/keys/mint', key('FIRST', '2026-08-01T00:00:00.000Z'));
    await post(stub, '/keys/accept', { keyId: 'FIRST' });
    await post(stub, '/keys/mint', key('SECOND', '2026-08-02T00:00:00.000Z'));

    // Minting alone changes nothing: a cached page still carries FIRST.
    expect(await keyIds(stub)).toEqual(['SECOND', 'FIRST']);

    const accepted = (await (
      await post(stub, '/keys/accept', { keyId: 'SECOND' })
    ).json()) as { retired: number };

    expect(accepted.retired).toBe(1);
    expect(await keyIds(stub)).toEqual(['SECOND']);
  });

  it('does not let a stale key retire the one a deploy just shipped', async () => {
    const { stub } = await create();
    await post(stub, '/keys/mint', key('OLD', '2026-08-01T00:00:00.000Z'));
    await post(stub, '/keys/mint', key('NEW', '2026-08-02T00:00:00.000Z'));

    // A visitor on a cached page submits with the older key.
    await post(stub, '/keys/accept', { keyId: 'OLD' });

    expect(await keyIds(stub)).toEqual(['NEW', 'OLD']);
  });

  it('marks first use once and reports nothing retired on later uses', async () => {
    const { stub } = await create();
    await post(stub, '/keys/mint', key('ONLY', '2026-08-01T00:00:00.000Z'));

    const first = (await (await post(stub, '/keys/accept', { keyId: 'ONLY' })).json()) as {
      retired: number;
    };
    const second = (await (await post(stub, '/keys/accept', { keyId: 'ONLY' })).json()) as {
      retired: number;
    };

    expect(first.retired).toBe(0);
    expect(second.retired).toBe(0);
    const body = (await (await call(stub, '/keys')).json()) as { keys: RouteAccessKey[] };
    expect(body.keys[0].usedAt).toBeTruthy();
  });

  it('orders supersession by mint order even when timestamps tie', async () => {
    const { stub } = await create();
    const tie = '2026-08-18T00:00:00.000Z';
    // Two builds minting inside the same millisecond is rare and entirely
    // possible. A clock cannot order these; the object's own sequence can.
    await post(stub, '/keys/mint', key('FIRST', tie));
    await post(stub, '/keys/mint', key('SECOND', tie));

    expect(await keyIds(stub)).toEqual(['SECOND', 'FIRST']);

    const accepted = (await (
      await post(stub, '/keys/accept', { keyId: 'SECOND' })
    ).json()) as { retired: number };

    expect(accepted.retired).toBe(1);
    expect(await keyIds(stub)).toEqual(['SECOND']);
  });

  it('does not let an older key retire a newer one that shares its timestamp', async () => {
    const { stub } = await create();
    const tie = '2026-08-18T00:00:00.000Z';
    await post(stub, '/keys/mint', key('FIRST', tie));
    await post(stub, '/keys/mint', key('SECOND', tie));

    await post(stub, '/keys/accept', { keyId: 'FIRST' });

    expect(await keyIds(stub)).toEqual(['SECOND', 'FIRST']);
  });

  it('reports an unknown key rather than inventing one', async () => {
    const { stub } = await create();
    const response = await post(stub, '/keys/accept', { keyId: 'MISSING' });
    expect(response.status).toBe(404);
  });

  it('persists require_key and returns it on the route record', async () => {
    const { stub } = await create();
    await post(stub, '/keys/mint', key('ONLY', '2026-08-01T00:00:00.000Z'));

    await post(stub, '/settings', { requireKey: true });
    const enabled = (await (await call(stub, '/')).json()) as StoredRouteRecord;
    expect(enabled.requireKey).toBe(true);
    expect(enabled.accessKeys).toHaveLength(1);

    await post(stub, '/settings', { requireKey: false });
    const disabled = (await (await call(stub, '/')).json()) as StoredRouteRecord;
    expect(disabled.requireKey).toBeUndefined();
  });

  it('drops keys with the route, so a reused form ID cannot inherit them', async () => {
    const { stub, formId } = await create();
    await post(stub, '/keys/mint', key('ONLY', '2026-08-01T00:00:00.000Z'));
    await post(stub, '/delete', {});

    await post(stub, '/create', record(formId));
    expect(await keyIds(stub)).toEqual([]);
  });

  it('survives a cold start against a table created before keys existed', async () => {
    const { stub, formId } = freshRoute();
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS route (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          form_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          encrypted_route TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
          destination_id TEXT,
          created_at TEXT NOT NULL
        )
      `);
      state.storage.sql.exec(
        `INSERT INTO route (singleton, form_id, alias, owner_id, encrypted_route, status, created_at)
         VALUES (1, ?1, 'Contact', 'opaque-owner', 'sealed', 'active', '2026-08-18T00:00:00.000Z')`,
        formId,
      );
    });

    // A fresh stub reruns the constructor, which is where the migration lives.
    const migrated = env.ROUTES.get(env.ROUTES.idFromName(formId));
    const stored = (await (await call(migrated, '/')).json()) as StoredRouteRecord;

    expect(stored.formId).toBe(formId);
    expect(stored.requireKey).toBeUndefined();
    expect(stored.accessKeys).toEqual([]);
  });
});
