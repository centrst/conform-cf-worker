import openapiSpec from '../openapi.json';
import { deliveryMode, maxRequestSize, monthlyLimit } from './config';
import { POLL_INTERVAL_SECONDS } from './contract';
import { publicUrl } from './email';
import type { Env } from './types';

/**
 * One generator, several URLs: the same discovery document is served at
 * GET /, GET /health, and GET /.well-known/conform.json so that any probe of
 * a conForm deployment — hosted or self-hosted — is self-describing. Every
 * value derives from env, so self-hosters inherit correct discovery for free.
 */
export function discoveryDocument(env: Env, origin: string): Record<string, unknown> {
  const base = publicUrl(env, origin);
  return {
    name: 'conform-cf-worker',
    api_version: openapiSpec.info.version,
    version: env.SOURCE_COMMIT || 'development',
    source: env.SOURCE_URL || 'https://github.com/centrst/conform-cf-worker',
    base_url: base,
    openapi_url: `${base}/openapi.json`,
    llms_txt: `${base}/llms.txt`,
    ...(env.DOCS_URL ? { docs_url: env.DOCS_URL } : {}),
    ...(env.MCP_URL ? { mcp: { url: env.MCP_URL, transport: 'streamable-http' } } : {}),
    auth: 'none',
    endpoints: {
      create_form: {
        method: 'POST',
        path: '/v1/routes',
        idempotency: 'Idempotency-Key header',
      },
      form_status: { method: 'GET', path: '/v1/routes/{form_id}' },
      delete_form: {
        method: 'DELETE',
        path: '/v1/routes/{form_id}',
        auth: 'Bearer management_token',
      },
      install_code: {
        method: 'GET',
        path: '/v1/routes/{form_id}/install?framework={framework}',
      },
      install_generic: { method: 'GET', path: '/v1/install?framework={framework}' },
      submit: { method: 'POST', path: '/f/{form_id}' },
    },
    verification: {
      model:
        deliveryMode(env) === 'verified'
          ? 'cloudflare_destination_address_email'
          : 'conform_confirmation_email',
      human_step_required: true,
      instructions:
        'The destination inbox receives a verification email. A human must confirm it. ' +
        'Poll form_status until status is "active" — the endpoint URL never changes ' +
        'while pending, so the form can be installed immediately.',
      poll_interval_seconds: POLL_INTERVAL_SECONDS,
    },
    test_submissions: { field: '_test', value: 'true' },
    limits: {
      monthly_submissions_per_inbox: monthlyLimit(env),
      max_request_bytes: maxRequestSize(env),
      registrations_per_minute: 5,
    },
    delivery_mode: deliveryMode(env),
    persistence: {
      submission_fields: false,
      destination_email_plaintext: false,
      route: [
        'form id',
        'alias',
        'opaque inbox id',
        'encrypted destination',
        'verification status',
        'Cloudflare destination id',
      ],
      quota: ['opaque inbox id', 'UTC month', 'used count', 'limit'],
      workers_kv: false,
    },
  };
}

/** A compact, API-contract-only llms.txt served by every deployment. */
export function llmsText(env: Env, origin: string): string {
  const base = publicUrl(env, origin);
  const limit = monthlyLimit(env);
  return `# conForm

> Form-to-email API by Centrst. One POST creates a permanent form endpoint that
> delivers submissions to a verified inbox. No account, no API key, no
> submission storage. Open-source MIT engine, self-hostable on Cloudflare
> Workers.

Key facts for agents

- API base: ${base} — discovery: GET / or /.well-known/conform.json
- Create: POST /v1/routes {"email":"you@example.com","alias":"Contact"} -> {form_id, endpoint, status, management_token}
- Send an Idempotency-Key header so retries return the SAME endpoint instead of minting new ones.
- One human step: the destination inbox must confirm a verification email before
  delivery starts. Poll GET /v1/routes/{form_id} (next_action tells you exactly
  what to do). The endpoint URL is stable while pending — install the form immediately.
- Ready-to-install code: GET /v1/routes/{form_id}/install?framework=html|js|react|vue|svelte|astro|nextjs
- Test delivery without polluting real traffic: include _test=true in a submission;
  the response echoes test:true as proof. A test response WITHOUT test:true means
  the submission was spam-filtered — never populate the hidden _gotcha field.
- Clean up: DELETE /v1/routes/{form_id} with "Authorization: Bearer <management_token>".
- Quota: one inbox = one monthly allowance${limit > 0 ? ` (${limit} deliveries/month)` : ''} —
  +tags, Gmail dots, and provider domain aliases count as the same inbox.
- Every error is JSON: {success:false, error:<stable_code>, message, retryable}.

## Machine interfaces

- OpenAPI: ${base}/openapi.json
- Discovery document: ${base}/.well-known/conform.json
${env.MCP_URL ? `- MCP server: ${env.MCP_URL}\n` : ''}${env.DOCS_URL ? `- Docs: ${env.DOCS_URL}\n` : ''}- Source: ${env.SOURCE_URL || 'https://github.com/centrst/conform-cf-worker'}
`;
}
