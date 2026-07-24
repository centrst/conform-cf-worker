import { ConfigError } from './errors';
import type { Env, QuotaReservation } from './types';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export class InboxQuota implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        month TEXT PRIMARY KEY,
        used INTEGER NOT NULL,
        limit_count INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = (await request.json()) as { limit?: number; month?: string };
    const month = body.month ?? currentMonth();

    if (url.pathname === '/reserve' && request.method === 'POST') {
      const limit = Number.isFinite(body.limit) ? Math.max(0, Math.floor(body.limit ?? 0)) : 0;
      if (limit === 0) return json({ allowed: true, used: 0, limit: 0, month });

      const rows = this.sql
        .exec<{ used: number; limit_count: number }>(
          `INSERT INTO usage (month, used, limit_count)
           SELECT ?1, 1, ?2
           WHERE ?2 > 0
           ON CONFLICT(month) DO UPDATE SET
             used = usage.used + 1,
             limit_count = excluded.limit_count
           WHERE usage.used < excluded.limit_count
           RETURNING used, limit_count`,
          month,
          limit,
        )
        .toArray();

      if (rows.length === 0) {
        const existing = this.sql
          .exec<{ used: number; limit_count: number }>(
            'SELECT used, limit_count FROM usage WHERE month = ?1',
            month,
          )
          .one();
        return json({
          allowed: false,
          used: existing?.used ?? limit,
          limit: existing?.limit_count ?? limit,
          month,
        });
      }

      return json({
        allowed: true,
        used: rows[0].used,
        limit: rows[0].limit_count,
        month,
      });
    }

    if (url.pathname === '/rollback' && request.method === 'POST') {
      this.sql.exec(
        'UPDATE usage SET used = MAX(0, used - 1) WHERE month = ?1',
        month,
      );
      return json({ rolledBack: true });
    }

    return json({ error: 'Not found' }, 404);
  }
}

async function quotaRequest(
  env: Env,
  ownerId: string,
  path: '/reserve' | '/rollback',
  body: { limit?: number; month?: string },
): Promise<Response> {
  if (!env.QUOTAS) {
    throw new ConfigError('QUOTAS binding is required when MONTHLY_LIMIT is enabled');
  }
  const id = env.QUOTAS.idFromName(ownerId);
  return env.QUOTAS.get(id).fetch(`https://quota.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function reserveQuota(
  env: Env,
  ownerId: string,
  limit: number,
): Promise<QuotaReservation> {
  const month = currentMonth();
  if (limit === 0) return { allowed: true, used: 0, limit: 0, month };
  const response = await quotaRequest(env, ownerId, '/reserve', { limit, month });
  if (!response.ok) throw new Error('Quota reservation failed');
  return (await response.json()) as QuotaReservation;
}

export async function rollbackQuota(
  env: Env,
  ownerId: string,
  month: string,
): Promise<void> {
  const response = await quotaRequest(env, ownerId, '/rollback', { month });
  if (!response.ok) throw new Error('Quota rollback failed');
}
