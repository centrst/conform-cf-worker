import { publicUrl } from './email';
import { ERROR_TABLE } from './errors';
import type { Env } from './types';

/**
 * Every HTML surface this Worker serves.
 *
 * Split out of index.ts because none of it knows anything about routes, quotas
 * or delivery -- it renders a page and returns it. Keeping it beside the
 * request handlers made index.ts the largest file in the repository by a wide
 * margin and buried the routing in markup.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const HTML_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

export function verificationPage(token: string): Response {
  const safeToken = escapeHtml(token);
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm conForm route</title>
<body>
  <main>
    <h1>Confirm this conForm route</h1>
    <p>Confirm that this inbox should receive the form submissions.</p>
    <form method="post" action="/v1/routes/verify">
      <input type="hidden" name="token" value="${safeToken}">
      <button type="submit">Confirm inbox</button>
    </form>
  </main>
</body>
</html>`,
    { headers: HTML_PAGE_HEADERS },
  );
}

export function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('text/html') && !accept.includes('application/json');
}

/**
 * Someone posted to a documentation sample. They are mid-evaluation with a form
 * already wired up, so answer in the browser they are standing in rather than
 * leaving them with a bare 404. Nothing they submitted is read, logged or kept.
 */
export function placeholderGuidancePage(createUrl: string): Response {
  const href = escapeHtml(createUrl);
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>conForm — example endpoint</title>
<body>
  <main>
    <h1>That was the example endpoint</h1>
    <p>
      The form ID in that snippet is a sample from the documentation, so it is
      not connected to any inbox and your submission was not delivered or
      stored.
    </p>
    <p>Your form markup is already correct. It needs your own endpoint:</p>
    <ol>
      <li><a href="${href}">Create a form endpoint</a> with the inbox that should receive submissions.</li>
      <li>Confirm the verification email so delivery can begin.</li>
      <li>Swap the sample ID in your <code>action</code> for the one you were given.</li>
    </ol>
    <p>No account is required and nothing is retained after delivery.</p>
  </main>
</body>
</html>`,
    { status: ERROR_TABLE.placeholder_endpoint.status, headers: HTML_PAGE_HEADERS },
  );
}

export function createFormUrl(env: Env, origin: string): string {
  if (!env.DOCS_URL) return `${publicUrl(env, origin)}/`;
  const docs = env.DOCS_URL.endsWith('/') ? env.DOCS_URL : `${env.DOCS_URL}/`;
  return new URL('../#create-form', docs).toString();
}

export type SubmissionOutcome = 'sent' | 'not-sent' | 'dry-run';

const RESULT_HEADINGS: Record<SubmissionOutcome, string> = {
  sent: 'Submission sent',
  'not-sent': 'Submission not sent',
  // Never "sent". A dry run that renders a thank-you page is how a `_dry_run`
  // field shipped into a live form goes unnoticed for a month.
  'dry-run': 'Dry run — nothing was sent',
};

export function submissionResultPage(
  outcome: SubmissionOutcome,
  message: string,
  status = 200,
): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>conForm</title>
<body>
  <main>
    <h1>${RESULT_HEADINGS[outcome]}</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="javascript:history.back()">Go back</a></p>
  </main>
</body>
</html>`,
    { status, headers: HTML_PAGE_HEADERS },
  );
}
