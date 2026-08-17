import { describe, expect, it } from 'vitest';
import { sendQuotaWarning } from './email';
import worker, { thresholdCrossed } from './index';
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
    // Without DOCS_URL the conForm+ line is omitted entirely, and this spec
    // would only ever check the self-host line.
    env.DOCS_URL = 'https://centrst.com/conform/docs/';

    await sendQuotaWarning(env, route, 200, 250, '2026-08');
    await sendQuotaWarning(env, route, 250, 250, '2026-08');

    expect(sent).toHaveLength(2);
    for (const message of sent) {
      // The defect was a bare "Upgrade to keep receiving submissions" with no
      // link and no reset date: nothing to click at the reader's most
      // frustrated moment. Naming a route out is fine; naming one they cannot
      // follow is not.
      const lines: string[] = message.text.split('\n');
      const suggestions = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /conForm\+|run conForm yourself/u.test(line));
      expect(suggestions.length).toBeGreaterThan(0);
      for (const { line, index } of suggestions) {
        // The URL must be on the very next line. Searching the remainder of the
        // message would let one suggestion's link satisfy another's.
        expect(lines[index + 1] ?? '', line).toMatch(/^https?:\/\//u);
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

describe('quota warning thresholds', () => {
  it('fires at exactly 80% and at exhaustion, and nowhere else', () => {
    const firing = [];
    for (let used = 1; used <= 250; used += 1) {
      if (thresholdCrossed(used, 250)) firing.push(used);
    }
    expect(firing).toEqual([200, 250]);
  });

  it('never fires when the limit is disabled', () => {
    expect(thresholdCrossed(1, 0)).toBe(false);
    expect(thresholdCrossed(0, 0)).toBe(false);
    expect(thresholdCrossed(5, -1)).toBe(false);
  });

  it('still warns once on a limit too small for a distinct 80% mark', () => {
    // ceil(1 * 0.8) === 1, so the low and exhausted marks coincide.
    expect(thresholdCrossed(1, 1)).toBe(true);
  });

  it('is exact-equality, so a rolled-back count can warn twice', () => {
    // A delivery failure rolls the reservation back, so 200 can be reached
    // again and re-trigger. Documented in #26; asserted here so the behaviour
    // is not mistaken for intent when someone fixes it.
    expect(thresholdCrossed(200, 250)).toBe(true);
    expect(thresholdCrossed(199, 250)).toBe(false);
    expect(thresholdCrossed(201, 250)).toBe(false);
  });
});

describe('the submission pipeline sends the warning', () => {
  async function submitWithReservation(used: number) {
    const routes = new Map<string, StoredRouteRecord>();
    const sent: any[] = [];
    const env = baseEnv({
      routes,
      reservation: { allowed: true, used, limit: 250, month: '2026-08' },
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

  it('warns with a real reset date once the 80% mark is reached', async () => {
    const sent = await submitWithReservation(200);
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
});
