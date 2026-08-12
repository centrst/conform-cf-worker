import { SERVER_INSTRUCTIONS, TOOLS, type ToolContext } from './tools';

/**
 * conForm MCP server — a stateless Model Context Protocol endpoint over the
 * Streamable HTTP transport, implemented directly on JSON-RPC to keep this
 * repository at zero runtime dependencies. Every tool proxies the public
 * conForm HTTP API; the server holds no sessions and no state.
 */

export interface McpEnv {
  /** Base URL of the conForm API this server fronts. */
  CONFORM_BASE_URL?: string;
  SOURCE_COMMIT?: string;
}

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const LATEST_PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version',
};

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
  });
}

function rpcResult(id: JsonRpcMessage['id'], result: unknown): Response {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: JsonRpcMessage['id'], code: number, message: string): Response {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

async function handleRequest(message: JsonRpcMessage, context: ToolContext): Promise<Response> {
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return rpcResult(message.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'conform', title: 'conForm', version: '0.1.0' },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(message.id, {});
    case 'tools/list':
      return rpcResult(message.id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    case 'tools/call': {
      const name = message.params?.name;
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(message.id, -32602, `Unknown tool: ${String(name)}`);
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return rpcResult(message.id, await tool.handler(args, context));
      } catch (error) {
        return rpcResult(message.id, {
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : 'Tool execution failed',
            },
          ],
          isError: true,
        });
      }
    }
    default:
      return rpcError(message.id, -32601, `Method not found: ${String(message.method)}`);
  }
}

/**
 * Handle one MCP request.
 *
 * `fetcher` is how the tools reach the conForm API. It is injected so the
 * delivery engine can serve /mcp from its own Worker and dispatch tool calls
 * in process, rather than making the Worker re-enter itself over the network.
 */
export async function handleMcp(
  request: Request,
  env: McpEnv,
  fetcher: typeof fetch = fetch.bind(globalThis),
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method === 'GET') {
    // Stateless server: no SSE stream to resume.
    return jsonResponse(
      {
        name: 'conform-mcp',
        transport: 'streamable-http',
        protocol: LATEST_PROTOCOL_VERSION,
        usage: 'POST JSON-RPC messages to this URL',
        version: env.SOURCE_COMMIT || 'development',
      },
      200,
    );
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let message: JsonRpcMessage;
  try {
    message = (await request.json()) as JsonRpcMessage;
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (Array.isArray(message)) {
    return rpcError(null, -32600, 'Batch requests are not supported');
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message.id ?? null, -32600, 'Invalid request');
  }
  // Notifications (no id) are accepted and acknowledged without a body.
  if (message.id === undefined && message.method.startsWith('notifications/')) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  const context: ToolContext = {
    baseUrl: (env.CONFORM_BASE_URL || new URL(request.url).origin).replace(/\/+$/u, ''),
    fetcher,
  };
  return handleRequest(message, context);
}

// Standalone entry point, for deploying the MCP server on its own.
export default {
  async fetch(request: Request, env: McpEnv): Promise<Response> {
    return handleMcp(request, env);
  },
} satisfies ExportedHandler<McpEnv>;
