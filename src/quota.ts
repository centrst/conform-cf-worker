import { ConfigError } from './errors';
import type { Env, QuotaReservation } from './types';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** The count at which the "running low" warning is due. */
export function lowMark(limit: number): number {
  return Math.max(1, Math.ceil(limit * 0.8));
}

/**
 * Creates the usage table, and adds the warning-mark columns to namespaces that
 * predate them. Runs from the constructor, so every inbox migrates on its next
 * cold start — which a code deploy guarantees, since it restarts the objects.
 *
 * Exported so the migration path can be tested against a table in the old
 * shape. A warm instance never re-runs its constructor, so that case cannot be
 * reached by driving the object through fetch alone.
 */
export function ensureSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      month TEXT PRIMARY KEY,
      used INTEGER NOT NULL,
      limit_count INTEGER NOT NULL,
      warned_low INTEGER NOT NULL DEFAULT 0,
      warned_full INTEGER NOT NULL DEFAULT 0
    )
  `);
  const columns = new Set(
    [...sql.exec<{ name: string }>('PRAGMA table_info(usage)')].map((column) => column.name),
  );
  if (!columns.has('warned_low')) {
    sql.exec('ALTER TABLE usage ADD COLUMN warned_low INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('warned_full')) {
    sql.exec('ALTER TABLE usage ADD COLUMN warned_full INTEGER NOT NULL DEFAULT 0');
  }
}

export class InboxQuota implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState) {
    this.sql = ctx.storage.sql;
    ensureSchema(this.sql);
  }

  /**
   * Claims a warning if one is due, returning it at most once per mark per
   * month. Deciding this here rather than from `used` at the call site is what
   * makes it once-only: a rolled-back reservation can reach the same count
   * twice, and two submissions can land together, both of which re-fired the
   * old `used === mark` test.
   *
   * Rollback deliberately does not clear these flags. A count that flaps around
   * a mark should not produce a stream of identical emails.
   */
  private claimWarning(month: string, used: number, limit: number): 'low' | 'full' | undefined {
    const row = this.sql
      .exec<{ warned_low: number; warned_full: number }>(
        'SELECT warned_low, warned_full FROM usage WHERE month = ?1',
        month,
      )
      .one();

    if (used >= limit && !row.warned_full) {
      this.sql.exec('UPDATE usage SET warned_full = 1 WHERE month = ?1', month);
      return 'full';
    }
    if (used >= lowMark(limit) && !row.warned_low) {
      this.sql.exec('UPDATE usage SET warned_low = 1 WHERE month = ?1', month);
      return 'low';
    }
    return undefined;
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

      const warn = this.claimWarning(month, rows[0].used, rows[0].limit_count);
      return json({
        allowed: true,
        used: rows[0].used,
        limit: rows[0].limit_count,
        month,
        ...(warn ? { warn } : {}),
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
