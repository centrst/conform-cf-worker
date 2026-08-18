import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

declare global {
  namespace Cloudflare {
    interface Env {
      QUOTAS: DurableObjectNamespace;
    }
  }
}

/**
 * What a granted monthly_limit means, against the real quota object.
 *
 * Three values, and two of them look alike to a caller while meaning opposite
 * things. `null` is the absence of a grant; `0` is a grant of "no ceiling".
 * Only `null` was documented, so the tier sold as having no monthly ceiling
 * had no documented way to be granted one — and the natural guess handed it
 * the free allowance instead.
 */

const DEPLOYMENT_DEFAULT = 250;
const stub = (name: string) => env.QUOTAS.get(env.QUOTAS.idFromName(name));

async function grant(inbox: string, monthlyLimit: number | null) {
  await stub(inbox).fetch('https://quota.internal/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'test-plan', monthly_limit: monthlyLimit }),
  });
}

/** Reserves `attempts` times and reports how many were allowed. */
async function deliver(inbox: string, attempts: number): Promise<number> {
  let delivered = 0;
  for (let index = 0; index < attempts; index += 1) {
    const response = await stub(inbox).fetch('https://quota.internal/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit: DEPLOYMENT_DEFAULT,
        month: '2026-08',
        day: '2026-08-18',
        // Explicitly off, so these assertions are about the monthly grant and
        // not about the day ceiling derived from it.
        daily_limit: 0,
      }),
    });
    if (((await response.json()) as { allowed: boolean }).allowed) delivered += 1;
  }
  return delivered;
}

describe('a granted monthly_limit', () => {
  it('takes the deployment default when the grant is null', async () => {
    const inbox = 'grant-null';
    await grant(inbox, null);

    // null is "no grant of a ceiling", which is also how a lapsed subscription
    // is expressed: forms keep delivering on the free allowance.
    expect(await deliver(inbox, DEPLOYMENT_DEFAULT + 10)).toBe(DEPLOYMENT_DEFAULT);
  });

  it('is unlimited when the grant is zero', async () => {
    const inbox = 'grant-zero';
    await grant(inbox, 0);

    // Same convention as MONTHLY_LIMIT="0" on a deployment. This is what
    // conForm+ Ultra needs, and granting it as null instead capped the most
    // expensive tier at the free allowance.
    expect(await deliver(inbox, DEPLOYMENT_DEFAULT + 10)).toBe(DEPLOYMENT_DEFAULT + 10);
  });

  it('takes the granted number when the grant is a number', async () => {
    const inbox = 'grant-number';
    await grant(inbox, 12);

    expect(await deliver(inbox, 20)).toBe(12);
  });

  it('never collapses null and zero into each other', async () => {
    const nulled = 'collapse-null';
    const zeroed = 'collapse-zero';
    await grant(nulled, null);
    await grant(zeroed, 0);

    const [a, b] = await Promise.all([deliver(nulled, 260), deliver(zeroed, 260)]);
    expect(a).not.toBe(b);
  });

  it('restores the deployment default when a grant is revoked with null', async () => {
    const inbox = 'grant-revoked';
    await grant(inbox, 0);
    expect(await deliver(inbox, 10)).toBe(10);

    await grant(inbox, null);
    // The full default, not 240: an unmetered reservation writes no usage row
    // at all, so nothing delivered under the grant is counted against the
    // allowance the inbox falls back to. Downgrading mid-month is therefore
    // generous rather than punitive, which is the right direction for a lapsed
    // subscription.
    expect(await deliver(inbox, DEPLOYMENT_DEFAULT + 5)).toBe(DEPLOYMENT_DEFAULT);
  });
});
