import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from './quota';
import type { InboxQuota } from './quota';
// The pool types `env` as Cloudflare.Env. Only the quota binding is needed
// here, and it is declared non-optional: QUOTAS is optional on the Worker's own
// Env because a deployment can run unmetered, but this project always binds it.
declare global {
  namespace Cloudflare {
    interface Env {
      QUOTAS: DurableObjectNamespace;
    }
  }
}

/**
 * Exercises the real InboxQuota Durable Object on real Durable Object storage.
 *
 * These specs exist because every other suite substitutes a canned reservation,
 * which means the clause that actually enforces the allowance —
 * `WHERE usage.used < excluded.limit_count` — was never executed by a test.
 * Delete it and the node suites still pass. They do not pass here.
 */

const LIMIT = 250;
const MONTH = '2026-08';

interface Reservation {
  allowed: boolean;
  used: number;
  limit: number;
  month: string;
  warn?: 'low' | 'full';
  reason?: 'daily';
  day?: string;
}

const DAY = '2026-08-18';

function quotaStub(name: string) {
  return env.QUOTAS.get(env.QUOTAS.idFromName(name));
}

async function reserve(
  name: string,
  limit = LIMIT,
  month = MONTH,
): Promise<Reservation> {
  const response = await quotaStub(name).fetch('https://quota.internal/reserve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit, month }),
  });
  return (await response.json()) as Reservation;
}

async function rollback(name: string, month = MONTH): Promise<void> {
  await quotaStub(name).fetch('https://quota.internal/rollback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month }),
  });
}

async function reserveDay(
  name: string,
  dailyLimit: number,
  day = DAY,
  month = MONTH,
): Promise<Reservation> {
  const response = await quotaStub(name).fetch('https://quota.internal/reserve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: LIMIT, month, daily_limit: dailyLimit, day }),
  });
  return (await response.json()) as Reservation;
}

/**
 * The day ceiling exists to bound a flood: the monthly allowance caps the total
 * but says nothing about how fast it goes, and at the per-minute rate limit
 * alone a month drains in under an hour. These specs run the real SQL, because
 * the ceiling is the SQL.
 */
describe('InboxQuota daily ceiling', () => {
  it('allows exactly the day limit and refuses the one after it', async () => {
    const inbox = 'day-boundary';
    expect(await reserveDay(inbox, 2)).toMatchObject({ allowed: true, used: 1 });
    expect(await reserveDay(inbox, 2)).toMatchObject({ allowed: true, used: 2 });

    const refused = await reserveDay(inbox, 2);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('daily');
    expect(refused.limit).toBe(2);
    expect(refused.day).toBe(DAY);
  });

  it('does not spend the monthly allowance on a day-refused submission', async () => {
    const inbox = 'day-refusal-is-free';
    await reserveDay(inbox, 1);
    await reserveDay(inbox, 1);
    await reserveDay(inbox, 1);

    // Only the one that was allowed counted. A refusal that still burned the
    // month would make the ceiling worse than not having one.
    const nextDay = await reserveDay(inbox, 5, '2026-08-19');
    expect(nextDay).toMatchObject({ allowed: true, used: 2 });
  });

  it('starts over on the next day', async () => {
    const inbox = 'day-rollover';
    await reserveDay(inbox, 1);
    expect(await reserveDay(inbox, 1)).toMatchObject({ allowed: false, reason: 'daily' });
    expect(await reserveDay(inbox, 1, '2026-08-19')).toMatchObject({ allowed: true });
  });

  it('returns the day counter on rollback, so a failed delivery is not held against it', async () => {
    const inbox = 'day-rollback';
    await reserveDay(inbox, 1);
    await quotaStub(inbox).fetch('https://quota.internal/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month: MONTH, day: DAY }),
    });

    expect(await reserveDay(inbox, 1)).toMatchObject({ allowed: true });
  });

  it('is off when no day limit is passed, so an unmetered deployment is unaffected', async () => {
    const inbox = 'day-disabled';
    for (let index = 0; index < 5; index += 1) {
      expect(await reserve(inbox)).toMatchObject({ allowed: true });
    }
  });

  it('still enforces the month when the day ceiling is generous', async () => {
    const inbox = 'month-still-wins';
    await reserveDay(inbox, 100, DAY, '2026-09');
    const response = await quotaStub(inbox).fetch('https://quota.internal/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 1, month: '2026-09', daily_limit: 100, day: DAY }),
    });
    const refused = (await response.json()) as Reservation;
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBeUndefined();
  });
});

describe('InboxQuota reservation', () => {
  it('counts up from one and reports the configured limit', async () => {
    const inbox = 'counts-up';
    expect(await reserve(inbox)).toMatchObject({
      allowed: true,
      used: 1,
      limit: LIMIT,
      month: MONTH,
    });
    expect(await reserve(inbox)).toMatchObject({ allowed: true, used: 2 });
    expect(await reserve(inbox)).toMatchObject({ allowed: true, used: 3 });
  });

  it('allows exactly the limit and denies the one after it', async () => {
    const inbox = 'boundary';
    const limit = 3;

    expect(await reserve(inbox, limit)).toMatchObject({ allowed: true, used: 1 });
    expect(await reserve(inbox, limit)).toMatchObject({ allowed: true, used: 2 });
    expect(await reserve(inbox, limit)).toMatchObject({ allowed: true, used: 3 });

    // The whole point: the limit-th submission is delivered, the next is not.
    const denied = await reserve(inbox, limit);
    expect(denied.allowed).toBe(false);
    expect(denied.used).toBe(limit);
    expect(denied.limit).toBe(limit);
  });

  it('stays denied and does not keep incrementing once exhausted', async () => {
    const inbox = 'stays-denied';
    await reserve(inbox, 1);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const denied = await reserve(inbox, 1);
      expect(denied.allowed).toBe(false);
      // A denied attempt must not inflate the count, or the reported usage
      // drifts above the limit and the reset message becomes nonsense.
      expect(denied.used).toBe(1);
    }
  });

  it('holds the line under concurrent reservations', async () => {
    const inbox = 'concurrent';
    const limit = 10;

    const results = await Promise.all(
      Array.from({ length: 40 }, () => reserve(inbox, limit)),
    );

    const allowed = results.filter((result) => result.allowed);
    expect(allowed).toHaveLength(limit);
    // Each grant must be a distinct count. A non-atomic check-then-increment
    // would hand the same number to two callers.
    expect(new Set(allowed.map((result) => result.used)).size).toBe(limit);
    expect(allowed.map((result) => result.used).sort((a, b) => a - b)).toEqual(
      Array.from({ length: limit }, (_, index) => index + 1),
    );
  });

  it('treats a zero limit as unmetered and writes nothing', async () => {
    const inbox = 'unmetered';
    const result = await reserve(inbox, 0);

    expect(result).toMatchObject({ allowed: true, used: 0, limit: 0, month: MONTH });

    // No row may be created, or switching MONTHLY_LIMIT back on would find a
    // phantom month already present.
    await runInDurableObject(
      quotaStub(inbox),
      (instance: InboxQuota, state: DurableObjectState) => {
        const rows = [...state.storage.sql.exec('SELECT COUNT(*) AS n FROM usage')];
        expect(rows[0].n).toBe(0);
        expect(instance).toBeDefined();
      },
    );
  });

  it('keeps months independent so the allowance actually resets', async () => {
    const inbox = 'monthly-reset';
    const limit = 2;

    await reserve(inbox, limit, '2026-08');
    await reserve(inbox, limit, '2026-08');
    expect(await reserve(inbox, limit, '2026-08')).toMatchObject({ allowed: false });

    // A new month is a new row, so the inbox is immediately usable again.
    expect(await reserve(inbox, limit, '2026-09')).toMatchObject({
      allowed: true,
      used: 1,
      limit,
      month: '2026-09',
    });
  });

  it('separates inboxes, since the DO is addressed by opaque inbox ID', async () => {
    const limit = 1;
    expect(await reserve('inbox-a', limit)).toMatchObject({ allowed: true });
    expect(await reserve('inbox-a', limit)).toMatchObject({ allowed: false });
    expect(await reserve('inbox-b', limit)).toMatchObject({ allowed: true, used: 1 });
  });

  it('adopts a raised limit without losing the count already spent', async () => {
    const inbox = 'raised-limit';
    await reserve(inbox, 2);
    await reserve(inbox, 2);
    expect(await reserve(inbox, 2)).toMatchObject({ allowed: false, used: 2 });

    // limit_count is refreshed from the request, so raising MONTHLY_LIMIT takes
    // effect immediately rather than at the next month boundary.
    expect(await reserve(inbox, 5)).toMatchObject({ allowed: true, used: 3, limit: 5 });
  });
});

describe('InboxQuota rollback', () => {
  it('gives the reservation back so a failed delivery costs nothing', async () => {
    const inbox = 'rollback-frees';
    await reserve(inbox, 2);
    await reserve(inbox, 2);
    expect(await reserve(inbox, 2)).toMatchObject({ allowed: false });

    await rollback(inbox);

    expect(await reserve(inbox, 2)).toMatchObject({ allowed: true, used: 2 });
  });

  it('decrements exactly one unit', async () => {
    const inbox = 'rollback-one';
    await reserve(inbox, 10);
    await reserve(inbox, 10);
    await reserve(inbox, 10);

    await rollback(inbox);

    expect(await reserve(inbox, 10)).toMatchObject({ used: 3 });
  });

  it('never drives the count below zero', async () => {
    const inbox = 'rollback-floor';
    await reserve(inbox, 10);
    await rollback(inbox);
    await rollback(inbox);
    await rollback(inbox);

    // A negative count would silently hand out free submissions next month.
    expect(await reserve(inbox, 10)).toMatchObject({ used: 1 });
  });

  it('only touches the month it is given', async () => {
    const inbox = 'rollback-month';
    await reserve(inbox, 10, '2026-08');
    await reserve(inbox, 10, '2026-09');

    await rollback(inbox, '2026-08');

    expect(await reserve(inbox, 10, '2026-08')).toMatchObject({ used: 1 });
    expect(await reserve(inbox, 10, '2026-09')).toMatchObject({ used: 2 });
  });

  it('is harmless on a month that was never reserved', async () => {
    const inbox = 'rollback-unknown';
    await rollback(inbox, '2020-01');
    expect(await reserve(inbox, 10, '2020-01')).toMatchObject({ allowed: true, used: 1 });
  });
});

describe('InboxQuota warning marks', () => {
  it('claims the low mark once and never again that month', async () => {
    const inbox = 'warn-low-once';
    const limit = 10; // low mark is 8

    const upToMark = [];
    for (let i = 0; i < 8; i += 1) upToMark.push(await reserve(inbox, limit));

    expect(upToMark.slice(0, 7).every((r) => r.warn === undefined)).toBe(true);
    expect(upToMark[7].warn).toBe('low');

    expect((await reserve(inbox, limit)).warn).toBeUndefined();
  });

  it('claims the full mark when the allowance is spent', async () => {
    const inbox = 'warn-full';
    const limit = 3; // low mark is 3 as well, so full must win

    await reserve(inbox, limit);
    await reserve(inbox, limit);
    expect((await reserve(inbox, limit)).warn).toBe('full');

    // Denied attempts must not warn again — the owner already knows.
    expect((await reserve(inbox, limit)).warn).toBeUndefined();
  });

  it('does not resend after a rollback returns the count to the mark', async () => {
    // This is the defect: a delivery failure rolls the reservation back, the
    // next submission reaches the same count, and the old used === mark test
    // fired a second identical email.
    const inbox = 'warn-rollback';
    const limit = 10;

    for (let i = 0; i < 8; i += 1) await reserve(inbox, limit);
    await rollback(inbox);

    const again = await reserve(inbox, limit);
    expect(again.used).toBe(8);
    expect(again.warn).toBeUndefined();
  });

  it('claims each mark at most once under concurrency', async () => {
    const inbox = 'warn-concurrent';
    const limit = 10;

    const results = await Promise.all(
      Array.from({ length: 30 }, () => reserve(inbox, limit)),
    );

    const warnings = results.map((r) => r.warn).filter(Boolean);
    expect(warnings.filter((w) => w === 'low')).toHaveLength(1);
    expect(warnings.filter((w) => w === 'full')).toHaveLength(1);
  });

  it('warns again in a new month, because the allowance is new', async () => {
    const inbox = 'warn-new-month';
    const limit = 1;

    expect((await reserve(inbox, limit, '2026-08')).warn).toBe('full');
    expect((await reserve(inbox, limit, '2026-09')).warn).toBe('full');
  });

  it('does not warn twice in a month when the limit is raised', async () => {
    const inbox = 'warn-raised';

    for (let i = 0; i < 8; i += 1) await reserve(inbox, 10);
    // The low mark was claimed at 8. Raising the limit to 20 moves the
    // arithmetic mark to 16, but the owner has already been told once this
    // month, and a second "running low" for the same month would read as noise
    // rather than news. One low and one full per month, deliberately.
    for (let i = 0; i < 9; i += 1) {
      expect((await reserve(inbox, 20)).warn).toBeUndefined();
    }
    // The full mark is a different mark, and is still owed.
    for (let i = 0; i < 2; i += 1) await reserve(inbox, 20);
    expect((await reserve(inbox, 20)).warn).toBe('full');
  });

  it('never warns while the limit is disabled', async () => {
    expect((await reserve('warn-unmetered', 0)).warn).toBeUndefined();
  });

  it('migrates a namespace created before the mark columns existed', async () => {
    const inbox = 'legacy-schema';

    await runInDurableObject(
      quotaStub(inbox),
      (_instance: InboxQuota, state: DurableObjectState) => {
        const sql = state.storage.sql;
        // The table shape every live inbox currently has.
        sql.exec('DROP TABLE usage');
        sql.exec(
          'CREATE TABLE usage (month TEXT PRIMARY KEY, used INTEGER NOT NULL, limit_count INTEGER NOT NULL)',
        );
        sql.exec("INSERT INTO usage (month, used, limit_count) VALUES ('2026-08', 7, 10)");

        ensureSchema(sql);

        const columns = new Set(
          [...sql.exec<{ name: string }>('PRAGMA table_info(usage)')].map((c) => c.name),
        );
        expect(columns.has('warned_low')).toBe(true);
        expect(columns.has('warned_full')).toBe(true);

        // The existing count must survive, and start unwarned.
        const row = sql
          .exec<{ used: number; warned_low: number; warned_full: number }>(
            "SELECT used, warned_low, warned_full FROM usage WHERE month = '2026-08'",
          )
          .one();
        expect(row).toMatchObject({ used: 7, warned_low: 0, warned_full: 0 });

        // Idempotent: the constructor runs this on every cold start.
        ensureSchema(sql);
        ensureSchema(sql);
      },
    );
  });
});

async function setPlan(
  name: string,
  plan: string,
  monthlyLimit: number | null,
): Promise<{ plan: string; monthly_limit: number | null }> {
  const response = await quotaStub(name).fetch('https://quota.internal/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, monthly_limit: monthlyLimit }),
  });
  return (await response.json()) as { plan: string; monthly_limit: number | null };
}

async function readPlan(name: string): Promise<{ plan: string; monthly_limit: number | null }> {
  const response = await quotaStub(name).fetch('https://quota.internal/plan', { method: 'GET' });
  return (await response.json()) as { plan: string; monthly_limit: number | null };
}

describe('InboxQuota plans', () => {
  it('defaults to free with no override', async () => {
    expect(await readPlan('plan-default')).toEqual({ plan: 'free', monthly_limit: null });
  });

  it('lets a granted limit override the deployment default', async () => {
    const inbox = 'plan-raises';
    await setPlan(inbox, 'conform-plus', 5);

    // The caller still asks for the deployment default of 2; the object applies
    // the grant instead, so the delivery path needs no entitlement lookup.
    for (let i = 0; i < 5; i += 1) {
      expect((await reserve(inbox, 2)).allowed).toBe(true);
    }
    expect(await reserve(inbox, 2)).toMatchObject({ allowed: false, limit: 5 });
  });

  it('applies a grant to an inbox already counting this month', async () => {
    const inbox = 'plan-midmonth';
    await reserve(inbox, 2);
    await reserve(inbox, 2);
    expect(await reserve(inbox, 2)).toMatchObject({ allowed: false });

    await setPlan(inbox, 'conform-plus', 10);

    // An upgrade must unblock immediately, not at the next month boundary.
    expect(await reserve(inbox, 2)).toMatchObject({ allowed: true, used: 3, limit: 10 });
  });

  it('restores the deployment default when the grant is cleared', async () => {
    const inbox = 'plan-lapse';
    await setPlan(inbox, 'conform-plus', 10);
    for (let i = 0; i < 4; i += 1) await reserve(inbox, 2);

    // A lapsed subscription clears the grant. The inbox must keep working on
    // the free allowance rather than having its forms break.
    await setPlan(inbox, 'free', null);
    const after = await reserve(inbox, 2);
    expect(after.limit).toBe(2);
    expect(after.allowed).toBe(false);
  });

  it('treats a granted zero as unmetered for that inbox', async () => {
    const inbox = 'plan-unmetered';
    await setPlan(inbox, 'self-host', 0);
    const result = await reserve(inbox, 2);
    expect(result).toMatchObject({ allowed: true, used: 0, limit: 0, month: MONTH });
  });

  it('survives a plan being regranted', async () => {
    const inbox = 'plan-regrant';
    await setPlan(inbox, 'conform-plus', 10);
    await setPlan(inbox, 'conform-plus', 20);
    expect(await readPlan(inbox)).toMatchObject({ plan: 'conform-plus', monthly_limit: 20 });
  });

  it('keeps the plan on a namespace migrated from the old schema', async () => {
    const inbox = 'plan-legacy';
    await runInDurableObject(
      quotaStub(inbox),
      (_instance: InboxQuota, state: DurableObjectState) => {
        const sql = state.storage.sql;
        sql.exec('DROP TABLE IF EXISTS plan');
        ensureSchema(sql);
        const tables = [
          ...sql.exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table'",
          ),
        ].map((row) => row.name);
        expect(tables).toContain('plan');
      },
    );
    expect(await readPlan(inbox)).toEqual({ plan: 'free', monthly_limit: null });
  });
});

async function insight(name: string) {
  const response = await quotaStub(name).fetch('https://quota.internal/insight', {
    method: 'GET',
  });
  return (await response.json()) as {
    plan: string;
    months: Array<{
      month: string;
      delivered: number;
      limit: number;
      failed: number;
      blocked: number;
      throttled: number;
    }>;
  };
}

describe('InboxQuota delivery insight', () => {
  it('counts delivered submissions as the surviving reservations', async () => {
    const inbox = 'insight-delivered';
    await reserve(inbox, 10);
    await reserve(inbox, 10);
    await reserve(inbox, 10);

    const report = await insight(inbox);
    expect(report.months[0]).toMatchObject({
      month: MONTH,
      delivered: 3,
      failed: 0,
      blocked: 0,
    });
  });

  it('moves a rolled-back reservation from delivered to failed', async () => {
    const inbox = 'insight-failed';
    await reserve(inbox, 10);
    await reserve(inbox, 10);
    await rollback(inbox);

    const report = await insight(inbox);
    // A failed delivery must not be reported as delivered, and must not consume
    // the allowance either.
    expect(report.months[0]).toMatchObject({ delivered: 1, failed: 1 });
  });

  it('counts submissions refused because the allowance was spent', async () => {
    const inbox = 'insight-blocked';
    await reserve(inbox, 2);
    await reserve(inbox, 2);
    await reserve(inbox, 2);
    await reserve(inbox, 2);

    const report = await insight(inbox);
    expect(report.months[0]).toMatchObject({ delivered: 2, blocked: 2 });
  });

  it('keeps months separate and reports the newest first', async () => {
    const inbox = 'insight-months';
    await reserve(inbox, 10, '2026-07');
    await reserve(inbox, 10, '2026-08');
    await reserve(inbox, 10, '2026-08');

    const report = await insight(inbox);
    expect(report.months.map((m) => m.month)).toEqual(['2026-08', '2026-07']);
    expect(report.months[0].delivered).toBe(2);
    expect(report.months[1].delivered).toBe(1);
  });

  it('reports the plan alongside the counters', async () => {
    const inbox = 'insight-plan';
    await setPlan(inbox, 'conform-plus', 50);
    await reserve(inbox, 10);
    const report = await insight(inbox);
    expect(report.plan).toBe('conform-plus');
    expect(report.months[0].limit).toBe(50);
  });

  it('exposes nothing that could reconstruct a submission', async () => {
    const inbox = 'insight-privacy';
    await reserve(inbox, 10);
    await rollback(inbox);

    const report = await insight(inbox);
    const serialized = JSON.stringify(report);

    // Counters only. No timestamps, no identifiers, no field names, no
    // addresses -- the trust page says quota storage cannot reproduce a
    // submission, and this endpoint must not quietly change that.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('cfm_');
    for (const month of report.months) {
      expect(Object.keys(month).sort()).toEqual(
        ['blocked', 'delivered', 'failed', 'limit', 'month', 'throttled'],
      );
    }
  });

  it('starts counters at zero on a namespace migrated from the old schema', async () => {
    const inbox = 'insight-legacy';
    await runInDurableObject(
      quotaStub(inbox),
      (_instance: InboxQuota, state: DurableObjectState) => {
        const sql = state.storage.sql;
        sql.exec('DROP TABLE usage');
        sql.exec(
          'CREATE TABLE usage (month TEXT PRIMARY KEY, used INTEGER NOT NULL, limit_count INTEGER NOT NULL)',
        );
        sql.exec("INSERT INTO usage (month, used, limit_count) VALUES ('2026-08', 5, 10)");
        ensureSchema(sql);
      },
    );

    const report = await insight(inbox);
    expect(report.months[0]).toMatchObject({ delivered: 5, failed: 0, blocked: 0 });
  });
});

async function countThrottle(name: string, month = MONTH) {
  await quotaStub(name).fetch('https://quota.internal/throttled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month }),
  });
}

describe('InboxQuota throttle counter', () => {
  it('records a throttle on an inbox that has never delivered', async () => {
    const inbox = 'throttle-first';
    await countThrottle(inbox);

    const report = await insight(inbox);
    // A bot can find a form before any human uses it, so the month row has to
    // be created by the throttle itself.
    expect(report.months[0]).toMatchObject({
      month: MONTH,
      delivered: 0,
      throttled: 1,
    });
  });

  it('accumulates without disturbing the delivered count', async () => {
    const inbox = 'throttle-accumulate';
    await reserve(inbox, 10);
    await countThrottle(inbox);
    await countThrottle(inbox);
    await reserve(inbox, 10);

    expect((await insight(inbox)).months[0]).toMatchObject({
      delivered: 2,
      throttled: 2,
    });
  });

  it('never consumes the allowance', async () => {
    const inbox = 'throttle-free';
    for (let i = 0; i < 5; i += 1) await countThrottle(inbox);

    // Throttled requests are refused before reservation; counting them must not
    // quietly spend what it refused to deliver.
    const next = await reserve(inbox, 2);
    expect(next).toMatchObject({ allowed: true, used: 1 });
  });

  it('keeps throttle counts per month', async () => {
    const inbox = 'throttle-months';
    await countThrottle(inbox, '2026-07');
    await countThrottle(inbox, '2026-08');
    await countThrottle(inbox, '2026-08');

    const report = await insight(inbox);
    const byMonth = Object.fromEntries(report.months.map((m) => [m.month, m.throttled]));
    expect(byMonth['2026-08']).toBe(2);
    expect(byMonth['2026-07']).toBe(1);
  });

  it('starts at zero on a namespace migrated from the old schema', async () => {
    const inbox = 'throttle-legacy';
    await runInDurableObject(
      quotaStub(inbox),
      (_instance: InboxQuota, state: DurableObjectState) => {
        const sql = state.storage.sql;
        sql.exec('DROP TABLE usage');
        sql.exec(
          'CREATE TABLE usage (month TEXT PRIMARY KEY, used INTEGER NOT NULL, limit_count INTEGER NOT NULL)',
        );
        sql.exec("INSERT INTO usage (month, used, limit_count) VALUES ('2026-08', 4, 10)");
        ensureSchema(sql);
      },
    );

    expect((await insight(inbox)).months[0]).toMatchObject({ delivered: 4, throttled: 0 });
  });
});

describe('InboxQuota routing', () => {
  it('404s an unknown path rather than silently allowing', async () => {
    const response = await quotaStub('unknown-path').fetch(
      'https://quota.internal/nope',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: MONTH }),
      },
    );
    expect(response.status).toBe(404);
  });
});
