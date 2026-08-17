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
}

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

describe('InboxQuota reservation', () => {
  it('counts up from one and reports the configured limit', async () => {
    const inbox = 'counts-up';
    expect(await reserve(inbox)).toEqual({
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

    expect(result).toEqual({ allowed: true, used: 0, limit: 0, month: MONTH });

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
    expect(await reserve(inbox, limit, '2026-09')).toEqual({
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
