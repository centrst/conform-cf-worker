import { ApiError } from './errors';
import type { RouteTokenPayload, SubmissionFields, WebhookDeliveryConfig } from './types';

/**
 * Signed JSON webhook delivery (Standard Webhooks style). There is no durable
 * retry queue by design: persisting submission content for redelivery would
 * create exactly the stored-submissions surface conForm promises not to have.
 * Delivery is at-most-once per invocation; receivers deduplicate on the
 * webhook-id header, which is stable across in-invocation retries.
 */

const encoder = new TextEncoder();

export const WEBHOOK_EVENT_VERSION = '2026-07';

export interface SubmissionEvent {
  type: 'submission.received';
  version: string;
  form_id: string;
  alias: string;
  test: boolean;
  received_at: string;
  data: {
    fields: SubmissionFields;
    reply_to?: string;
    subject?: string;
  };
}

export function submissionEvent(
  route: RouteTokenPayload,
  fields: SubmissionFields,
  options: { test: boolean; replyTo?: string; subject?: string },
): SubmissionEvent {
  return {
    type: 'submission.received',
    version: WEBHOOK_EVENT_VERSION,
    form_id: route.routeId,
    alias: route.formName,
    test: options.test,
    received_at: new Date().toISOString(),
    data: {
      fields,
      ...(options.replyTo ? { reply_to: options.replyTo } : {}),
      ...(options.subject ? { subject: options.subject } : {}),
    },
  };
}

export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `whsec_${btoa(binary)}`;
}

function secretBytes(secret: string): Uint8Array {
  const encoded = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function signWebhook(
  secret: string,
  webhookId: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes(secret) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${webhookId}.${timestamp}.${body}`),
  );
  let binary = '';
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return `v1,${btoa(binary)}`;
}

const BLOCKED_HOST_PATTERN = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/u;

export function validateWebhookUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError('invalid_webhook_url', 'Webhook URL must be an absolute https:// URL');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    !hostname.includes('.') ||
    BLOCKED_HOST_PATTERN.test(hostname) ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local') ||
    /^\d+\.\d+\.\d+\.\d+$/u.test(hostname) ||
    hostname.startsWith('[')
  ) {
    throw new ApiError(
      'invalid_webhook_url',
      'Webhook URL must be a public https:// URL with a hostname, not an IP address or internal name',
    );
  }
  return parsed.toString();
}

export interface WebhookAttemptOptions {
  /** Waits before each retry, in milliseconds. Length = number of retries. */
  retryWaitsMs: number[];
  timeoutMs: number;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delivers one signed event. Retries on network errors and 5xx responses;
 * a 4xx response is treated as permanent. Never reads or logs the receiver's
 * response body.
 */
export async function deliverWebhook(
  config: WebhookDeliveryConfig,
  event: SubmissionEvent,
  options: WebhookAttemptOptions,
): Promise<{ ok: boolean; status?: number }> {
  const fetcher = options.fetcher ?? fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  const body = JSON.stringify(event);
  const webhookId = `msg_${crypto.randomUUID()}`;
  const attempts = options.retryWaitsMs.length + 1;

  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(options.retryWaitsMs[attempt - 1]);
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const response = await fetcher(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'conform-webhook/1',
          'webhook-id': webhookId,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': await signWebhook(config.secret, webhookId, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      lastStatus = response.status;
      if (response.ok) return { ok: true, status: response.status };
      if (response.status >= 400 && response.status < 500) {
        return { ok: false, status: response.status };
      }
    } catch {
      lastStatus = undefined;
    }
  }
  return { ok: false, status: lastStatus };
}
