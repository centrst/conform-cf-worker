import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
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
