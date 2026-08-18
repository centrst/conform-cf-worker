import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type McpEnv } from './index';

const ENV: McpEnv = { CONFORM_BASE_URL: 'https://api.conform.test' };

afterEach(() => {
  vi.unstubAllGlobals();
});

function rpc(body: Record<string, unknown>): Request {
  return new Request('https://api.conform.test/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function call(body: Record<string, unknown>, env: McpEnv = ENV) {
  const response = await worker.fetch(rpc(body), env);
  return { response, body: (await response.json()) as Record<string, any> };
}

function stubApi(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(payload, { status });
    }),
  );
  return calls;
}

describe('conform MCP server', () => {
  it('initializes with tool capability, instructions, and a negotiated protocol', async () => {
    const { body } = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.capabilities).toEqual({ tools: {} });
    expect(body.result.serverInfo.name).toBe('conform');
    expect(body.result.instructions).toContain('Never claim delivery');
  });

  it('acknowledges the initialized notification with 202', async () => {
    const response = await worker.fetch(
      rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      ENV,
    );
    expect(response.status).toBe(202);
  });

  it('lists the five tools with input schemas', async () => {
    const { body } = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual([
      'create_form',
      'get_form_status',
      'get_install_code',
      'check_submission',
      'send_test_submission',
      'get_service_info',
    ]);
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.description).toBe('string');
    }
  });

  it('creates forms with a derived Idempotency-Key so retries are replay-safe', async () => {
    const calls = stubApi({ success: true, form_id: 'cfm_X' }, 202);
    const first = await call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'create_form',
        arguments: { email: 'owner@example.com', alias: 'Contact' },
      },
    });
    await call({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'create_form',
        arguments: { email: 'owner@example.com', alias: 'Contact' },
      },
    });
    expect(calls[0].url).toBe('https://api.conform.test/v1/routes');
    const headers = new Headers(calls[0].init?.headers);
    const key = headers.get('Idempotency-Key');
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Headers(calls[1].init?.headers).get('Idempotency-Key')).toBe(key);
    expect(first.body.result.isError).toBe(false);
    expect(first.body.result.content[0].text).toContain('cfm_X');
  });

  it('sends test submissions with the _test marker', async () => {
    const calls = stubApi({ success: true, test: true, echo: null });
    await call({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'send_test_submission', arguments: { form_id: 'cfm_ABCDEFGHJKLMNPQR' } },
    });
    expect(calls[0].url).toBe('https://api.conform.test/f/cfm_ABCDEFGHJKLMNPQR');
    expect(String(calls[0].init?.body)).toContain('"_test":"true"');
  });

  it('proxies install code untouched and flags API errors', async () => {
    const calls = stubApi(
      { success: false, error: 'route_not_found', message: 'Form route not found' },
      404,
    );
    const { body } = await call({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'get_install_code',
        arguments: { form_id: 'cfm_ABCDEFGHJKLMNPQR', framework: 'react' },
      },
    });
    expect(calls[0].url).toBe(
      'https://api.conform.test/v1/routes/cfm_ABCDEFGHJKLMNPQR/install?framework=react',
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('route_not_found');
  });

  it('falls back to the request origin when CONFORM_BASE_URL is unset', async () => {
    const calls = stubApi({ ok: true });
    await call(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_service_info', arguments: {} } },
      {},
    );
    expect(calls[0].url).toBe('https://api.conform.test/.well-known/conform.json');
  });

  it('rejects unknown methods and unknown tools', async () => {
    const unknownMethod = await call({ jsonrpc: '2.0', id: 8, method: 'nope' });
    expect(unknownMethod.body.error.code).toBe(-32601);
    const unknownTool = await call({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    expect(unknownTool.body.error.code).toBe(-32602);
  });
});
