import type { Env, RouteAccessKey, StoredRouteRecord } from './types';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

// Routes that never verify are deleted by a Durable Object alarm after this
// window. Generous on purpose: arbitrary-mode tokens die at 24h, but a
// verified-mode human can be slow to click Cloudflare's email.
const PENDING_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How many recent keys a route keeps when none of them has proved itself yet.
 * A window rather than a guess: the object cannot know which key a deploy
 * shipped, so it keeps enough that a run of failed builds cannot evict the one
 * the live site is serving. The window collapses the moment any key is
 * accepted -- see the accept handler, which retires everything older.
 */
const MAX_LIVE_KEYS = 5;

export class FormRoute implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
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
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS owner_route (
        form_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS access_key (
        key_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT
      )
    `);
    const columns = this.sql.exec<{ name: string }>(`PRAGMA table_info(route)`).toArray();
    if (!columns.some((column) => column.name === 'request_hash')) {
      this.sql.exec(`ALTER TABLE route ADD COLUMN request_hash TEXT`);
    }
    if (!columns.some((column) => column.name === 'quota_key')) {
      this.sql.exec(`ALTER TABLE route ADD COLUMN quota_key TEXT`);
    }
    if (!columns.some((column) => column.name === 'require_key')) {
      this.sql.exec(`ALTER TABLE route ADD COLUMN require_key INTEGER NOT NULL DEFAULT 0`);
    }
  }

  /**
   * Newest first, so the head is the current key and the tail the superseded
   * one. Ordered by a sequence the object assigns, not by the timestamp: two
   * builds can mint inside the same millisecond, and then a clock cannot say
   * which key supersedes which.
   */
  private keys(): RouteAccessKey[] {
    return this.sql
      .exec<{
        key_id: string;
        seq: number;
        hash: string;
        created_at: string;
        used_at: string | null;
      }>(
        `SELECT key_id, seq, hash, created_at, used_at
         FROM access_key
         ORDER BY seq DESC`,
      )
      .toArray()
      .map((row) => ({
        keyId: row.key_id,
        seq: row.seq,
        hash: row.hash,
        createdAt: row.created_at,
        ...(row.used_at ? { usedAt: row.used_at } : {}),
      }));
  }

  private read(): StoredRouteRecord | null {
    const rows = this.sql
      .exec<{
        form_id: string;
        alias: string;
        owner_id: string;
        encrypted_route: string;
        status: 'pending' | 'active';
        destination_id: string | null;
        created_at: string;
        request_hash: string | null;
        quota_key: string | null;
        require_key: number | null;
      }>(
        `SELECT form_id, alias, owner_id, encrypted_route, status,
                destination_id, created_at, request_hash, quota_key, require_key
         FROM route
         WHERE singleton = 1`,
      )
      .toArray();
    const row = rows[0];
    if (!row) return null;
    return {
      formId: row.form_id,
      alias: row.alias,
      ownerId: row.owner_id,
      encryptedRoute: row.encrypted_route,
      status: row.status,
      destinationId: row.destination_id ?? undefined,
      createdAt: row.created_at,
      requestHash: row.request_hash ?? undefined,
      quotaKey: row.quota_key ?? undefined,
      accessKeys: this.keys(),
      requireKey: row.require_key ? true : undefined,
    };
  }

  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    // Keep the schema intact for this warm Durable Object instance. Cloudflare
    // can route another request to the same instance after deleteAll(), but the
    // constructor does not rerun, leaving read() with no route table and
    // turning the documented post-delete 404 into a 500.
    this.sql.exec(`DELETE FROM route WHERE singleton = 1`);
    this.sql.exec(`DELETE FROM access_key`);
  }

  async alarm(): Promise<void> {
    const route = this.read();
    if (route && route.status === 'pending') {
      await this.destroy();
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      const route = this.read();
      return route ? json(route) : json({ error: 'Route not found' }, 404);
    }

    if (request.method === 'POST' && url.pathname === '/create') {
      const route = (await request.json()) as StoredRouteRecord;
      const cursor = this.sql.exec(
        `INSERT OR IGNORE INTO route (
          singleton, form_id, alias, owner_id, encrypted_route, status,
          destination_id, created_at, request_hash, quota_key, require_key
        ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        route.formId,
        route.alias,
        route.ownerId,
        route.encryptedRoute,
        route.status,
        route.destinationId ?? null,
        route.createdAt,
        route.requestHash ?? null,
        route.quotaKey ?? null,
        route.requireKey ? 1 : 0,
      );
      if (cursor.rowsWritten !== 1) {
        return json({ error: 'Form ID already exists' }, 409);
      }
      if (route.status === 'pending') {
        await this.ctx.storage.setAlarm(Date.now() + PENDING_ROUTE_TTL_MS);
      }
      return json(route, 201);
    }

    if (request.method === 'POST' && url.pathname === '/activate') {
      const cursor = this.sql.exec(
        `UPDATE route
         SET status = 'active'
         WHERE singleton = 1`,
      );
      const route = this.read();
      if (cursor.rowsWritten > 0 && route) {
        await this.ctx.storage.deleteAlarm();
        return json(route);
      }
      return json({ error: 'Route not found' }, 404);
    }

    if (request.method === 'POST' && url.pathname === '/delete') {
      const route = this.read();
      if (!route) return json({ error: 'Route not found' }, 404);
      await this.destroy();
      return json({ deleted: true });
    }

    if (request.method === 'GET' && url.pathname === '/keys') {
      if (!this.read()) return json({ error: 'Route not found' }, 404);
      return json({ keys: this.keys() });
    }

    if (request.method === 'POST' && url.pathname === '/keys/mint') {
      if (!this.read()) return json({ error: 'Route not found' }, 404);
      const key = (await request.json()) as RouteAccessKey;
      this.sql.exec(
        `INSERT INTO access_key (key_id, seq, hash, created_at)
         SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3 FROM access_key`,
        key.keyId,
        key.hash,
        key.createdAt,
      );
      // Keep the newest few keys, plus the newest key that has been accepted.
      //
      // An earlier version kept exactly two by guessing which key was live:
      // the newest, and the newest *used*, falling back to the second-newest
      // when nothing had been used. `usedAt` is a bad proxy for "deployed" and
      // it fails in both directions. It lags -- a key that shipped to a
      // low-traffic form nobody has submitted to yet looks abandoned, so two
      // further builds evicted the only key any browser was carrying. And it
      // leads -- a visitor on a page cached before a deploy marks the OLD key
      // used, promoting it over the one the deploy actually shipped.
      //
      // Both states are reachable from the documented workflow (mint on every
      // build), and the dry run makes the first one permanent, since a dry run
      // deliberately never marks a key used. So the object stops guessing: it
      // keeps a bounded window of recent keys, and retirement happens where
      // there is real evidence -- on accept, below.
      this.sql.exec(
        `DELETE FROM access_key
         WHERE key_id NOT IN (
           SELECT key_id FROM access_key ORDER BY seq DESC LIMIT ?1
         )
         AND key_id NOT IN (
           SELECT key_id FROM access_key WHERE used_at IS NOT NULL
           ORDER BY seq DESC LIMIT 1
         )`,
        MAX_LIVE_KEYS,
      );
      return json({ keys: this.keys() }, 201);
    }

    if (request.method === 'POST' && url.pathname === '/keys/accept') {
      const body = (await request.json()) as { keyId: string };
      const rows = this.sql
        .exec<{ seq: number; used_at: string | null }>(
          `SELECT seq, used_at FROM access_key WHERE key_id = ?1`,
          body.keyId,
        )
        .toArray();
      const row = rows[0];
      if (!row) return json({ accepted: false }, 404);
      if (row.used_at) return json({ accepted: true, retired: 0 });
      this.sql.exec(
        `UPDATE access_key SET used_at = ?2 WHERE key_id = ?1`,
        body.keyId,
        new Date().toISOString(),
      );
      // A key proving itself is what retires its predecessors -- not a clock.
      // Keys newer than this one survive: an old key still in a cached page
      // must not evict the one a deploy just shipped.
      const retired = this.sql.exec(
        `DELETE FROM access_key WHERE seq < ?1`,
        row.seq,
      ).rowsWritten;
      return json({ accepted: true, retired });
    }

    if (request.method === 'POST' && url.pathname === '/settings') {
      const body = (await request.json()) as {
        requireKey?: boolean;
        encryptedRoute?: string;
      };
      if (!this.read()) return json({ error: 'Route not found' }, 404);
      if (body.requireKey !== undefined) {
        this.sql.exec(
          `UPDATE route SET require_key = ?1 WHERE singleton = 1`,
          body.requireKey ? 1 : 0,
        );
      }
      // A schema lives inside the sealed payload, so changing one arrives here
      // as a replacement payload rather than as a field of its own.
      if (body.encryptedRoute) {
        this.sql.exec(
          `UPDATE route SET encrypted_route = ?1 WHERE singleton = 1`,
          body.encryptedRoute,
        );
      }
      return json(this.read());
    }

    if (request.method === 'GET' && url.pathname === '/owner-routes') {
      const routes = this.sql
        .exec<{ form_id: string; created_at: string }>(
          `SELECT form_id, created_at
           FROM owner_route
           ORDER BY created_at DESC`,
        )
        .toArray()
        .map((row) => ({ formId: row.form_id, createdAt: row.created_at }));
      return json({ routes });
    }

    if (request.method === 'POST' && url.pathname === '/owner-routes/add') {
      const route = (await request.json()) as { formId: string; createdAt: string };
      this.sql.exec(
        `INSERT INTO owner_route (form_id, created_at)
         VALUES (?1, ?2)
         ON CONFLICT(form_id) DO UPDATE SET created_at = excluded.created_at`,
        route.formId,
        route.createdAt,
      );
      return json({ indexed: true });
    }

    if (request.method === 'POST' && url.pathname === '/owner-routes/remove') {
      const route = (await request.json()) as { formId: string };
      this.sql.exec(`DELETE FROM owner_route WHERE form_id = ?1`, route.formId);
      return json({ removed: true });
    }

    return json({ error: 'Not found' }, 404);
  }
}

function routeStub(env: Env, formId: string): DurableObjectStub {
  return env.ROUTES.get(env.ROUTES.idFromName(formId));
}

export async function createStoredRoute(
  env: Env,
  route: StoredRouteRecord,
): Promise<boolean> {
  const response = await routeStub(env, route.formId).fetch(
    'https://route.internal/create',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(route),
    },
  );
  if (response.status === 409) return false;
  if (!response.ok) throw new Error('Route creation failed');
  return true;
}

export async function getStoredRoute(
  env: Env,
  formId: string,
): Promise<StoredRouteRecord | null> {
  const response = await routeStub(env, formId).fetch('https://route.internal/');
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Route lookup failed');
  return (await response.json()) as StoredRouteRecord;
}

export async function activateStoredRoute(
  env: Env,
  formId: string,
): Promise<StoredRouteRecord | null> {
  const response = await routeStub(env, formId).fetch(
    'https://route.internal/activate',
    { method: 'POST' },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Route activation failed');
  return (await response.json()) as StoredRouteRecord;
}

export async function mintStoredAccessKey(
  env: Env,
  formId: string,
  key: RouteAccessKey,
): Promise<RouteAccessKey[] | null> {
  const response = await routeStub(env, formId).fetch('https://route.internal/keys/mint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(key),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Access key mint failed');
  return ((await response.json()) as { keys: RouteAccessKey[] }).keys;
}

/**
 * Records that a key was accepted on a submission. The first acceptance is
 * what retires the keys it superseded, so this runs on the delivery path --
 * but only when the key has not been marked used, so the steady state is a
 * plain read with no extra write.
 */
export async function acceptStoredAccessKey(
  env: Env,
  formId: string,
  keyId: string,
): Promise<void> {
  await routeStub(env, formId).fetch('https://route.internal/keys/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyId }),
  });
}

export async function updateStoredRouteSettings(
  env: Env,
  formId: string,
  settings: { requireKey?: boolean; encryptedRoute?: string },
): Promise<StoredRouteRecord | null> {
  const response = await routeStub(env, formId).fetch('https://route.internal/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Route settings update failed');
  return (await response.json()) as StoredRouteRecord;
}

export async function deleteStoredRoute(env: Env, formId: string): Promise<boolean> {
  const response = await routeStub(env, formId).fetch('https://route.internal/delete', {
    method: 'POST',
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error('Route deletion failed');
  return true;
}

function ownerRouteStub(env: Env, ownerId: string): DurableObjectStub {
  return env.ROUTES.get(env.ROUTES.idFromName(`owner:${ownerId}`));
}

export async function indexStoredRoute(
  env: Env,
  ownerId: string,
  formId: string,
  createdAt: string,
): Promise<void> {
  const response = await ownerRouteStub(env, ownerId).fetch(
    'https://route.internal/owner-routes/add',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formId, createdAt }),
    },
  );
  if (!response.ok) throw new Error('Route indexing failed');
}

export async function listStoredRouteIds(
  env: Env,
  ownerId: string,
): Promise<Array<{ formId: string; createdAt: string }>> {
  const response = await ownerRouteStub(env, ownerId).fetch(
    'https://route.internal/owner-routes',
  );
  if (!response.ok) throw new Error('Route index lookup failed');
  const body = (await response.json()) as {
    routes: Array<{ formId: string; createdAt: string }>;
  };
  return body.routes;
}

export async function unindexStoredRoute(
  env: Env,
  ownerId: string,
  formId: string,
): Promise<void> {
  const response = await ownerRouteStub(env, ownerId).fetch(
    'https://route.internal/owner-routes/remove',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formId }),
    },
  );
  if (!response.ok) throw new Error('Route index removal failed');
}
