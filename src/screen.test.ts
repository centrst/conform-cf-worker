import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { readVerdict, screenMessages, screenSubmission, SCREEN_MODEL } from './screen';
import {
  TEST_FORM_ID,
  baseEnv,
  executionContext,
  installRoute,
  screeningAi,
} from './test-support';
import type { EmailMessageBuilder, Env, StoredRouteRecord } from './types';

const XEVIL =
  'XEvil 7.0 automatically solve most kind of captchas, Including such type of captchas: ' +
  'ReCaptcha v.2, ReCaptcha-3, Google captcha, SolveMedia, BitcoinFaucet, Steam, +12000';

function post(body: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function screened(answer: Parameters<typeof screeningAi>[0], extra: Partial<Env> = {}) {
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
  const requests: string[] = [];
  const routes = new Map<string, StoredRouteRecord>();
  const { ai, calls } = screeningAi(answer);
  const env: Env = {
    ...baseEnv({ routes, send, requests }),
    SPAM_SCREEN: 'true',
    AI: ai,
    ...extra,
  };
  await installRoute(env, routes, { alias: 'Oak & Orchard reservations' });
  const submit = (body: Record<string, string>, headers?: Record<string, string>) =>
    worker.fetch(post(body, headers), env, executionContext().ctx);
  return { env, send, requests, calls, submit };
}

const reserved = (requests: string[]) => requests.some((url) => url.endsWith('/reserve'));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readVerdict', () => {
  it.each([
    ['an object response', { response: { verdict: 'spam' } }, 'spam'],
    ['a JSON string response', { response: '{"verdict":"genuine"}' }, 'genuine'],
    ['unsure', { response: { verdict: 'unsure' } }, 'unsure'],
    ['a verdict outside the enum', { response: { verdict: 'SPAM' } }, 'unscreened'],
    ['prose instead of JSON', { response: 'This is spam.' }, 'unscreened'],
    ['no response at all', {}, 'unscreened'],
    ['null', null, 'unscreened'],
  ])('reads %s', (_label, result, expected) => {
    expect(readVerdict(result)).toBe(expected);
  });
});

describe('screenMessages', () => {
  it('names the form and fences the fields as untrusted', () => {
    const [system, user] = screenMessages('Oak & Orchard reservations', {
      name: 'Katysmar8638',
      note: XEVIL,
      tags: ['a', 'b'],
    });
    expect(system.role).toBe('system');
    expect(user.content).toContain('"Oak & Orchard reservations"');
    expect(user.content).toContain('<submission>\nname: Katysmar8638\n');
    expect(user.content).toContain('tags: a, b');
    expect(user.content.trimEnd().endsWith('</submission>')).toBe(true);
  });

  it('keeps the end of a padded value, where an advert can hide', () => {
    const [, user] = screenMessages('Contact', {
      note: `${'We would love to stay with you. '.repeat(100)}Buy XEvil now`,
    });
    expect(user.content).toContain('Buy XEvil now');
  });

  it('screens the subject line, which is delivered but is not a field', () => {
    const [, user] = screenMessages('Contact', { message: 'Hello' }, 'Buy XEvil captcha solver');
    expect(user.content).toContain('Email subject line: Buy XEvil captcha solver');
  });

  it('clips a long value and a long body', () => {
    const [, user] = screenMessages('Contact', {
      a: 'x'.repeat(5000),
      b: 'y'.repeat(5000),
      c: 'z'.repeat(5000),
      d: 'w'.repeat(5000),
      e: 'v'.repeat(5000),
    });
    expect(user.content).not.toContain('x'.repeat(1501));
    expect(user.content.length).toBeLessThan(6200);
  });
});

describe('screenSubmission', () => {
  it('delivers unscreened when the model stalls past the timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ai } = screeningAi(() => new Promise(() => undefined));
    expect(await screenSubmission({ ...baseEnv(), AI: ai }, 'Contact', { note: XEVIL }, undefined, 10)).toBe(
      'unscreened',
    );
  });

  it('delivers unscreened when the model fails, and logs no field', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ai } = screeningAi(async () => {
      // An upstream that quotes what it rejected.
      throw new Error(`3010: Invalid input: ${XEVIL}`);
    });
    expect(await screenSubmission({ ...baseEnv(), AI: ai }, 'Contact', { note: XEVIL })).toBe(
      'unscreened',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('XEvil');
  });

  it('asks the pinned model for a constrained verdict', async () => {
    const { ai, calls } = screeningAi({ response: { verdict: 'genuine' } });
    await screenSubmission({ ...baseEnv(), AI: ai }, 'Contact', { note: 'hello' });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(SCREEN_MODEL);
    expect(calls[0].inputs).toMatchObject({
      response_format: { type: 'json_schema' },
      temperature: 0,
    });
  });
});

describe('the spam screen on /f/', () => {
  it('refuses an advert with 422 submission_refused, before any quota or email', async () => {
    const { submit, send, requests } = await screened({ response: { verdict: 'spam' } });

    const response = await submit({ name: 'Katysmar8638', note: XEVIL });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'submission_refused' });
    expect(send).not.toHaveBeenCalled();
    expect(reserved(requests)).toBe(false);
  });

  it('shows the model the subject the sender chose', async () => {
    const { submit, calls } = await screened({ response: { verdict: 'genuine' } });

    await submit({ message: 'Hello', _subject: 'Buy XEvil captcha solver' });

    expect(JSON.stringify(calls[0].inputs)).toContain('Buy XEvil captcha solver');
  });

  it('tells a browser it was not sent, rather than pretending it was', async () => {
    const { submit } = await screened({ response: { verdict: 'spam' } });

    const response = await submit({ note: XEVIL }, { Accept: 'text/html' });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain('contact the recipient another way');
  });

  it.each(['genuine', 'unsure'])('delivers a %s verdict', async (verdict) => {
    const { submit, send } = await screened({ response: { verdict } });

    const response = await submit({ name: 'Maria', note: 'Nov 6 to 9, two adults' });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('delivers when the model fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { submit, send } = await screened(async () => {
      throw new Error('upstream error');
    });

    expect((await submit({ note: 'hello' })).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('answers a dry run the way the real submission would be answered', async () => {
    const { submit, send } = await screened({ response: { verdict: 'spam' } });

    const response = await submit({ note: XEVIL, _dry_run: 'true' });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'submission_refused' });
    expect(send).not.toHaveBeenCalled();
  });

  it('never asks the model about a submission the honeypot caught', async () => {
    const { submit, calls } = await screened({ response: { verdict: 'spam' } });

    expect((await submit({ note: XEVIL, _gotcha: 'filled' })).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('never asks the model about a submission the schema refused', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const { ai, calls } = screeningAi({ response: { verdict: 'spam' } });
    const env: Env = { ...baseEnv({ routes, send }), SPAM_SCREEN: 'true', AI: ai };
    await installRoute(env, routes, {
      schema: { strict: true, fields: { note: { type: 'text' } } },
    });

    const response = await worker.fetch(
      post({ note: XEVIL, submit: '' }),
      env,
      executionContext().ctx,
    );

    expect(await response.json()).toMatchObject({ error: 'submission_invalid' });
    expect(calls).toHaveLength(0);
  });

  it('is off unless SPAM_SCREEN is "true", even with an AI binding', async () => {
    const { submit, send, calls } = await screened(
      { response: { verdict: 'spam' } },
      { SPAM_SCREEN: undefined },
    );

    expect((await submit({ note: XEVIL })).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('is off without an AI binding, rather than failing every submission', async () => {
    const { submit, send } = await screened({ response: { verdict: 'spam' } }, { AI: undefined });

    expect((await submit({ note: XEVIL })).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
