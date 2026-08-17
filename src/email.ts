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
 * Warns an inbox owner about their allowance.
 *
 * This email must never promise an upgrade. conForm+ is not a product, no
 * payment provider is wired, and the dashboard states that everything is free —
 * so telling someone to upgrade at the moment their forms stop working sends
 * them after a purchase they cannot make. The two things that are genuinely
 * actionable are the reset date and self-hosting, so those are what it says.
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

  const text = [
    opening,
    ``,
    `The allowance resets on ${resetsOn}. It is shared by every form delivering to this inbox, not counted per form.`,
    ``,
    `If you consistently need more than ${limit} a month, you can run conForm yourself on your own Cloudflare account and set your own limit. It is the same open-source Worker that delivers this message:`,
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
