import { describe, expect, it, vi } from 'vitest';
import { FormRoute } from './routes';
import type { StoredRouteRecord } from './types';

interface FakeRow {
  form_id: string;
  alias: string;
  owner_id: string;
  encrypted_route: string;
  status: 'pending' | 'active';
  destination_id: string | null;
  created_at: string;
  request_hash: string | null;
  quota_key: string | null;
  require_key: number;
}

function cursor<T extends Record<string, SqlStorageValue>>(
  rows: T[] = [],
  rowsWritten = 0,
): SqlStorageCursor<T> {
  return {
    columnNames: [],
    rowsRead: rows.length,
    rowsWritten,
    toArray: () => rows,
    raw: () => rows.map((row) => Object.values(row as Record<string, unknown>)),
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  } as unknown as SqlStorageCursor<T>;
}

function durableObjectState() {
  let tableExists = false;
  let row: FakeRow | null = null;

  const sql = {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...params: unknown[]) {
      const statement = query.replace(/\s+/gu, ' ').trim().toUpperCase();
      if (statement.startsWith('CREATE TABLE')) {
        tableExists = true;
        return cursor<T>();
      }
      if (!tableExists) throw new Error('no such table: route');
      if (statement.startsWith('PRAGMA TABLE_INFO')) {
        return cursor<T>(
          [
            { name: 'request_hash' },
            { name: 'quota_key' },
            { name: 'require_key' },
          ] as unknown as T[],
        );
      }
      if (statement.startsWith('SELECT')) {
        return cursor<T>((row ? [row] : []) as unknown as T[]);
      }
      if (statement.startsWith('INSERT')) {
        if (row) return cursor<T>([], 0);
        row = {
          form_id: String(params[0]),
          alias: String(params[1]),
          owner_id: String(params[2]),
          encrypted_route: String(params[3]),
          status: params[4] as FakeRow['status'],
          destination_id: params[5] === null ? null : String(params[5]),
          created_at: String(params[6]),
          request_hash: params[7] === null ? null : String(params[7]),
          quota_key: params[8] === null ? null : String(params[8]),
          require_key: Number(params[9] ?? 0),
        };
        return cursor<T>([], 1);
      }
      if (statement.startsWith('DELETE FROM ROUTE')) {
        const rowsWritten = row ? 1 : 0;
        row = null;
        return cursor<T>([], rowsWritten);
      }
      if (statement.startsWith('DELETE FROM ACCESS_KEY')) {
        return cursor<T>([], 0);
      }
      throw new Error(`Unexpected SQL in test: ${statement}`);
    },
  } as SqlStorage;

  const deleteAll = vi.fn(async () => {
    // Cloudflare clears SQLite tables as well as rows. The same warm Durable
    // Object instance can then receive another request without rerunning its
    // constructor, which exposed the production post-delete 500.
    tableExists = false;
    row = null;
  });
  const storage = {
    sql,
    deleteAlarm: vi.fn(async () => undefined),
    deleteAll,
    setAlarm: vi.fn(async () => undefined),
  } as unknown as DurableObjectStorage;

  return {
    state: { storage } as unknown as DurableObjectState,
    deleteAll,
  };
}

describe('FormRoute deletion', () => {
  it('keeps the schema available so a warm post-delete lookup returns 404', async () => {
    const { state, deleteAll } = durableObjectState();
    const object = new FormRoute(state);
    const route: StoredRouteRecord = {
      formId: 'cfm_ABCDEFGHJKLMNPQR',
      alias: 'Contact',
      ownerId: 'opaque-owner',
      encryptedRoute: 'encrypted',
      status: 'active',
      createdAt: '2026-07-26T00:00:00.000Z',
    };

    expect(
      (
        await object.fetch(
          new Request('https://route.internal/create', {
            method: 'POST',
            body: JSON.stringify(route),
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (await object.fetch(new Request('https://route.internal/delete', { method: 'POST' }))).status,
    ).toBe(200);

    const afterDelete = await object.fetch(new Request('https://route.internal/'));
    expect(afterDelete.status).toBe(404);
    expect(deleteAll).not.toHaveBeenCalled();
  });
});
