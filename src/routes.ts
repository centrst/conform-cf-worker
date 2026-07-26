import type { Env, StoredRouteRecord } from './types';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

// Routes that never verify are deleted by a Durable Object alarm after this
// window. Generous on purpose: arbitrary-mode tokens die at 24h, but a
// verified-mode human can be slow to click Cloudflare's email.
const PENDING_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    const columns = this.sql.exec<{ name: string }>(`PRAGMA table_info(route)`).toArray();
    if (!columns.some((column) => column.name === 'request_hash')) {
      this.sql.exec(`ALTER TABLE route ADD COLUMN request_hash TEXT`);
    }
    if (!columns.some((column) => column.name === 'quota_key')) {
      this.sql.exec(`ALTER TABLE route ADD COLUMN quota_key TEXT`);
    }
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
      }>(
        `SELECT form_id, alias, owner_id, encrypted_route, status,
                destination_id, created_at, request_hash, quota_key
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
    };
  }

  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    // Keep the schema intact for this warm Durable Object instance. Cloudflare
    // can route another request to the same instance after deleteAll(), but the
    // constructor does not rerun, leaving read() with no route table and
    // turning the documented post-delete 404 into a 500.
    this.sql.exec(`DELETE FROM route WHERE singleton = 1`);
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
          destination_id, created_at, request_hash, quota_key
        ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        route.formId,
        route.alias,
        route.ownerId,
        route.encryptedRoute,
        route.status,
        route.destinationId ?? null,
        route.createdAt,
        route.requestHash ?? null,
        route.quotaKey ?? null,
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
