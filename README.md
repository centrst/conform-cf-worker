# conform-cf-worker

The open-source Cloudflare Worker that receives a form and delivers its fields
directly to a verified inbox. This is the delivery engine used by hosted
Conform and the same Worker that anyone can deploy into their own Cloudflare
account.

Source: <https://github.com/centrst/conform-cf-worker>

## What it does

1. A form owner enters an inbox and a form name.
2. In the default `verified` mode, the Worker registers that inbox as a
   Cloudflare Email Routing destination. Cloudflare emails the owner to verify
   it.
3. Conform returns an encrypted, self-contained form endpoint.
4. Each submission atomically reserves one unit from the inbox's shared monthly
   allowance.
5. When allowed, the Worker turns the fields into a plain-text email, optionally
   attaches the same fields as `submission.json`, and sends it through
   Cloudflare Email Service.
6. Conform does not create a submission history.

All routes delivering to the same normalized inbox share one allowance. A
failed email send rolls its reservation back. Once the allowance is exhausted,
the Worker rejects the submission before calling the email provider.

## The storage boundary

This distinction is deliberate:

| Data | Conform application storage | Cloudflare | Destination mailbox |
| --- | --- | --- | --- |
| Form fields | Never stored | Processed in transit for Worker execution and email delivery | Stored according to the mailbox provider |
| Destination email for new routes | Never stored in Conform KV, D1, or Durable Object rows | Stored as a verified destination in `verified` mode; processed for delivery in either mode | Known to the mailbox provider |
| Form name | Carried inside the encrypted route token; not placed in the quota database | Processed when building the email | Included in the email |
| Quota | UTC month, count, limit, and an opaque inbox identifier | Stored in a SQLite Durable Object | Not sent |

The opaque inbox identifier is an HMAC of the normalized destination email. It
cannot be reversed without the deployment secret, but it lets every form for
the same inbox share one atomic counter.

The route token contains the destination and form name encrypted with AES-GCM.
The customer's website holds that token in its form `action`; there is no route
record to look up. The health endpoint identifies the source repository and
deployed commit so a hosted deployment can be compared with this code.

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

### `arbitrary`

Set `DELIVERY_MODE = "arbitrary"` after onboarding the sender domain to
Cloudflare Email Sending. New inboxes receive a Conform confirmation email, and
the route endpoint is revealed only after confirmation.

This uses the same `EMAIL` binding and route tokens. Existing verified
destinations continue working; switching modes does not migrate or rewrite
routes. Arbitrary-recipient sends use Cloudflare's outbound-email allowance and
then its per-email pricing.

## Deploy it yourself

Prerequisites:

- Node.js 20 or newer with Corepack
- A Cloudflare account
- A domain on Cloudflare DNS

Clone and install:

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

For verified mode, also store:

```sh
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

Set `CLOUDFLARE_ACCOUNT_ID`, `FROM_EMAIL`, `PUBLIC_URL`, and the desired
`MONTHLY_LIMIT` in `wrangler.toml`. The sender must belong to a domain configured
for Cloudflare Email Routing or Email Sending. Change the example rate-limit
`namespace_id` if that integer is already used in your account.

Deploy:

```sh
corepack yarn verify
npx wrangler deploy
```

Set `MONTHLY_LIMIT = "0"` for an unlimited self-hosted deployment. In that
configuration the Worker skips the quota binding entirely.

## Create a form route

```sh
curl https://forms.example.com/v1/routes \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"email":"owner@example.com","form_name":"Contact"}'
```

Verified response:

```json
{
  "success": true,
  "status": "active",
  "endpoint": "https://forms.example.com/f/cf1.r...",
  "form_name": "Contact",
  "message": "Your form endpoint is ready."
}
```

An unverified inbox returns the same endpoint with
`"status": "pending_verification"`. It begins delivering after the owner follows
Cloudflare's verification email.

Use the endpoint directly:

```html
<form action="https://forms.example.com/f/cf1.r..." method="post">
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

JSON, URL-encoded, and multipart text fields are accepted. File uploads are
rejected. The default request-body limit is 100 KiB.

## Monthly quota implementation

The quota is not a log and does not use `COUNT(*)`.

Each normalized inbox maps to one Durable Object using its opaque HMAC owner
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

## Existing hosted Conform routes

Hosted Conform can bind its existing access-key KV namespace as
`LEGACY_ACCESS_KEYS`. `POST /submit` then resolves old access keys and sends them
through this same quota and delivery path.

Those pre-existing records contain their destination email because that is how
the current service routes them. The no-route-database design applies to new
encrypted route tokens. The adapter preserves, but does not expand, that legacy
storage.

The compatibility adapter is read-only:

- it does not delete existing records;
- it does not rewrite existing records;
- it does not touch encrypted-response storage;
- it does not change existing access keys.

Migration should first deploy this Worker with the production KV binding, verify
both existing clients, and only then move `api.conform.centrst.com`.

## Development

```sh
corepack yarn typecheck
corepack yarn test
npx wrangler deploy --dry-run
```

The repository is MIT licensed.
