import type { Env, StoredRouteRecord } from './types';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export class FormRoute implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState) {
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
      }>(
        `SELECT form_id, alias, owner_id, encrypted_route, status,
                destination_id, created_at
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
    };
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
          destination_id, created_at
        ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        route.formId,
        route.alias,
        route.ownerId,
        route.encryptedRoute,
        route.status,
        route.destinationId ?? null,
        route.createdAt,
      );
      return cursor.rowsWritten === 1
        ? json(route, 201)
        : json({ error: 'Form ID already exists' }, 409);
    }

    if (request.method === 'POST' && url.pathname === '/activate') {
      const cursor = this.sql.exec(
        `UPDATE route
         SET status = 'active'
         WHERE singleton = 1`,
      );
      const route = this.read();
      return cursor.rowsWritten > 0 && route
        ? json(route)
        : json({ error: 'Route not found' }, 404);
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
