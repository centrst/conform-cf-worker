# conform-cf-worker

The open-source Cloudflare Worker that receives a form and delivers its fields
to a verified inbox. Hosted Conform and self-hosted Conform use this same
delivery engine.

Source: <https://github.com/centrst/conform-cf-worker>

## Licence

Two licences, split along the line where code leaves this repository and lands
in somebody else's website.

**The engine is [FSL-1.1-ALv2](https://fsl.software/)** — read it, run it, modify
it, self-host it, and use it in professional services for your clients. The one
thing it does not permit is offering it to the general public as a product that
substitutes for conForm. Two years after each release, that version becomes
Apache 2.0 automatically.

If you build sites for clients and want to run conForm for them and charge for
it: that is a Permitted Purpose and it is meant to be. The restriction exists to
stop a rebranded conForm being sold to the public at a dollar less, not to stop
practitioners working.

**Install artifacts are MIT** — `src/templates.ts` and everything
`GET /v1/install` generates, covered by `LICENSE-SNIPPETS`. Those artifacts end
up inside other people's sites, and nobody should inherit an obligation from a
form they copied out of a documentation page. The install response says
`"license": "MIT"` so an agent never has to infer it.

## The model

A form has two different names:

- **Alias** — a customer-controlled label such as `Contact` or `Website`.
  Aliases are not unique. One inbox can have any number of forms with the same
  alias.
- **Form ID** — a random 80-bit identifier such as
  `cfm_B5DDZ2ANQA4HRWZN`. This is the permanent public identity used in the
  form endpoint. Examples here deliberately use a realistic ID rather than a
  fill-in-the-blank one, because the shape is part of what they document — and
  they pair it with the `forms.example.com` placeholder host, so nothing here is
  copy-pasteable into a live form. Customer-facing docs make the opposite trade
  and use `cfm_your_form_id`, which the Worker recognises and answers with
  guidance instead of a bare 404.

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
low-warning sent
full-warning sent
failed count
blocked count
throttled count
```

The two warning flags record that the owner has already been told their
allowance is running low or is spent, so a rolled-back reservation reaching the
same count again does not resend the same email. They are booleans about
messages already sent, and reveal nothing about any submission.

The failed and blocked counts are tallies for the same month: deliveries that
were attempted and did not arrive, and submissions refused because the allowance
was already spent. `used` is the delivered count by construction, since a failed
delivery is rolled back and never remains counted. These are integers per
inbox-month with no timestamps and no per-submission rows, so they cannot say
who submitted what, or when — only how many. Spam caught by the honeypot is
deliberately not tallied: counting it would mean a storage write per abusive
request, which is the amplification the honeypot exists to avoid.

The throttled count is sampled for the same reason. Submissions refused by the
rate limiter are recorded at most once per form per minute, so the number means
"minutes in which throttling happened", not "requests refused" — an attack is
unbounded, and recording one must never scale with it.

The Durable Object itself is addressed by the opaque inbox ID.

### Data processed elsewhere

| Data | Conform Durable Objects | Cloudflare Email Service | Destination mailbox |
| --- | --- | --- | --- |
| Submission fields | Never stored | Processed for Worker execution and delivery | Stored according to the mailbox provider |
| Destination email | Encrypted in the form route | Stored as a verified destination in `verified` mode and processed for delivery | Known to the mailbox provider |
| Alias | Stored with the route | Included when building the email | Included in the email |
| Quota | Opaque ID, month, counts (delivered, failed, blocked, throttled), limit, and whether each allowance warning was sent | Not included in the delivered email | Not sent |
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

Runtime values and secrets are managed in the `conform-worker`
dashboard. Do not use the generic `wrangler.toml` for this deployment.

### How `main` reaches production

**CI never deploys.** `.github/workflows/ci.yml` runs typecheck, tests, and four
`wrangler deploy --dry-run` invocations — nothing else. A green check on a merge
commit means the change compiles and its configs are coherent. It does not mean
the change is live.

Production is deployed by the Cloudflare Git integration on the Centrst account,
using the `versions upload` command above. That integration is configured in the
Cloudflare dashboard, not in this repository, so the build command, the injected
`SOURCE_COMMIT`, and any promotion step are not visible here or in version
control. Treat "merged" and "live" as separate facts and verify the second.

### Verify what production is actually running

The discovery document reports the deployed commit, so one probe settles it:

```sh
curl -s https://api.conform.centrst.com/ | jq -r .version   # deployed SHA
git ls-remote origin main | cut -f1                         # merged SHA
```

`ls-remote` rather than `rev-parse origin/main`: the latter reads a local
remote-tracking ref that is only as fresh as your last fetch, so it can report a
match against a `main` that has since moved, or a mismatch against one that has
not.

Equal means production is running merged `main`. They can legitimately differ for
a few minutes after a merge while the build runs, and indefinitely if the build
failed — check the Workers Builds log in the dashboard before assuming a deploy
landed.

Pull requests build too, and the Cloudflare bot comments "Deployment successful"
on them. That is a `versions upload`: it creates a version without routing any
traffic to it. A green Cloudflare check on a PR does not mean the PR is live —
confirm with the probe above, which keeps reporting the merged commit.

To confirm a specific behavioural change rather than a SHA, fetch the artifact or
endpoint it touches. For example, install-template changes are visible in
`GET /v1/install?framework=html`.

### Account pinning — read before running any deploy command

`wrangler.centrst.toml` and `wrangler.preview.toml` pin `account_id` to the
Centrst account. **`wrangler.toml` and `wrangler.mcp.toml` do not.** They deploy
to whatever account the current `wrangler` token defaults to, which on a machine
logged into another Cloudflare account is that other account.

`npx wrangler deploy` — the bare command in "Deploy it yourself" above — is a
self-hosting instruction. Running it from a Centrst working copy publishes a
conForm Worker into whichever account happens to be authenticated. Check
`npx wrangler whoami` first, and always pass `--config` explicitly when
deploying anything Centrst-owned.

### Rollback

Every deploy creates a new Worker version and previous versions remain
available, so recovery does not require a revert commit and a rebuild:

```sh
npx wrangler versions list --config wrangler.centrst.toml   # 10 most recent
npx wrangler versions deploy <version-id> --config wrangler.centrst.toml
```

Both are also available from the Worker's Deployments tab in the dashboard,
which is the faster path during an incident and the one that works when the
local token is authenticated to a different account.

A version captures bindings and compatibility settings alongside the code, and
runtime variables and secrets are bindings — so rolling back restores that
version's **configuration too, not just its code**. That cuts both ways during
an incident: if the immediate fix was editing a variable in the dashboard,
deploying an older version silently reverts that fix as well.

Durable Object state is the exception. It is not tracked by versions, so a
rollback does not undo the `InboxQuota` and `FormRoute` data written since.

### Monitoring

`[observability] enabled = true` is set on `wrangler.centrst.toml` and
`wrangler.preview.toml`, so Workers Logs are retained and queryable from the
dashboard. `wrangler tail --config wrangler.centrst.toml` streams them live.

What is worth looking for:

- `Unhandled request failure:` — the only `console.error` in the Worker
  (`src/index.ts`). A `500 internal_error` is deliberately opaque to the caller,
  so this log line is the *only* record of why. If 500s are reported and this
  line is absent, the failure happened before the handler.
- `config_incomplete` responses — a missing binding or runtime variable, not a
  caller error. Most likely after an account or dashboard change.
- `429 monthly_allowance_exhausted` — an inbox hit its allowance. Nothing warns
  the owner today (#26), and nothing rate-limits the submissions that consume it
  (#17), so a spike here can be abuse rather than growth.

Submitted field contents are never logged, by design. Do not add logging that
would change that — the no-retention claim in the discovery document and on the
trust page depends on it.

No alerting is configured. Nothing pages anyone when delivery starts failing;
the failure surfaces only when a form owner notices, or when someone reads the
logs. That gap is real and currently unowned.

### Preview

`wrangler.preview.toml` deploys `conform-preview` to its `workers.dev` hostname
in the dedicated Centrst Cloudflare account. It is the release smoke-test loop
and the target for the agent benchmark. It uses `DELIVERY_MODE = "arbitrary"`;
leave `PUBLIC_URL` unset so endpoint URLs fall back to the request origin.
Deploy manually:

```sh
npx wrangler deploy --config wrangler.preview.toml
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
  "form_id": "cfm_B5DDZ2ANQA4HRWZN",
  "alias": "Contact",
  "endpoint": "https://forms.example.com/f/cfm_B5DDZ2ANQA4HRWZN",
  "status_url": "https://forms.example.com/v1/routes/cfm_B5DDZ2ANQA4HRWZN",
  "message": "Check your inbox for Cloudflare’s verification email. Your endpoint will begin delivering after you confirm it.",
  "next_action": {
    "type": "human_verification",
    "message": "The destination inbox must confirm a verification email. Poll the status URL until status is \"active\" — the endpoint URL will not change.",
    "poll": {
      "url": "https://forms.example.com/v1/routes/cfm_B5DDZ2ANQA4HRWZN",
      "interval_seconds": 15
    }
  }
}
```

The endpoint is stable while verification is pending. Check status:

```sh
curl https://forms.example.com/v1/routes/cfm_B5DDZ2ANQA4HRWZN
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

The hosted deployment serves this from the delivery engine itself, at `/mcp` —
one Worker, no separate script and no route to arrange. Set `MCP_URL` so the
descriptor and `llms.txt` advertise it.

Self-hosters can do the same, or deploy the MCP server standalone with
`npx wrangler deploy --config wrangler.mcp.toml`, setting `CONFORM_BASE_URL` to
their engine's URL. `mcp/server.json` is the MCP registry manifest.

## Install code

Every route serves ready-to-install, accessible form code with its endpoint
baked in:

```sh
curl 'https://forms.example.com/v1/routes/cfm_B5DDZ2ANQA4HRWZN/install?framework=react'
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
<form action="https://forms.example.com/f/cfm_B5DDZ2ANQA4HRWZN" method="post">
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

The same object decides whether an allowance warning is due, claiming each mark
against a flag on that row. Doing it here rather than from the returned count is
what makes it once-only: reservations roll back on delivery failure, so a count
can reach the same mark twice, and concurrent submissions can reach it together.
One "running low" and one "allowance full" per inbox-month, and no more.

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
