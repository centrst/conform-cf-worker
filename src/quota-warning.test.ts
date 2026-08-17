import { describe, expect, it } from 'vitest';
import { sendQuotaWarning } from './email';
import worker from './index';
import { lowMark } from './quota';
import type { Env, RouteTokenPayload, StoredRouteRecord } from './types';
import { TEST_FORM_ID, baseEnv, executionContext, installRoute } from './test-support';

const route: RouteTokenPayload = {
  kind: 'route',
  version: 1,
  email: 'owner@example.com',
  formName: 'Contact',
  ownerId: 'opaque-owner',
  routeId: 'cfm_ABCDEFGHJKLMNPQR',
  issuedAt: 0,
};

function envWithMailbox(): { env: Env; sent: any[] } {
  const sent: any[] = [];
  const env = baseEnv();
  env.EMAIL = { send: async (message: any) => void sent.push(message) } as unknown as Env['EMAIL'];
  return { env, sent };
}

describe('quota warning email', () => {
  it('gives every suggestion somewhere to go', async () => {
    const { env, sent } = envWithMailbox();

    await sendQuotaWarning(env, route, 200, 250, '2026-08');
    await sendQuotaWarning(env, route, 250, 250, '2026-08');

    expect(sent).toHaveLength(2);
    for (const message of sent) {
      // The defect was a bare "Upgrade to keep receiving submissions" with no
      // link and no reset date: nothing to click at the reader's most
      // frustrated moment. Naming a route out is fine; naming one they cannot
      // follow is not.
      const suggestions = message.text
        .split('\n')
        .filter((line: string) => /conForm\+|run conForm yourself/u.test(line));
      expect(suggestions.length).toBeGreaterThan(0);
      for (const line of suggestions) {
        const index = message.text.indexOf(line);
        expect(message.text.slice(index)).toMatch(/https?:\/\//u);
      }
    }
  });

  it('points at conForm+ for a bigger hosted allowance', async () => {
    const { env, sent } = envWithMailbox();
    env.DOCS_URL = 'https://centrst.com/conform/docs/';

    await sendQuotaWarning(env, route, 250, 250, '2026-08');

    expect(sent[0].text).toContain('conForm+');
    expect(sent[0].text).toContain('https://centrst.com/conform/#conform-plus');
  });

  it('omits conForm+ on a deployment that advertises no docs', async () => {
    const { env, sent } = envWithMailbox();
    delete env.DOCS_URL;

    await sendQuotaWarning(env, route, 250, 250, '2026-08');

    // A self-hoster has no conForm+ to buy; the self-host line still applies.
    expect(sent[0].text).not.toContain('conForm+');
    expect(sent[0].text).toContain('run conForm yourself');
  });

  it('gives the reset date in both the low and exhausted mails', async () => {
    const { env, sent } = envWithMailbox();

    await sendQuotaWarning(env, route, 200, 250, '2026-08');
    await sendQuotaWarning(env, route, 250, 250, '2026-08');

    // August's allowance resets at the start of September.
    for (const message of sent) {
      expect(message.text).toContain('1 September 2026');
    }
    expect(sent[1].subject).toContain('1 September 2026');
  });

  it('rolls the reset date into the next year in December', async () => {
    const { env, sent } = envWithMailbox();
    await sendQuotaWarning(env, route, 250, 250, '2026-12');
    expect(sent[0].text).toContain('1 January 2027');
  });

  it('distinguishes running low from being full', async () => {
    const { env, sent } = envWithMailbox();

    await sendQuotaWarning(env, route, 200, 250, '2026-08');
    expect(sent[0].subject).toContain('running low');
    expect(sent[0].text).toContain('200 of the 250');
    expect(sent[0].text).not.toContain('not being delivered');

    await sendQuotaWarning(env, route, 250, 250, '2026-08');
    expect(sent[1].subject).toContain('full');
    expect(sent[1].text).toContain('not being delivered');
  });

  it('offers self-hosting, pointing at this deployment’s own source', async () => {
    const { env, sent } = envWithMailbox();
    env.SOURCE_URL = 'https://github.com/someone/their-fork';

    await sendQuotaWarning(env, route, 250, 250, '2026-08');

    expect(sent[0].text).toContain('https://github.com/someone/their-fork');
  });

  it('falls back to the upstream source when SOURCE_URL is unset', async () => {
    const { env, sent } = envWithMailbox();
    delete env.SOURCE_URL;

    await sendQuotaWarning(env, route, 250, 250, '2026-08');

    expect(sent[0].text).toContain('https://github.com/centrst/conform-cf-worker');
  });

  it('says the allowance is shared across forms, not per form', async () => {
    const { env, sent } = envWithMailbox();
    await sendQuotaWarning(env, route, 200, 250, '2026-08');
    expect(sent[0].text).toContain('shared by every form delivering to this inbox');
  });

  it('sends to the route destination and never includes submission content', async () => {
    const { env, sent } = envWithMailbox();
    await sendQuotaWarning(env, route, 250, 250, '2026-08');

    expect(sent[0].to).toBe('owner@example.com');
    expect(sent[0].attachments).toBeUndefined();
  });

  it('strips control characters from the subject', async () => {
    const { env, sent } = envWithMailbox();
    await sendQuotaWarning(env, route, 250, 250, '2026-08');
    expect(sent[0].subject).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });
});

describe('quota warning marks', () => {
  it('puts the low mark at 80% of the limit', () => {
    expect(lowMark(250)).toBe(200);
    expect(lowMark(10)).toBe(8);
    expect(lowMark(3)).toBe(3);
  });

  it('never puts the low mark below the first submission', () => {
    // ceil(1 * 0.8) is 1, and a limit of 1 must still be able to warn.
    expect(lowMark(1)).toBe(1);
    expect(lowMark(0)).toBe(1);
  });
});

describe('the submission pipeline sends the warning', () => {
  // The Durable Object decides whether a warning is due and says so on the
  // reservation; these specs cover what the pipeline does with that answer.
  // Whether the answer is correct is covered in quota.workers.test.ts.
  async function submitWithReservation(used: number, warn?: 'low' | 'full') {
    const routes = new Map<string, StoredRouteRecord>();
    const sent: any[] = [];
    const env = baseEnv({
      routes,
      reservation: { allowed: true, used, limit: 250, month: '2026-08', ...(warn ? { warn } : {}) },
    });
    env.EMAIL = {
      send: async (message: any) => void sent.push(message),
    } as unknown as Env['EMAIL'];
    await installRoute(env, routes);

    const { ctx, promises } = executionContext();
    await worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      }),
      env,
      ctx,
    );
    await Promise.all(promises);
    return sent;
  }

  it('warns with a real reset date when the reservation claims the low mark', async () => {
    const sent = await submitWithReservation(200, 'low');
    const warning = sent.find((message) => /allowance/u.test(message.subject));

    expect(warning, 'no allowance warning was sent at the 80% mark').toBeDefined();
    expect(warning.subject).toContain('running low');
    // The month must reach the copy, or the reset date silently reads as NaN.
    expect(warning.text).toContain('1 September 2026');
  });

  it('stays quiet on an ordinary submission below the mark', async () => {
    const sent = await submitWithReservation(3);
    expect(sent.some((message) => /allowance/u.test(message.subject))).toBe(false);
  });

  it('stays quiet at the mark when the reservation did not claim it', async () => {
    // The count alone must not trigger anything: this is the resend the old
    // used === mark test produced after a rollback.
    const sent = await submitWithReservation(200);
    expect(sent.some((message) => /allowance/u.test(message.subject))).toBe(false);
  });
});
