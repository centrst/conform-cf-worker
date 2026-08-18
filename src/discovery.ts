import openapiSpec from '../openapi.json';
import {
  dailyLimit,
  deliveryMode,
  maxFieldLength,
  maxFields,
  maxRequestSize,
  monthlyLimit,
} from './config';
import { POLL_INTERVAL_SECONDS } from './contract';
import { publicUrl } from './email';
import { RULE_LIMITS } from './rules';
import { FIELD_TYPES } from './schema';
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
      account_forms: {
        method: 'POST',
        path: '/v1/account/routes',
        auth: 'Bearer ACCOUNT_LOOKUP_SECRET (optional trusted broker interface)',
      },
      form_status: { method: 'GET', path: '/v1/routes/{form_id}' },
      delete_form: {
        method: 'DELETE',
        path: '/v1/routes/{form_id}',
        auth: 'Bearer management_token',
      },
      claim_existing_form: {
        method: 'POST',
        path: '/v1/routes/{form_id}/claim',
        auth: 'Bearer management_token',
      },
      rotate_access_key: {
        method: 'POST',
        path: '/v1/routes/{form_id}/keys',
        auth: 'Bearer rotation_token or management_token',
      },
      list_access_keys: {
        method: 'GET',
        path: '/v1/routes/{form_id}/keys',
        auth: 'Bearer rotation_token or management_token',
      },
      route_settings: {
        method: 'POST',
        path: '/v1/routes/{form_id}/settings',
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
    // What a form may declare about itself, so an agent can write a schema
    // that will be accepted rather than discovering the limits by rejection.
    declared_shape: {
      field_types: [...FIELD_TYPES],
      cross_field_rules: {
        example: { when: 'adults + children > 6', reject: 'Permitted for 6 guests.' },
        operators: ['+', '-', '*', '/', '>', '>=', '<', '<=', '==', '!=', '&&', '||', '!'],
        functions: ['present(field)'],
        limits: RULE_LIMITS,
      },
    },
    limits: {
      monthly_submissions_per_inbox: monthlyLimit(env),
      daily_submissions_per_inbox: dailyLimit(env),
      max_request_bytes: maxRequestSize(env),
      max_fields: maxFields(env),
      max_field_length: maxFieldLength(env),
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
        'encrypted form schema, when declared',
        'verification status',
        'access-key enforcement flag',
        'access-key HMACs, never key values',
        'Cloudflare destination id',
      ],
      quota: ['opaque inbox id', 'UTC month', 'UTC day', 'used count', 'limit'],
      account_form_index: ['opaque inbox id', 'form ids', 'created timestamps'],
      workers_kv: false,
    },
  };
}

/** A compact, API-contract-only llms.txt served by every deployment. */
export function llmsText(env: Env, origin: string): string {
  const base = publicUrl(env, origin);
  const limit = monthlyLimit(env);
  // "by Centrst" is the hosted service's own claim and belongs only on the
  // hosted deployment. A self-hoster's llms.txt told agents their origin was
  // somebody else's product, which is a branding claim they never made.
  const operator = env.OPERATOR_NAME?.trim();
  return `# conForm

> Form-to-email API${operator ? ` by ${operator}` : ''}. One POST creates a permanent form endpoint that
> delivers submissions to a verified inbox. No account, no API key, no
> submission storage. Open-source MIT engine, self-hostable on Cloudflare
> Workers.

Key facts for agents

- API base: ${base} — discovery: GET / or /.well-known/conform.json
- Create: POST /v1/routes {"email":"you@example.com","alias":"Contact"} -> {form_id, endpoint, status, management_token, rotation_token}
  management_token deletes the route; rotation_token only mints access keys, so it is the one that belongs in CI.
- Send an Idempotency-Key header so retries return the SAME endpoint instead of minting new ones.
- One human step: the destination inbox must confirm a verification email before
  delivery starts. Poll GET /v1/routes/{form_id} (next_action tells you exactly
  what to do). The endpoint URL is stable while pending — install the form immediately.
- Ready-to-install code: GET /v1/routes/{form_id}/install?framework=html|js|react|vue|svelte|astro|nextjs
- Prove a form works WITHOUT sending anything: include _dry_run=true. Every check runs
  (route active, access key, declared schema, allowance) and nothing is spent — no email,
  no webhook, no quota. The response is {dry_run:true, delivered:false, would_deliver, quota}.
  Errors are byte-identical to a real submission's for route state, access key and schema, so this is
  the cheapest way to verify an install. The allowance is REPORTED, not refused: a spent allowance
  answers 200 with would_deliver:false where a real submission answers 429. quota and delivery are
  included only when the request carried an accepted access_key.
- Test real end-to-end delivery: include _test=true; a real email arrives with a [Test] subject and
  the response echoes test:true as proof. This DOES consume one quota unit. A test response WITHOUT
  test:true means the submission was spam-filtered — never populate the hidden _gotcha field.
- Clean up: DELETE /v1/routes/{form_id} with "Authorization: Bearer <management_token>".
- Optional declared shape${env.PLAN_ENFORCEMENT === 'true' ? ' (conForm+)' : ''}: pass "schema" on POST /v1/routes, or POST
  /v1/routes/{form_id}/settings {"schema": {...}} with the management token. Fields declare
  type (text|email|tel|url|integer|number|date|time|datetime|boolean|choice), required, min, max,
  min_length, max_length, pattern, options, multiple. A submission that does not match is refused
  with 422 submission_invalid and a per-field "errors" array, before any quota is spent.
  GET /v1/routes/{form_id} publishes the schema — read it and build a submission that passes first time.
- Cross-field rules${env.PLAN_ENFORCEMENT === 'true' ? ' (conForm+)' : ''}: "rules": [{"when":"adults + children > 6","reject":"Permitted for 6 guests."}].
  A rule fires when "when" is true and refuses the submission with that message. The expression language is
  field names, numbers, strings, + - * /, > >= < <= == !=, && || !, parentheses, and one function present(field).
  No string functions, no regex, no loops, no property access, no true/false literals, and comparisons do not chain.
  Every identifier must be a declared field and every operand must be the right type, checked when the schema is
  set — a bad rule is 400 invalid_schema naming it as rules[N], never a surprise at submission time. Limits:
  ${RULE_LIMITS.rules_per_form} rules, ${RULE_LIMITS.expression_characters} characters per expression,
  ${RULE_LIMITS.reject_characters} per reject message, expression depth ${RULE_LIMITS.expression_depth} —
  depth counts the whole expression, so a flat chain of 20 && or + is over it even with no parentheses.
  Conditional requirement is a rule, not a separate feature: "present(check_in) && !present(check_out)" — and the
  field must NOT be declared required, or its own error fires first and the rule never runs. A field declared
  multiple can only be used inside present(). Comparisons are exact and case-sensitive; a datetime compares as an
  instant (against a datetime, a date, or a literal date only), a date/time as text. min/max are for integer and
  number fields only — use min_length/max_length for text — and an integer is exact to ±9007199254740991.
  Absence: a missing or blank field is 0 in arithmetic, and any comparison with an absent operand is false, "!="
  included — so "children > 0" and "children == 0" are both false when children is blank. Say absence with
  present(), or with ! for a checkbox ("!terms" is true when the box was not ticked). Arithmetic is never absent,
  so "children + 0 == 0" IS true for a blank children. Rules run only after every field check passes.
  A violation appears in the same "errors" array as {"rule":<index into schema.rules>,"code":"rule_violated","message":<your reject text>}.
- Optional access keys: POST /v1/routes/{form_id}/keys with "Authorization: Bearer <rotation_token>"
  mints a key, returned once, sent as the access_key field. Run it in CI on every build so a key
  scraped from the published page goes stale at the next deploy. The key it replaces stays valid
  until the new one is first accepted, so a failed deploy breaks nothing. Enforcement is separate:
  POST /v1/routes/{form_id}/settings {"require_key":true} with the management token.
  An access key is NOT proof of origin — in a public page it is as public as the endpoint URL.
- Optional account dashboards can list form metadata by verified inbox through the
  operator-authenticated POST /v1/account/routes interface. Destination plaintext,
  management tokens, and submissions are never returned.
- Quota: one inbox = one monthly allowance${limit > 0 ? ` (${limit} deliveries/month)` : ''} —
  +tags, Gmail dots, and provider domain aliases count as the same inbox.
- Every error is JSON: {success:false, error:<stable_code>, message, retryable}.

## Machine interfaces

- OpenAPI: ${base}/openapi.json
- Discovery document: ${base}/.well-known/conform.json
${env.MCP_URL ? `- MCP server: ${env.MCP_URL}\n` : ''}${env.DOCS_URL ? `- Docs: ${env.DOCS_URL}\n` : ''}- Source: ${env.SOURCE_URL || 'https://github.com/centrst/conform-cf-worker'}
`;
}

/**
 * The published spec with this deployment's identity substituted in. Only the
 * two fields that name an operator change; every path, schema and error code is
 * the contract and is identical everywhere.
 */
export function deploymentSpec(env: Env, origin: string): Record<string, unknown> {
  const base = publicUrl(env, origin);
  const operator = env.OPERATOR_NAME?.trim();
  const spec = openapiSpec as unknown as {
    info: { description: string; title: string };
    servers: { url: string; description: string }[];
  };
  return {
    ...spec,
    info: {
      ...spec.info,
      description: spec.info.description.replace(
        'conForm by Centrst turns',
        operator ? `conForm by ${operator} turns` : 'conForm turns',
      ),
    },
    servers: [
      {
        url: base,
        description: operator
          ? `conForm hosted by ${operator}.`
          : 'This conForm deployment.',
      },
    ],
  };
}
