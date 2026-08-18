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
access-key enforcement flag
```

Plus at most two access-key rows, when the route has minted any:

```text
public key label
supersession sequence
HMAC of the key
creation timestamp
first-use timestamp
```

A declared schema, when the form has one, is sealed inside that encrypted
payload rather than written beside it — field names are the customer's, and the
boundary below says only the alias is kept in plaintext.

The destination is encrypted with AES-GCM before it is written. The opaque inbox
ID is an HMAC of the normalized destination email. It lets forms for the same
inbox share quota without using the email as a database key.

Access keys are stored as HMACs, never as values, so a reader of route storage
cannot recover a key. A key value exists exactly once, in the response to the
request that minted it.

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

Plus one row per active day, holding a UTC date and a count. Days are pruned
after 35 days. Same shape as the month rows and the same limits on what they can
say: how many, never who or what.

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

# Optional, and worth setting. Each one is a thing this deployment can only
# tell people about if you tell it.
OPERATOR_NAME = "Your Org"                     # else llms.txt omits the attribution rather than inheriting ours
MCP_URL = "https://forms.example.com/mcp"      # else the bundled MCP server works but is undiscoverable
DOCS_URL = "https://example.com/forms/docs/"   # else discovery omits docs_url and llms.txt drops its docs line
DAILY_LIMIT = "50"                             # else 20% of MONTHLY_LIMIT, minimum 25
MAX_FIELDS = "100"
MAX_FIELD_LENGTH = "20000"
```

Replace the example sender, public URL, source URL, and Cloudflare account ID.
The sender must belong to a domain configured for Cloudflare Email Routing or
Email Sending. Change any rate-limit `namespace_id` in `wrangler.toml` that is
already used in your account — they are account-scoped, not global.

Three more are optional and off unless set:

- `ACCOUNT_LOOKUP_SECRET` — the operator interface for listing routes by
  verified inbox and granting plans.
- `PLAN_ENFORCEMENT = "true"` — require a granted plan before a route may
  declare a schema. Only set this if you are charging for it. It is a separate
  flag from `ACCOUNT_LOOKUP_SECRET` on purpose: a dashboard is not a till.
- `QUOTA_IDENTITY_EXCEPTIONS` — see [Quota identity](#quota-identity).

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
model, the shape a form may declare, limits, and storage posture.
`GET /llms.txt` serves the same contract as compact text for language models.

## MCP server

`mcp/` contains a stateless [Model Context Protocol](https://modelcontextprotocol.io)
server (Streamable HTTP) that fronts the public API with six tools:
`create_form` (idempotent by default), `get_form_status`, `get_install_code`,
`check_submission` (a dry run — spends nothing), `send_test_submission` (real
delivery, one quota unit), and `get_service_info`. It is implemented directly on
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

Creation also returns a `rotation_token`. It mints access keys and can do
nothing else, which is why it exists separately: it is the credential that goes
into a CI secret, and a management token in CI means a leaked CI secret deletes
the form.

## Access keys

A form endpoint is a public URL sitting in your page's source. That is the
design — an agent that provisions a form posts to it from wherever it runs, and
there is no browser in that story. It also means a scraper that reads your page
gets the endpoint, and can post to it forever.

An access key does **not** fix that, and the docs will not pretend otherwise. A
key inlined into a public page is exactly as public as the endpoint URL beside
it. What a key buys is that **rotating it is free**:

```sh
curl -X POST https://forms.example.com/v1/routes/cfm_…/keys \
  --header 'Authorization: Bearer <rotation_token>'
```

Without a key, shaking off a bot that holds your URL means destroying the route
and rebuilding it — new endpoint, every form updated, pipeline touched. With
one, you mint and redeploy: same endpoint, same route, same inbox.

Run it in CI on every build and the key a scraper harvested goes stale at your
next deploy, with nobody noticing anything:

```sh
# -f and jq -e matter: without them a 429, a wrong token or a 404 all yield the
# literal string "null", and the build cheerfully ships a form posting it.
KEY=$(curl -fsX POST "https://forms.example.com/v1/routes/$FORM_ID/keys" \
  --header "Authorization: Bearer $CONFORM_ROTATION_TOKEN" | jq -er .key) || exit 1
echo "PUBLIC_CONFORM_ACCESS_KEY=$KEY" >> .env
yarn build && yarn deploy
```

The value is returned once, at mint. The Worker stores only an HMAC of it, so
`GET /v1/routes/{form_id}/keys` lists keys by label and state and never returns
a value. Generated install artifacts carry a `{{CONFORM_ACCESS_KEY}}`
placeholder for your build to substitute, never a literal key.

### Two keys live, and what retires the old one

Deploys are not atomic, CDNs cache, and visitors hold pages open, so a route
keeps the current key and the one it superseded.

**The previous key retires when its successor is first accepted on a
submission — never on a timer.** A timer has a failure mode worth avoiding: CI
mints a key, the build then fails, the live site is still serving the previous
key, and it dies two days later with nothing to connect it to. Waiting for the
successor to actually deliver once makes a failed deploy cost nothing.

Supersession is ordered by a sequence the route object assigns, not by a
timestamp — two builds can mint inside the same millisecond, and then a clock
cannot say which key replaced which.

### Enforcement is a separate switch

Minting a key changes nothing on its own. Until `require_key` is on, a missing
or wrong key still delivers, so you can mint, ship, and confirm before you
start refusing anything:

```sh
curl -X POST https://forms.example.com/v1/routes/cfm_…/settings \
  --header 'Authorization: Bearer <management_token>' \
  --header 'Content-Type: application/json' \
  --data '{"require_key": true}'
```

A route with no keys at all ignores the `access_key` field entirely, so nothing
about an existing form changes until you opt in.

### What this does not do

Someone maintaining a scraper against your specific site re-harvests after each
deploy and always holds a current key. Automation on their side beats
automation on yours. What rotation stops is the commodity case — harvest once,
replay for months.

If you post from your own backend rather than the browser, the key never enters
a page and is a real secret. That is the only configuration in which it is one.

## Submission ceilings

Three separate limits, because they bound different things:

| Limit | Default | Bounds |
| --- | --- | --- |
| `SUBMISSION_RATE_LIMITER` | 5/min per form | a burst against one endpoint |
| `SUBMISSION_CLIENT_RATE_LIMITER` | 2/min per client | a single source across every form it found |
| `DAILY_LIMIT` | 20% of the monthly limit, minimum 25 | how fast a month can be spent |

The per-form ceiling is deliberately not tighter. A shared cap that is too low
turns two real visitors in the same minute into one lost enquiry, and the owner
never hears about it.

The day ceiling is the better protection for the monthly allowance than a
tighter per-minute limit: it bounds the damage without dropping a legitimately
busy afternoon, and it is the only one of the three that survives a distributed
source, where a per-client cap does nothing.

`MAX_FIELDS` (default 100) and `MAX_FIELD_LENGTH` (default 20000) bound a body
that is inside the byte cap but absurd in shape. Refused submissions never
reserve quota — validation runs before the reservation.

The two submission limiters are **bindings**, not vars, and they fail differently
when absent. Upgrading a customised `wrangler.toml` means adding namespace ids
`17004` and `17005` as well:

| Binding | Absent means |
| --- | --- |
| `SUBMISSION_CLIENT_RATE_LIMITER` (17004) | the per-client cap silently falls back to the per-form one |
| `ROTATION_RATE_LIMITER` (17005) | **no limit at all** on key minting |

The client key is scoped per form. A key of client alone is shared fate across
tenants: one office NAT would be capped across every customer's forms at once,
and the third real visitor that minute gets an error nobody hears about.

## Proving a form works without sending anything

`_dry_run` runs every check and stops before spending anything:

```sh
curl -sX POST https://forms.example.com/f/cfm_… \
  -d 'name=Test&email=test@example.com&message=Hello&_dry_run=true'
```

```json
{
  "success": true,
  "dry_run": true,
  "delivered": false,
  "would_deliver": true,
  "delivery": { "email": "would send" },
  "quota": { "used": 12, "limit": 250, "resets_at": "2026-09-01T00:00:00.000Z" },
  "message": "Dry run — nothing was delivered and no allowance was spent. …"
}
```

No email, no webhook, no quota. It checks the route is active, the access key
matches, and the submission matches the declared schema — and for each of those
it **returns the exact error a real submission would**, so it is the way to
verify an install without polluting an inbox.

The allowance is the one exception: a dry run *reports* it rather than refusing
on it. A spent allowance answers `200` with `would_deliver: false`, where a real
submission answers `429`.

`quota` and `delivery` appear only for a caller whose `access_key` was accepted.
`/f/{id}` is unauthenticated and the form ID sits in your page source, so
publishing month-to-date volume there would make an inbox's enquiry rate
pollable by anyone who scraped a form.

`_test` still exists and is a different thing: it delivers a real email with a
`[Test]` subject and consumes one quota unit, which is what you want when the
question is "does mail actually arrive". `_dry_run` answers "would this be
accepted". If both are set, the dry run wins.

Three deliberate properties:

- **Strict about its value.** `_dry_run=false` submits for real. `_test` treats
  any non-empty value as true, which is safe because `_test` still delivers —
  a dry run does not, so a field left in a live form must fail loudly.
- **Never redirects, never renders a thank-you page.** The HTML result reads
  *Dry run — nothing was sent*. A `_dry_run` shipped into production announces
  itself instead of silently swallowing a month of enquiries.
- **A honeypot hit answers identically** — the same fields, not merely the same
  status. Reporting it would let anyone use the dry run to find the trap, and
  not being able to tell is the honeypot's only property.

The honest cost: a dry run makes probing a form cheaper and quieter than
submitting for real. The submission rate limiter still applies, which bounds it
to the same rate as a real submission — that is the control that matters.

## Declared shape — conForm+

Free, conForm is a relay: it forwards whatever arrives, because without a
declaration it cannot know a form's field names, which are required, or what a
plausible value looks like. Hand it a schema and it becomes a validator.

```json
{
  "email": "you@example.com",
  "alias": "Oak & Orchard reservations",
  "schema": {
    "strict": true,
    "fields": {
      "check_in":  { "type": "date",    "required": true },
      "check_out": { "type": "date",    "required": true },
      "adults":    { "type": "integer", "required": true, "min": 1, "max": 6 },
      "children":  { "type": "integer", "min": 0, "max": 5 },
      "name":      { "type": "text",    "required": true, "max_length": 120 },
      "email":     { "type": "email",   "required": true },
      "phone":     { "type": "tel" },
      "note":      { "type": "text",    "max_length": 2000 }
    },
    "rules": [
      { "when": "adults + children > 6",
        "reject": "This property is permitted for 6 guests." },
      { "when": "check_out <= check_in",
        "reject": "Check-out must be after check-in." }
    ]
  }
}
```

Types: `text email tel url integer number date time datetime boolean choice`.
Per-field constraints: `required`, `multiple`, `min`, `max`, `min_length`,
`max_length`, `pattern`, `options`.

`min` and `max` bound a number, so they belong to `integer` and `number` and are
refused anywhere else — they were being silently ignored there, which meant a
form declaring `{"type": "text", "max": 500}` and meaning length was enforcing
nothing at all. Use `min_length` and `max_length` for text. An `integer` is
exact to ±9007199254740991; a longer run of digits is refused, because past that
the text and the number it becomes are different values and neither a range
check nor a rule could be trusted with it. Long identifiers are `text` with a
`pattern`.

Pass `schema` at creation, or attach one later with the management token:

```sh
curl -X POST https://forms.example.com/v1/routes/cfm_…/settings \
  --header 'Authorization: Bearer <management_token>' \
  --header 'Content-Type: application/json' \
  --data '{"schema": {"fields": {"name": {"type": "text", "required": true}}}}'
```

`{"schema": null}` clears it. Entitlement is checked when a schema is set, not
on every submission — so validation costs nothing on the delivery path, and a
schema already attached keeps being enforced if a plan later lapses. Silently
turning a form's own rules off would be a worse failure than anything they
prevent.

### Self-hosting

**The plan check is off unless you turn it on.** Running this engine yourself is
a Permitted Purpose, and everything in it works when you do: a deployment that
gated by default would refuse this feature to every self-hoster with no way to
grant themselves the plan that unlocks it. The check is a billing control for
whoever charges for this, not a lock on the code.

If you do charge, set `PLAN_ENFORCEMENT = "true"` and grant plans through
`POST /v1/account/plans` (which needs `ACCOUNT_LOOKUP_SECRET`). The two are
deliberately separate flags — wanting route listings is not the same as selling
something, and inferring one from the other would gate people out of their own
install. The default fails open, which costs an operator who forgets some
revenue on their own service: a mistake they can see, unlike a self-hoster
hitting a wall they cannot.

### What a rejection looks like

`422 submission_invalid`, with one entry per field that failed, **before any quota is spent**:

```json
{
  "success": false,
  "error": "submission_invalid",
  "message": "This submission does not match the form.",
  "retryable": false,
  "errors": [
    { "field": "check_in",  "code": "required",      "message": "\"check_in\" is required" },
    { "field": "check_out", "code": "required",      "message": "\"check_out\" is required" },
    { "field": "submit",    "code": "unknown_field", "message": "\"submit\" is not a field on this form" }
  ]
}
```

Detail goes to every caller, not just authenticated ones. A form's shape is
derivable from the page it is installed on, so withholding it protects nothing
and leaves real integrators debugging blind.

`GET /v1/routes/{form_id}` publishes the schema for the same reason: an agent
that can read the shape builds a submission that passes first time instead of
guessing.

### Two details that matter

**Empty counts as absent.** A browser omits a disabled input entirely, so a
required field arriving as an empty string is a sender that assembled the body
from your page source rather than from your form. Treating `""` as present
would let exactly that through.

**`strict` catches the field that is not yours.** Generic spam scripts post
every input they can scrape plus one of their own. conForm's `_`-prefixed
fields are always exempt.

## Cross-field rules — conForm+

A field schema refuses the spam — empty required dates, a field the form does
not have — and still accepts a real guest booking eleven people into a property
permitted for six. Six adults is within `adults`' maximum and five children is
within `children`'s; only the *sum* is wrong, and no per-field constraint can
see a sum. That is what `rules` are for, and it is the refusal that carries
legal weight rather than merely tidying an inbox.

```json
"rules": [
  { "when": "adults + children > 6", "reject": "This property is permitted for 6 guests." },
  { "when": "check_out <= check_in", "reject": "Check-out must be after check-in." }
]
```

A rule fires when `when` is true, and the submission is refused with `reject` as
the message.

**Conditional requirement is a rule, not a second construct** — but the field it
requires must not also be declared `required`, or the field's own error fires
first and the rule never runs:

```json
"fields": { "company": { "type": "text" }, "vat_number": { "type": "text" } },
"rules": [
  { "when": "present(company) && !present(vat_number)",
    "reject": "A company booking needs a VAT number." }
]
```

Writing `present()` against a field that is already `required` is refused when
you set the schema, because it can only ever be true.

### The expression language

Field names, number and string literals, `+ - * /`, `> >= < <= == !=`,
`&& || !`, parentheses, and exactly one function: `present(field)`. No string
manipulation, no regular expressions, no loops, no property access, no
user-defined functions, and no `true`/`false` literals — write `subscribe` or
`!subscribe`. Comparisons do not chain: `a > b && b > c`, never `a > b > c`.
A string literal runs to its next matching quote and has no escapes, so a
literal containing one kind of quote is written with the other. A field declared
`multiple` may only appear inside `present()`: it has no single value to compare.

There is a tokenizer, a recursive-descent parser and a plain interpreter over
the resulting tree (`src/rules.ts`). There is no `eval` and no `new Function`
anywhere: this is a public endpoint, and compiling caller-supplied text into
code would be a remote execution hole no amount of prior validation makes safe.

**Everything that can be wrong is wrong when you set the schema**, with
`400 invalid_schema` naming the rule as `rules[0]` — the same index a violation
carries — and the problem. Syntax, the limits, an identifier that is not a
declared field, and the type of every operand are all checked then, so
`note + 1 > 2` and a bare `note` as a condition are declaration errors rather
than a rule that silently never matches in production. So is a rule that could
never fire: one that reads no field at all, one comparing against `""` (blank
counts as absent), and `present()` on a field already `required`.

Limits: 20 rules per form, 500 characters per expression, 200 per message, and
20 levels of depth. Depth is measured over the whole expression, so a flat chain
of twenty `&&`s is over the limit with no parentheses in sight — in practice
depth binds long before the character ceiling does.

### What a value means

| | |
|---|---|
| `integer`, `number` | a number — converted once, from the declared type, never guessed |
| `datetime` | an instant, parsed |
| `date`, `time`, `choice`, text | text, compared exactly and case-sensitively (a `time` is padded to `hh:mm:ss` on both sides, since a browser sends either form) |
| `boolean` | true/false — and an unticked box was never sent, so it is absent |

Dates and times are text because the ISO forms an HTML date input produces sort
correctly as text — which is what makes `check_out <= check_in` work. A
`datetime` does not: `2026-06-10T10:00`, `2026-06-10T05:00:00-05:00` and
`Jun 10 2026` can all name the same moment, and the *submitter* picks the
spelling. Comparing those as text would hand the sender the choice of whether a
rule fires, so a comparison involving a `datetime` compares instants — against
another `datetime`, a `date`, or a literal date, and nothing else, since
anything that cannot be read as a moment would make the rule permanently
silent. The same check covers `date` and `time`: comparing one against text no
date or clock could equal is refused when you set the schema, not answered
"no" forever afterwards.

String comparison is exact: `email == "spammer@example.com"` is not matched by
`Spammer@Example.com`. A rule is a shape check, not a blocklist.

Because rules run *after* every field check has passed, a value that reaches a
rule is already known good for its declared type. The only thing left to decide
is what a field nobody sent means, and there are two answers:

- **In arithmetic, an absent field is 0.** A sum is over what was sent, and a
  guest who leaves `children` blank brought no children — so
  `adults + children > 6` is the occupancy whether the optional field arrived
  or not.
- **A comparison with an absent operand is false.** All six operators, `!=`
  included. A comparison against something that was never sent has no answer,
  and a rule must never fire on the strength of a value it does not have —
  otherwise `check_out <= check_in` would reject every submission that had not
  filled in a checkout date yet.

So `children > 0` is false when `children` is blank, and so is `children == 0`.
Absence is stated out loud with `present()`, which is why it is the one function
in the language — or with `!` for a checkbox, since `!terms` is a question about
absence asked on purpose. Blank counts as absent throughout, for the same reason
`required` treats it that way.

The one seam, stated rather than hidden: **arithmetic is never absent**, so
`children + 0 == 0` *is* true when `children` is blank. That is the price of
`adults + children > 6` working when the optional field is left empty, and it is
the right trade. A division that does not produce a finite number is absent, so
`total / nights > 100` cannot fire by way of infinity when `nights` is 0.

### What a rule violation looks like

The same `422 submission_invalid` envelope and the same `errors` array as a
field error. A rule has no single field to blame — that is the whole reason it
exists — so it names the rule instead, by its index in the `rules` array that
`GET /v1/routes/{form_id}` publishes:

```json
{
  "success": false,
  "error": "submission_invalid",
  "message": "This submission does not match the form.",
  "retryable": false,
  "errors": [
    { "rule": 0, "code": "rule_violated", "message": "This property is permitted for 6 guests." }
  ]
}
```

Every rule that fired is reported, the way every bad field is. Rules run only
once field validation passes: a rule reading a field that failed its own type
check would be asking a question of a value the form already refused, and the
answer would be noise on top of an error that has to be fixed first anyway.

A form posted from plain HTML gets the same detail as a result page rather than
JSON, so the message you wrote reaches the visitor who tripped it. `message` is
your own text handed back to an anonymous submitter — escape it if you render it
into a page of your own.

### What it does not do

The language stays this size. String manipulation, regular expressions outside
`pattern`, aggregates over repeated fields, date arithmetic, and anything with a
loop in it are all absent on purpose: each one is a request to run somebody
else's program on a public endpoint, and the answer to that is a declaration,
not an interpreter with more instructions.

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

The engine is licensed [FSL-1.1-ALv2](https://fsl.software/) and converts to
Apache 2.0 two years after each release. The install artifacts — `src/templates.ts`
and everything `GET /v1/install` generates — are MIT under `LICENSE-SNIPPETS`, so
nothing you paste into your own site carries an obligation. See the top of this
file for what the split means in practice.
