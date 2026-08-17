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
      warned_full INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0
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
  if (!columns.has('failed')) {
    sql.exec('ALTER TABLE usage ADD COLUMN failed INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('blocked')) {
    sql.exec('ALTER TABLE usage ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
  }

  // The plan is a property of the inbox, not of a month, so it lives in its own
  // single-row table rather than being copied onto every usage row. `usage`
  // keeps recording the limit that applied when each month was counted, which
  // is what makes a past month's numbers still make sense after an upgrade.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS plan (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      monthly_limit INTEGER,
      updated_at TEXT NOT NULL
    )
  `);
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

  /** The inbox's own plan, or null when it has never been granted one. */
  private storedPlan(): { name: string; monthly_limit: number | null } | null {
    const rows = this.sql
      .exec<{ name: string; monthly_limit: number | null }>(
        'SELECT name, monthly_limit FROM plan WHERE id = 1',
      )
      .toArray();
    return rows[0] ?? null;
  }

  /**
   * The limit that actually applies. A granted plan wins over the deployment
   * default, so entitlement is read inside the object that enforces it — no
   * lookup on the delivery path, and nothing to be stale.
   */
  private effectiveLimit(requestedLimit: number): number {
    const plan = this.storedPlan();
    if (!plan || plan.monthly_limit === null) return requestedLimit;
    return Math.max(0, Math.floor(plan.monthly_limit));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // A plan read carries no body, and request.json() throws on an empty one.
    const body = (
      request.method === 'GET' ? {} : await request.json()
    ) as {
      limit?: number;
      month?: string;
      plan?: string;
      monthly_limit?: number | null;
    };
    const month = body.month ?? currentMonth();

    if (url.pathname === '/plan' && request.method === 'POST') {
      const name = typeof body.plan === 'string' && body.plan.trim() ? body.plan.trim() : 'free';
      const monthlyLimit =
        body.monthly_limit === null || body.monthly_limit === undefined
          ? null
          : Math.max(0, Math.floor(body.monthly_limit));
      this.sql.exec(
        `INSERT INTO plan (id, name, monthly_limit, updated_at) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           monthly_limit = excluded.monthly_limit,
           updated_at = excluded.updated_at`,
        name,
        monthlyLimit,
        new Date().toISOString(),
      );
      return json({ plan: name, monthly_limit: monthlyLimit });
    }

    if (url.pathname === '/plan' && request.method === 'GET') {
      const plan = this.storedPlan();
      return json({
        plan: plan?.name ?? 'free',
        monthly_limit: plan?.monthly_limit ?? null,
      });
    }

    if (url.pathname === '/reserve' && request.method === 'POST') {
      const requested = Number.isFinite(body.limit)
        ? Math.max(0, Math.floor(body.limit ?? 0))
        : 0;
      const limit = this.effectiveLimit(requested);
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
        this.sql.exec('UPDATE usage SET blocked = blocked + 1 WHERE month = ?1', month);
        // Report the limit being enforced now, not the one stored on the row.
        // After a downgrade those differ, and the row's value would tell the
        // caller they have an allowance they are simultaneously being denied.
        return json({
          allowed: false,
          used: existing?.used ?? limit,
          limit,
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
      // Rollback is called on exactly one occasion: delivery failed after the
      // reservation was granted. So it is also the failure tally, and counting
      // here costs no extra round trip.
      this.sql.exec(
        'UPDATE usage SET used = MAX(0, used - 1), failed = failed + 1 WHERE month = ?1',
        month,
      );
      return json({ rolledBack: true });
    }

    if (url.pathname === '/insight' && request.method === 'GET') {
      const rows = this.sql
        .exec<{
          month: string;
          used: number;
          limit_count: number;
          failed: number;
          blocked: number;
        }>(
          'SELECT month, used, limit_count, failed, blocked FROM usage ORDER BY month DESC LIMIT 13',
        )
        .toArray();
      const plan = this.storedPlan();
      return json({
        plan: plan?.name ?? 'free',
        months: rows.map((row) => ({
          month: row.month,
          // `used` is the delivered count by construction: a failed delivery is
          // rolled back, so it never remains counted.
          delivered: row.used,
          limit: row.limit_count,
          failed: row.failed,
          blocked: row.blocked,
        })),
      });
    }

    return json({ error: 'Not found' }, 404);
  }
}

async function quotaRequest(
  env: Env,
  ownerId: string,
  path: '/reserve' | '/rollback' | '/plan',
  body: { limit?: number; month?: string; plan?: string; monthly_limit?: number | null },
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

/**
 * Grants (or clears) an inbox's plan. `monthlyLimit: null` returns it to the
 * deployment default, which is how a lapsed subscription is expressed — the
 * inbox keeps working on the free allowance rather than having its forms break.
 */
export async function setInboxPlan(
  env: Env,
  ownerId: string,
  plan: string,
  monthlyLimit: number | null,
): Promise<{ plan: string; monthly_limit: number | null }> {
  const response = await quotaRequest(env, ownerId, '/plan', {
    plan,
    monthly_limit: monthlyLimit,
  });
  if (!response.ok) throw new Error('Plan update failed');
  return (await response.json()) as { plan: string; monthly_limit: number | null };
}

export async function getInboxPlan(
  env: Env,
  ownerId: string,
): Promise<{ plan: string; monthly_limit: number | null }> {
  if (!env.QUOTAS) {
    throw new ConfigError('QUOTAS binding is required to read a plan');
  }
  const id = env.QUOTAS.idFromName(ownerId);
  const response = await env.QUOTAS.get(id).fetch('https://quota.internal/plan', {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: undefined,
  });
  if (!response.ok) throw new Error('Plan lookup failed');
  return (await response.json()) as { plan: string; monthly_limit: number | null };
}

export interface InboxInsight {
  plan: string;
  months: Array<{
    month: string;
    delivered: number;
    limit: number;
    failed: number;
    blocked: number;
  }>;
}

/**
 * Counters for one inbox. Tallies only — there is no per-submission row and no
 * timestamp, so this cannot reconstruct who submitted what or when. That is the
 * property the trust page states about quota storage, and it has to keep
 * holding once this is exposed.
 */
export async function getInboxInsight(env: Env, ownerId: string): Promise<InboxInsight> {
  if (!env.QUOTAS) {
    throw new ConfigError('QUOTAS binding is required to read insight');
  }
  const id = env.QUOTAS.idFromName(ownerId);
  const response = await env.QUOTAS.get(id).fetch('https://quota.internal/insight', {
    method: 'GET',
  });
  if (!response.ok) throw new Error('Insight lookup failed');
  return (await response.json()) as InboxInsight;
}

export async function rollbackQuota(
  env: Env,
  ownerId: string,
  month: string,
): Promise<void> {
  const response = await quotaRequest(env, ownerId, '/rollback', { month });
  if (!response.ok) throw new Error('Quota rollback failed');
}
