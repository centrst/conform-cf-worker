import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import {
  TEST_FORM_ID,
  baseEnv,
  executionContext,
  installRoute,
  screeningAi,
} from './test-support';
import type { EmailMessageBuilder, Env, StoredRouteRecord } from './types';

const SCHEMA = { strict: true, fields: { note: { type: 'text' as const } } };

async function setup(options: { drop?: boolean; spam?: boolean } = {}) {
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
  const requests: string[] = [];
  const routes = new Map<string, StoredRouteRecord>();
  const env: Env = {
    ...baseEnv({ routes, send, requests }),
    ...(options.drop === false ? {} : { DROP_REFUSED: 'true' }),
    ...(options.spam
      ? { SPAM_SCREEN: 'true', AI: screeningAi({ response: { verdict: 'spam' } }).ai }
      : {}),
  };
  await installRoute(env, routes, { schema: SCHEMA });
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const submit = (body: Record<string, string>) =>
    worker.fetch(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      executionContext().ctx,
    );
  return { send, requests, log, submit };
}

const reserved = (requests: string[]) => requests.some((url) => url.endsWith('/reserve'));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DROP_REFUSED', () => {
  it('drops a schema refusal: success answer, no email, no quota, one log line', async () => {
    const { submit, send, requests, log } = await setup();

    const response = await submit({ note: 'Hola, quería saber tu precio..', submit: '' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, message: 'Submission received' });
    expect(send).not.toHaveBeenCalled();
    expect(reserved(requests)).toBe(false);
    const dropped = log.mock.calls.filter(([first]) => first === 'Submission dropped:');
    expect(dropped).toHaveLength(1);
    expect(JSON.parse(dropped[0][1] as string)).toEqual({
      form_id: TEST_FORM_ID,
      reason: 'schema',
      dry_run: false,
    });
  });

  it('drops a spam refusal the same way', async () => {
    const { submit, send, log } = await setup({ spam: true });

    const response = await submit({ note: 'XEvil 7.0 automatically solve most kind of captchas' });

    expect(await response.json()).toEqual({ success: true, message: 'Submission received' });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls.find(([first]) => first === 'Submission dropped:')![1] as string))
      .toMatchObject({ reason: 'spam' });
  });

  it('answers exactly as the honeypot does', async () => {
    const { submit } = await setup();

    const trapped = await submit({ note: 'hello', _gotcha: 'filled' });
    const dropped = await submit({ note: 'hello', submit: '' });

    expect(dropped.status).toBe(trapped.status);
    expect(await dropped.text()).toBe(await trapped.text());
  });

  it('follows the form redirect, so a browser-shaped bot lands on the thank-you page', async () => {
    const { submit } = await setup();

    const response = await submit({ note: 'hello', submit: '', _redirect: 'https://example.com/thanks' });

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://example.com/thanks');
  });

  it('never logs a field', async () => {
    const { submit, log } = await setup();

    await submit({ note: 'Hola, quería saber tu precio..', submit: '' });

    expect(JSON.stringify(log.mock.calls)).not.toContain('precio');
  });

  it('delivers a clean submission, and answers it exactly as it answers a drop', async () => {
    const { submit, send } = await setup();

    const delivered = await submit({ note: 'Two adults, Nov 6 to 9', _test: 'nonce' });
    const dropped = await submit({ note: 'hello', submit: '', _test: 'nonce' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(delivered.status).toBe(dropped.status);
    expect(await delivered.text()).toBe(await dropped.text());
  });

  it('refuses out loud when it is off', async () => {
    const { submit, send } = await setup({ drop: false });

    const response = await submit({ note: 'hello', submit: '' });

    expect(response.status).toBe(422);
    expect(send).not.toHaveBeenCalled();
  });
});
