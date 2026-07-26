# conform-cf-worker

The open-source Cloudflare Worker that receives a form and delivers its fields
to a verified inbox. Hosted Conform and self-hosted Conform use this same
delivery engine.

Source: <https://github.com/centrst/conform-cf-worker>

## The model

A form has two different names:

- **Alias** — a customer-controlled label such as `Contact` or `Website`.
  Aliases are not unique. One inbox can have any number of forms with the same
  alias.
- **Form ID** — a random 80-bit identifier such as
  `cfm_7K4P9X2M8RWD3JNH`. This is the permanent public identity used in the
  form endpoint.

The normal flow is:

1. The owner enters an inbox and an alias.
2. Conform generates the form ID and encrypts the routing destination.
3. In the default `verified` mode, Cloudflare emails the owner to verify the
   destination inbox.
4. The form posts to `https://forms.example.com/f/cfm_…`.
5. The Worker atomically reserves one unit from that inbox's shared monthly
   allowance.
6. When allowed, the Worker decrypts the destination in memory, turns the
   fields into a plain-text email, optionally attaches `submission.json`, and
   sends it through Cloudflare Email Service.
7. Conform does not create a submission history.

Every form targeting the same normalized inbox shares one allowance, regardless
of its alias. A failed email send rolls its quota reservation back. Once the
allowance is exhausted, the Worker rejects the submission before calling the
email provider.

## The storage boundary

This Worker does not use Workers KV, D1, or an external database. It creates two
SQLite-backed Durable Object namespaces from `wrangler.toml`:

### Form route storage

One tiny record per form:

```text
form ID
alias
opaque inbox ID
encrypted routing destination
verification status
Cloudflare destination ID
creation timestamp
```

The destination is encrypted with AES-GCM before it is written. The opaque inbox
ID is an HMAC of the normalized destination email. It lets forms for the same
inbox share quota without using the email as a database key.

The only customer-authored value stored in plaintext is the alias. The
destination email is not stored in plaintext in the route or quota Durable
Objects.

### Quota storage

One row per active inbox-month:

```text
UTC month
used count
limit
```

The Durable Object itself is addressed by the opaque inbox ID.

### Data processed elsewhere

| Data | Conform Durable Objects | Cloudflare Email Service | Destination mailbox |
| --- | --- | --- | --- |
| Submission fields | Never stored | Processed for Worker execution and delivery | Stored according to the mailbox provider |
| Destination email | Encrypted in the form route | Stored as a verified destination in `verified` mode and processed for delivery | Known to the mailbox provider |
| Alias | Stored with the route | Included when building the email | Included in the email |
| Quota | Opaque ID, month, count and limit | Not included in the delivered email | Not sent |
| Account form index | Opaque inbox ID, form IDs and creation timestamps | Not used | Not sent |

No hosted service can honestly promise that its operator is technically unable
to inspect plaintext processed by infrastructure the operator controls.
Self-hosting this Worker removes Centrst from the path. End-to-end encrypted
capture is a separate mode because encryption must happen in the visitor's
browser before submission.

## Delivery modes

### `verified` — default

Cloudflare stores and verifies each destination inbox. Delivery to verified
destinations is free and does not consume Cloudflare Email Service sending
quota. Cloudflare currently allows 200 destination addresses per account by
default, with a limit-increase request available.

Required configuration:

- Email Routing enabled for the sender domain
- An API token with `Email Routing Addresses Write`
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
- The included registration rate-limit binding, which receives only opaque HMAC
  keys and protects the destination-address allowance from automated exhaustion

Pending routes become active when the landing page checks
`GET /v1/routes/:form_id` after Cloudflare verification. The public form URL
never changes.

### `arbitrary`

Set `DELIVERY_MODE = "arbitrary"` after onboarding the sender domain to
Cloudflare Email Sending. New inboxes receive a Conform confirmation email, and
the route activates only after confirmation.

This uses the same `EMAIL` binding, form IDs, route records and quota system.
Existing verified routes continue working; switching modes does not migrate or
rewrite them. Arbitrary-recipient sends use Cloudflare's outbound-email
allowance and then its per-email pricing.

## Optional account dashboard

Route creation never requires an account. Operators can additionally connect a
trusted account dashboard by setting `ACCOUNT_LOOKUP_SECRET` in both services.
The dashboard must authenticate its user and send only email addresses it has
verified for that account to `POST /v1/account/routes`.

The Worker derives the same opaque inbox IDs used at creation and returns form
metadata only. It never returns or newly persists destination plaintext,
management tokens, webhook secrets, or submission content. Routes created
before this index existed can be added once with
`POST /v1/routes/:form_id/claim` and their existing management token.

`ACCOUNT_LOOKUP_SECRET` is optional and should be a separate random secret:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
npx wrangler secret put ACCOUNT_LOOKUP_SECRET
```

## Deploy it yourself

Prerequisites:

- Node.js 20 or newer with Corepack
- A Cloudflare account
- A domain on Cloudflare DNS

```sh
git clone https://github.com/centrst/conform-cf-worker.git
cd conform-cf-worker
corepack yarn install
```

Generate two independent 32-byte secrets:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Store them:

```sh
npx wrangler secret put ROUTE_TOKEN_SECRET
npx wrangler secret put OWNER_HASH_SECRET
```

For verified mode:

```sh
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

Add your runtime configuration to `wrangler.toml`:

```toml
# Verified destinations are free. Change DELIVERY_MODE to "arbitrary" after
# onboarding a domain to Cloudflare Email Sending.
[vars]
DELIVERY_MODE = "verified"
MONTHLY_LIMIT = "250"
MAX_REQUEST_SIZE = "102400"
FROM_EMAIL = "forms@example.com"
FROM_NAME = "Conform"
PUBLIC_URL = "https://forms.example.com"
SOURCE_URL = "https://github.com/your-org/conform-cf-worker"
SOURCE_COMMIT = "self-hosted"
CLOUDFLARE_ACCOUNT_ID = "your-account-id"
```

Replace the example sender, public URL, source URL, and Cloudflare account ID.
The sender must belong to a domain configured for Cloudflare Email Routing or
Email Sending. Change the example rate-limit `namespace_id` if that integer is
already used in your account.

If you manage runtime variables in the Cloudflare dashboard instead, leave
`[vars]` out of `wrangler.toml`. The committed `keep_vars = true` setting keeps
those dashboard values intact on later deploys.

Deploy:

```sh
corepack yarn verify
npx wrangler deploy
```

Wrangler creates the route and quota Durable Object namespaces automatically.
There is no KV namespace or database to create manually.

Set `MONTHLY_LIMIT = "0"` for unlimited delivery. This skips quota writes; the
route Durable Object remains because it resolves each short form ID.

## Centrst hosted deployment

The hosted service uses `wrangler.centrst.toml`, which contains its Worker name
and Custom Domain but intentionally contains no runtime values. The Custom
Domain makes Cloudflare issue and manage the certificate for the multi-level
`api.conform.centrst.com` hostname. Its Cloudflare Git deploy command is:

```sh
npx wrangler versions upload --config wrangler.centrst.toml
```

Runtime values and secrets are managed in the `centrst-conform-worker`
dashboard. Do not use the generic `wrangler.toml` for this deployment.

### Staging

`wrangler.centrst-staging.toml` deploys `centrst-conform-worker-staging` to its
`workers.dev` hostname. It is the release smoke-test loop and the target for
the agent benchmark. Configure it in the dashboard with
`DELIVERY_MODE = "arbitrary"` and a low `MONTHLY_LIMIT`, and leave `PUBLIC_URL`
unset so endpoint URLs fall back to the request origin. Deploy manually:

```sh
npx wrangler deploy --config wrangler.centrst-staging.toml
```

CI dry-runs all three configs so drift in any of them fails the pull request.

## Create a form

```sh
curl https://forms.example.com/v1/routes \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"email":"owner@example.com","alias":"Contact"}'
```

Response:

```json
{
  "success": true,
  "status": "pending_verification",
  "form_id": "cfm_7K4P9X2M8RWD3JNH",
  "alias": "Contact",
  "endpoint": "https://forms.example.com/f/cfm_7K4P9X2M8RWD3JNH",
  "status_url": "https://forms.example.com/v1/routes/cfm_7K4P9X2M8RWD3JNH",
  "message": "Check your inbox for Cloudflare’s verification email. Your endpoint will begin delivering after you confirm it.",
  "next_action": {
    "type": "human_verification",
    "message": "The destination inbox must confirm a verification email. Poll the status URL until status is \"active\" — the endpoint URL will not change.",
    "poll": {
      "url": "https://forms.example.com/v1/routes/cfm_7K4P9X2M8RWD3JNH",
      "interval_seconds": 15
    }
  }
}
```

The endpoint is stable while verification is pending. Check status:

```sh
curl https://forms.example.com/v1/routes/cfm_7K4P9X2M8RWD3JNH
```

## Machine contract

The full API is described by [`openapi.json`](openapi.json), served by every
deployment at `GET /openapi.json`. `GET /` returns a discovery descriptor with
the API version and this deployment's storage posture. Every non-2xx response
is JSON with the same envelope:

```json
{ "success": false, "error": "inbox_not_verified", "message": "This inbox has not been verified yet.", "retryable": true }
```

`error` is a stable machine code from the `x-conform-error-codes` table in the
spec; `retryable: true` means the identical request may succeed later. Codes
add fields where useful: `rate_limited` carries `retry_after_seconds`,
`monthly_allowance_exhausted` carries `used`/`limit`/`resets_at`, and
`inbox_not_verified` carries a `next_action` poll block. The contract is
enforced by `src/contract.test.ts`, which fails CI when the spec, the error
table, or the runtime drift apart.

Discovery: `GET /` (also `/health` and `/.well-known/conform.json`) returns a
machine-readable descriptor of this deployment — endpoints, verification
model, limits, and storage posture. `GET /llms.txt` serves the same contract
as compact text for language models.

## MCP server

`mcp/` contains a stateless [Model Context Protocol](https://modelcontextprotocol.io)
server (Streamable HTTP) that fronts the public API with five tools:
`create_form` (idempotent by default), `get_form_status`, `get_install_code`,
`send_test_submission`, and `get_service_info`. It is implemented directly on
JSON-RPC, so this repository stays at zero runtime dependencies.

Add it to a coding agent:

```sh
claude mcp add --transport http conform https://api.conform.centrst.com/mcp
```

Cursor / VS Code (`mcp.json`):

```json
{ "mcpServers": { "conform": { "url": "https://api.conform.centrst.com/mcp" } } }
```

Self-hosters deploy it with `npx wrangler deploy --config wrangler.mcp.toml`
and set `CONFORM_BASE_URL` to their engine's URL (or route it on the same
hostname and leave the var unset). The hosted route is defined in
`wrangler.centrst-mcp.toml`; `mcp/server.json` is the MCP registry manifest.

## Install code

Every route serves ready-to-install, accessible form code with its endpoint
baked in:

```sh
curl 'https://forms.example.com/v1/routes/cfm_7K4P9X2M8RWD3JNH/install?framework=react'
```

Frameworks: `html` (zero-JS baseline), `js`, `react`, `vue`, `svelte`,
`astro`, `nextjs`. The response includes the files, installation notes, the
route's current status with `next_action`, and a `test_command` that sends a
`_test`-marked submission as delivery proof. Add `raw=1` for the bare file
content, or use `GET /v1/install?framework=…` for a generic artifact with a
`{{FORM_ENDPOINT}}` placeholder. Artifacts are unstyled semantic HTML with
labeled controls, a polite live region for outcomes, and the honeypot wired
in — they inherit the host site's styling.

Use the endpoint directly:

```html
<form action="https://forms.example.com/f/cfm_7K4P9X2M8RWD3JNH" method="post">
  <input name="email" type="email" required>
  <textarea name="message" required></textarea>
  <button type="submit">Send</button>
</form>
```

Reserved optional fields:

| Field | Purpose |
| --- | --- |
| `_subject` or `subject` | Email subject |
| `_format=json` or `format=json` | Attach the fields as `submission.json` |
| `_gotcha` or `botcheck` | Honeypot; a non-empty value is silently discarded |
| `_redirect` or `redirect` | Absolute `https://` URL to send the visitor to after delivery (`303 See Other`) |
| `_test` | Marks a test submission: delivered for real with a `[Test]` subject, consumes one quota unit, and the response carries `test: true` plus an `echo` of any non-boolean value |

Browser form posts (requests accepting `text/html`) receive a minimal HTML
result page instead of JSON. JSON, URL-encoded, and multipart text fields are
accepted. File uploads are rejected. The default request-body limit is 100 KiB.

## Signed webhooks

A route can deliver to a webhook as well as (or instead of) email:

```sh
curl https://forms.example.com/v1/routes \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"email":"owner@example.com","alias":"Contact","delivery":{"mode":"both","webhook":{"url":"https://hooks.example.com/receiver"}}}'
```

Email verification stays the trust root in every mode: no delivery of any kind
starts until the inbox owner confirms, and the confirmation email discloses
the webhook URL. The creation response includes `webhook.secret` (`whsec_…`,
Standard Webhooks format) exactly once — and again on idempotent replays.
Deliveries are JSON events (`type: "submission.received"`) signed with
`webhook-id` / `webhook-timestamp` / `webhook-signature` headers; deduplicate
on `webhook-id`.

There is deliberately **no durable retry queue** — redelivery would require
storing submission content, which conForm never does. `mode: "webhook"`
delivers synchronously: on failure the quota reservation is rolled back and
the request returns `502 webhook_delivery_failed` (safe to retry).
`mode: "both"` treats email as authoritative and fires the webhook best-effort
in the background — the inbox is the durable record.

## Idempotent creation and route management

Send an `Idempotency-Key` header (1–200 printable ASCII characters, scoped per
destination inbox) with `POST /v1/routes` to make provisioning replay-safe:
the same key and body always resolve to the same form endpoint. A retry
returns `200` with `replayed: true` and the route's *current* status — a
replay after the inbox was verified reports `active`. The same key with a
different body is rejected with `422 idempotency_key_conflict`.

Creation responses include a `management_token` (re-revealed on idempotent
replays; treat it as a secret). It authorizes exactly one operation:

```sh
curl -X DELETE https://forms.example.com/v1/routes/cfm_… \
  --header 'Authorization: Bearer <management_token>'
```

Deletion is a hard delete — the encrypted destination is destroyed and the
form ID answers 404 afterwards. Routes that are never verified are deleted
automatically after 30 days.

## Quota identity

One inbox has one monthly allowance. The quota key is derived from the
address's *billing identity* (`src/email-identity.ts`): `+suffixes` are
stripped on every domain, dots are insignificant on Gmail,
`googlemail.com`/`protonmail.com`/`pm.me` fold into their canonical domains,
and `-suffixes` are stripped on Yahoo domains only. Delivery, verification,
and route ownership always use the exact address — identity rules never
change where mail goes.

If two genuinely distinct mailboxes are ever merged by these rules (for
example a corporate system where `dev+ops@` is a real mailbox), the operator
can exempt the exact address: `yarn hash-email dev+ops@corp.example` prints an
opaque hash to add to the `QUOTA_IDENTITY_EXCEPTIONS` var — no plaintext
address ever appears in configuration. The exemption applies to routes created
after the change.

## Monthly quota implementation

The quota is not a log and does not use `COUNT(*)`.

Each normalized inbox maps to one Durable Object through its opaque HMAC owner
identifier. A successful reservation performs one atomic SQLite upsert:

```sql
INSERT INTO usage (month, used, limit_count)
SELECT ?1, 1, ?2
WHERE ?2 > 0
ON CONFLICT(month) DO UPDATE SET
  used = usage.used + 1,
  limit_count = excluded.limit_count
WHERE usage.used < excluded.limit_count
RETURNING used, limit_count;
```

A returned row allows delivery. No returned row means the allowance is already
full. There is one row per active inbox-month, not one row per submission.

## Existing hosted Conform

This Worker must never bind the existing Conform KV namespaces.

During migration:

1. Keep legacy `/submit` on the existing Worker.
2. Route new `/v1/routes/*` and `/f/*` traffic to this Worker.
3. Verify the new flow without changing either existing client.
4. Migrate each existing client's form action to a generated `cfm_…` endpoint.
5. Leave the legacy KV data untouched until a separate retention decision is
   made.

## Development

```sh
corepack yarn typecheck
corepack yarn test
npx wrangler deploy --dry-run
```

The repository is MIT licensed.
