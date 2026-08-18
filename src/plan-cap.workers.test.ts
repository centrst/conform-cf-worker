import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

declare global {
  namespace Cloudflare {
    interface Env { QUOTAS: DurableObjectNamespace }
  }
}

const stub = (name: string) => env.QUOTAS.get(env.QUOTAS.idFromName(name));

async function setPlan(inbox: string, plan: string, monthly: number | null) {
  await stub(inbox).fetch('https://quota.internal/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, monthly_limit: monthly }),
  });
}

async function reserve(inbox: string, limit: number, daily: number | undefined, day: string) {
  const response = await stub(inbox).fetch('https://quota.internal/reserve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      limit,
      month: '2026-08',
      day,
      ...(daily === undefined ? {} : { daily_limit: daily }),
    }),
  });
  return (await response.json()) as { allowed: boolean; reason?: string };
}

/**
 * The day ceiling has to be derived from the allowance actually in force, not
 * from the deployment default. Deriving it in the Worker read 250 and capped a
 * granted 10,000 inbox at 50 a day -- 1,500 a month, so the allowance it had
 * been sold was unreachable. The derivation now lives in the object that reads
 * the plan, which is the same rule the monthly limit already followed.
 *
 * `daily_limit: 0` is what the Worker sends when no operator override is set.
 */
describe('a granted plan and the daily ceiling', () => {
  it('scales the day ceiling with the granted allowance', async () => {
    const inbox = 'plus-daily';
    await setPlan(inbox, 'conform-plus', 10_000);

    let delivered = 0;
    for (let index = 0; index < 60; index += 1) {
      if ((await reserve(inbox, 250, undefined, '2026-08-18')).allowed) delivered += 1;
    }

    // A fifth of 10,000, not a fifth of the deployment's own 250.
    expect(delivered).toBe(60);
  });

  it('still holds an ungranted inbox to the deployment default', async () => {
    const inbox = 'free-daily';

    let delivered = 0;
    for (let index = 0; index < 60; index += 1) {
      if ((await reserve(inbox, 250, undefined, '2026-08-18')).allowed) delivered += 1;
    }

    expect(delivered).toBe(50);
  });

  it('treats an explicit zero as the ceiling switched off, not as absent', async () => {
    const inbox = 'zero-daily';

    let delivered = 0;
    for (let index = 0; index < 60; index += 1) {
      if ((await reserve(inbox, 250, 0, '2026-08-18')).allowed) delivered += 1;
    }

    // Collapsing "unset" and "zero" turned DAILY_LIMIT="0" into a derived cap
    // of 50 that the operator never asked for.
    expect(delivered).toBe(60);
  });

  it('lets an operator override the derivation on any plan', async () => {
    const inbox = 'override-daily';
    await setPlan(inbox, 'conform-plus', 10_000);

    let delivered = 0;
    for (let index = 0; index < 20; index += 1) {
      if ((await reserve(inbox, 250, 10, '2026-08-18')).allowed) delivered += 1;
    }

    expect(delivered).toBe(10);
  });

  it('reports the enforced ceiling rather than leaving the caller to guess', async () => {
    const inbox = 'peek-daily';
    await setPlan(inbox, 'conform-plus', 10_000);

    const response = await stub(inbox).fetch('https://quota.internal/peek', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 250, month: '2026-08', day: '2026-08-18' }),
    });
    const peek = (await response.json()) as { limit: number; day_limit: number };

    expect(peek.limit).toBe(10_000);
    expect(peek.day_limit).toBe(2_000);
  });
});
