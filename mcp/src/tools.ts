/**
 * conForm MCP tools. Every tool is a thin proxy over the public HTTP API —
 * the API is the single source of truth; nothing here adds behavior.
 */

export interface ToolContext {
  baseUrl: string;
  fetcher: typeof fetch;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export const SERVER_INSTRUCTIONS =
  'Workflow: create_form → tell the human to click the verification email sent to the ' +
  'destination inbox → poll get_form_status until status is "active" → get_install_code ' +
  '→ install it → send_test_submission and confirm the response carries test: true → ' +
  'report the result. The endpoint URL is stable while verification is pending, so the ' +
  'form can be installed immediately. Never claim delivery works before status is ' +
  '"active". A test response without test: true means the submission was spam-filtered — ' +
  'never populate the hidden _gotcha field.';

async function apiResult(
  context: ToolContext,
  path: string,
  init?: RequestInit,
): Promise<ToolResult> {
  const response = await context.fetcher(`${context.baseUrl}${path}`, init);
  let text: string;
  try {
    text = JSON.stringify(await response.json(), null, 2);
  } catch {
    text = JSON.stringify({
      success: false,
      error: 'internal_error',
      message: `Non-JSON response with status ${response.status}`,
    });
  }
  return { content: [{ type: 'text', text }], isError: !response.ok };
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

async function defaultIdempotencyKey(email: string, alias: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${email.trim().toLowerCase()}|${alias.trim()}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'create_form',
    title: 'Create a form endpoint',
    description:
      'Creates a permanent form endpoint that delivers submissions to the given inbox by ' +
      'email. No account required. Returns form_id, endpoint, status, a management_token ' +
      '(store it — it authorizes deletion), and next_action. If status is ' +
      '"pending_verification", a human must click the verification email sent to the ' +
      'inbox; poll get_form_status until "active". Calls are idempotent: retries with the ' +
      'same email and alias return the same endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Destination inbox for submissions.' },
        alias: { type: 'string', description: 'Human label for the form, e.g. "Contact".' },
        idempotency_key: {
          type: 'string',
          description:
            'Optional replay key. Defaults to a hash of email and alias, so retrying this tool never creates duplicate endpoints.',
        },
      },
      required: ['email', 'alias'],
      additionalProperties: false,
    },
    async handler(args, context) {
      const email = requireString(args, 'email');
      const alias = requireString(args, 'alias');
      const key =
        typeof args.idempotency_key === 'string' && args.idempotency_key.trim()
          ? args.idempotency_key.trim()
          : await defaultIdempotencyKey(email, alias);
      return apiResult(context, '/v1/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ email, alias }),
      });
    },
  },
  {
    name: 'get_form_status',
    title: 'Check form verification status',
    description:
      'Returns the current status of a form endpoint and a next_action block. Polling ' +
      'this refreshes verification, so the route activates as soon as the human confirms.',
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The cfm_… form identifier.' },
      },
      required: ['form_id'],
      additionalProperties: false,
    },
    async handler(args, context) {
      const formId = requireString(args, 'form_id');
      return apiResult(context, `/v1/routes/${encodeURIComponent(formId)}`);
    },
  },
  {
    name: 'get_install_code',
    title: 'Get ready-to-install form code',
    description:
      'Returns accessible form code with the route’s endpoint baked in, installation ' +
      'notes, the current status with next_action, and a test_command. Frameworks: html ' +
      '(zero-JS baseline), js, react, vue, svelte, astro, nextjs. Vite projects use js.',
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The cfm_… form identifier.' },
        framework: {
          type: 'string',
          enum: ['html', 'js', 'react', 'vue', 'svelte', 'astro', 'nextjs'],
          description: 'Which artifact to generate. Defaults to html.',
        },
      },
      required: ['form_id'],
      additionalProperties: false,
    },
    async handler(args, context) {
      const formId = requireString(args, 'form_id');
      const framework =
        typeof args.framework === 'string' && args.framework ? args.framework : 'html';
      return apiResult(
        context,
        `/v1/routes/${encodeURIComponent(formId)}/install?framework=${encodeURIComponent(framework)}`,
      );
    },
  },
  {
    name: 'send_test_submission',
    title: 'Send a marked test submission',
    description:
      'Sends a _test-marked submission through the form. It is delivered for real with a ' +
      '[Test] subject and consumes one quota unit; the response carries test: true and an ' +
      'echo field as machine-checkable proof. A response without test: true means the ' +
      'submission was spam-filtered.',
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The cfm_… form identifier.' },
        fields: {
          type: 'object',
          description: 'Optional form fields. Defaults to a small name/email/message set.',
          additionalProperties: true,
        },
      },
      required: ['form_id'],
      additionalProperties: false,
    },
    async handler(args, context) {
      const formId = requireString(args, 'form_id');
      const fields =
        args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
          ? (args.fields as Record<string, unknown>)
          : {
              name: 'Test',
              email: 'test@example.com',
              message: 'conForm test submission',
            };
      return apiResult(context, `/f/${encodeURIComponent(formId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...fields, _test: 'true' }),
      });
    },
  },
  {
    name: 'get_service_info',
    title: 'Get service discovery information',
    description:
      'Returns the deployment’s discovery document: endpoints, verification model, ' +
      'limits, delivery mode, and its storage/privacy posture (no submission storage).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_args, context) {
      return apiResult(context, '/.well-known/conform.json');
    },
  },
];
