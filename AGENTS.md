# conform-cf-worker

Open-source Cloudflare Worker for Conform form-to-email delivery.

## Commands

```sh
corepack yarn install
corepack yarn typecheck
corepack yarn test
npx wrangler deploy --dry-run
```

## Invariants

- Never persist form submission fields.
- Never log form fields, destination emails, route tokens, or access keys.
- Reserve monthly quota before sending email.
- Roll back the reservation when the email provider rejects the send.
- All routes for the same normalized destination share one opaque owner ID.
- Generated install artifacts (src/templates.ts) are tested contract surface —
  change templates and their tests together.
- The discovery document, llms.txt, openapi.json, and the router share their
  path definitions; contract and discovery tests fail when they drift.
- Never bind the existing Conform KV namespaces to this Worker.
- Keep hosted and self-hosted delivery in this repository; hosted Conform must
  not maintain a private fork of the redirect logic.
- Ship changes through feature branches and pull requests, never directly to
  `main`.
