import { quotaResetsAt } from './contract';
import { ConfigError } from './errors';
import { jsonAttachment, submissionText } from './submission';
import type {
  EmailMessageBuilder,
  Env,
  PendingRoutePayload,
  RouteTokenPayload,
  SubmissionFields,
} from './types';

function sender(env: Env): { email: string; name: string } {
  if (!env.FROM_EMAIL) throw new ConfigError('FROM_EMAIL is not configured');
  return {
    email: env.FROM_EMAIL,
    name: env.FROM_NAME?.trim() || 'conForm',
  };
}

export function publicUrl(env: Env, fallbackOrigin: string): string {
  return (env.PUBLIC_URL || fallbackOrigin).replace(/\/+$/u, '');
}

function safeSubject(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 200);
}

export function submissionEndpoint(env: Env, origin: string, formId: string): string {
  return `${publicUrl(env, origin)}/f/${formId}`;
}

export function routeStatusUrl(env: Env, origin: string, formId: string): string {
  return `${publicUrl(env, origin)}/v1/routes/${formId}`;
}

export async function sendSubmissionEmail(
  env: Env,
  route: RouteTokenPayload,
  fields: SubmissionFields,
  options: {
    format: 'text' | 'json';
    replyTo?: string;
    subject?: string;
    test?: boolean;
    testNonce?: string;
  },
): Promise<void> {
  const baseSubject = safeSubject(
    options.subject || `New submission from ${route.formName}`,
  );
  let text = submissionText(route.formName, fields);
  if (options.test) {
    text += '\n\nThis is a test submission sent to verify delivery.';
    if (options.testNonce) text += `\nTest reference: ${options.testNonce}`;
  }
  const message: EmailMessageBuilder = {
    to: route.email,
    from: sender(env),
    subject: options.test ? safeSubject(`[Test] ${baseSubject}`) : baseSubject,
    text,
  };
  if (options.replyTo) message.replyTo = options.replyTo;
  if (options.format === 'json') message.attachments = [jsonAttachment(fields)];
  await env.EMAIL.send(message);
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "1 September 2026" — spelled out so no reader has to guess a date order. */
function readableUtcDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * Where someone is sent to raise their allowance. Derived from DOCS_URL, which
 * points at the docs index one level below the product page; the trailing slash
 * is forced because `new URL('../x', '…/docs')` climbs a segment too far.
 *
 * A self-hosted deployment has no conForm+ to sell, so this is only used when
 * the deployment advertises docs at all.
 */
function plusUrl(env: Env): string | undefined {
  if (!env.DOCS_URL) return undefined;
  const docs = env.DOCS_URL.endsWith('/') ? env.DOCS_URL : `${env.DOCS_URL}/`;
  return new URL('../#conform-plus', docs).toString();
}

/**
 * Warns an inbox owner about their allowance.
 *
 * The old copy ended with a bare "Upgrade to keep receiving submissions" and no
 * link, which left the reader at their most frustrated moment with nothing to
 * click and no idea when service resumes. Every line here has to be actionable:
 * when the allowance resets, where to get a bigger one, and the self-host route
 * for anyone who would rather not be metered at all.
 */
export async function sendQuotaWarning(
  env: Env,
  route: RouteTokenPayload,
  used: number,
  limit: number,
  month: string,
): Promise<void> {
  const exhausted = used >= limit;
  const resetsOn = readableUtcDate(quotaResetsAt(month));
  const source = env.SOURCE_URL || 'https://github.com/centrst/conform-cf-worker';

  const subject = exhausted
    ? `Your conForm allowance is full until ${resetsOn}`
    : `Your conForm allowance is running low`;

  const opening = exhausted
    ? `You have used all ${limit} submissions in this month's allowance, so new submissions are not being delivered right now.`
    : `You have used ${used} of the ${limit} submissions in this month's allowance.`;

  const plus = plusUrl(env);

  const text = [
    opening,
    ``,
    `The allowance resets on ${resetsOn}. It is shared by every form delivering to this inbox, not counted per form.`,
    ...(plus
      ? [``, `Need more than ${limit} a month? conForm+ raises the hosted limit:`, plus]
      : []),
    ``,
    `You can also run conForm yourself on your own Cloudflare account and set your own limit. It is the same open-source Worker that delivers this message:`,
    source,
  ].join('\n');

  await env.EMAIL.send({
    to: route.email,
    from: sender(env),
    subject: safeSubject(subject),
    text,
  });
}

export async function sendArbitraryVerification(
  env: Env,
  pending: PendingRoutePayload,
  token: string,
  origin: string,
): Promise<void> {
  const verifyUrl = `${publicUrl(env, origin)}/v1/routes/verify?token=${encodeURIComponent(token)}`;
  await env.EMAIL.send({
    to: pending.email,
    from: sender(env),
    subject: safeSubject(`Confirm ${pending.formName} on conForm`),
    text: [
      `Confirm that ${pending.email} should receive submissions for ${pending.formName}.`,
      ...(pending.delivery?.webhook
        ? [
            '',
            `Submissions for this form will also be delivered as signed webhooks to ${pending.delivery.webhook.url}.`,
          ]
        : []),
      '',
      verifyUrl,
      '',
      'Every route delivering to this inbox shares the same monthly submission allowance.',
    ].join('\n'),
  });
}
