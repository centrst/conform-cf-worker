import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { isPlaceholderFormId, placeholderFormIds } from './placeholders';
import { baseEnv, executionContext } from './test-support';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BODY = 'name=Sam&email=sam%40example.com&message=hello';

function submit(formId: string, accept: string): Request {
  return new Request(`https://api.conform.test/f/${formId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: accept },
    body: BODY,
  });
}

describe('placeholder form IDs', () => {
  it('recognises every published sample and nothing else', () => {
    for (const id of placeholderFormIds()) {
      expect(isPlaceholderFormId(id)).toBe(true);
    }
    expect(isPlaceholderFormId('cfm_S47E3ALHLBWTMZWD')).toBe(false);
    expect(isPlaceholderFormId('')).toBe(false);
  });

  it('includes the sample ID used throughout the docs', () => {
    // Published in the README, the install docs and the site snippets. If this
    // ever stops matching, every copied sample silently 404s again.
    expect(isPlaceholderFormId('cfm_7K4P9X2M8RWD3JNH')).toBe(true);
  });
});

describe('posting to a placeholder endpoint', () => {
  it('answers a browser with guidance instead of a bare 404', async () => {
    const { ctx } = executionContext();
    const response = await worker.fetch(
      submit('cfm_7K4P9X2M8RWD3JNH', 'text/html'),
      baseEnv(),
      ctx,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain('That was the example endpoint');
    expect(body).toContain('#create-form');
    // The visitor must be told their message did not arrive.
    expect(body).toMatch(/not (be )?delivered|not delivered/u);
  });

  it('answers a machine with a structured code and a next action', async () => {
    const { ctx } = executionContext();
    const response = await worker.fetch(
      submit('cfm_7K4P9X2M8RWD3JNH', 'application/json'),
      baseEnv(),
      ctx,
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, any>;
    expect(body.success).toBe(false);
    expect(body.error).toBe('placeholder_endpoint');
    expect(body.retryable).toBe(false);
    expect(body.next_action.type).toBe('create_route');
    expect(body.next_action.create_url).toContain('#create-form');
  });

  it('counts the attempt without recording anything the sender submitted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { ctx } = executionContext();
    await worker.fetch(submit('cfm_7K4P9X2M8RWD3JNH', 'text/html'), baseEnv(), ctx);

    const lines = log.mock.calls.map((call) => String(call[0]));
    const attempt = lines.find((line) => line.includes('placeholder_endpoint_attempt'));
    expect(attempt).toBeDefined();

    const event = JSON.parse(attempt as string);
    expect(event).toEqual({
      event: 'placeholder_endpoint_attempt',
      form_id: 'cfm_7K4P9X2M8RWD3JNH',
    });
    // Nothing the visitor typed may reach the logs.
    expect(attempt).not.toContain('sam@example.com');
    expect(attempt).not.toContain('Sam');
    expect(attempt).not.toContain('hello');
  });

  it('never reaches route lookup, quota, or email', async () => {
    const { ctx, promises } = executionContext();
    const env = baseEnv();
    const send = vi.fn();
    env.EMAIL = { send } as unknown as typeof env.EMAIL;

    await worker.fetch(submit('cfm_your_form_id', 'text/html'), env, ctx);

    expect(send).not.toHaveBeenCalled();
    expect(promises).toHaveLength(0);
  });

  it('points at the product page whether or not DOCS_URL ends in a slash', async () => {
    const { ctx } = executionContext();
    for (const docsUrl of [
      'https://centrst.com/conform/docs/',
      'https://centrst.com/conform/docs',
    ]) {
      const env = baseEnv();
      env.DOCS_URL = docsUrl;
      const response = await worker.fetch(
        submit('cfm_7K4P9X2M8RWD3JNH', 'application/json'),
        env,
        ctx,
      );
      const body = (await response.json()) as Record<string, any>;
      expect(body.next_action.create_url, `DOCS_URL=${docsUrl}`).toBe(
        'https://centrst.com/conform/#create-form',
      );
    }
  });

  it('leaves unknown non-placeholder IDs on the ordinary not-found path', async () => {
    const { ctx } = executionContext();
    const response = await worker.fetch(
      submit('cfm_QQQQQQQQQQQQQQQQ', 'application/json'),
      baseEnv(),
      ctx,
    );

    const body = (await response.json()) as Record<string, any>;
    expect(body.error).toBe('route_not_found');
  });
});
