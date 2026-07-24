export const POLL_INTERVAL_SECONDS = 15;

export type NextAction =
  | { type: 'none' }
  | {
      type: 'human_verification';
      message: string;
      poll: { url: string; interval_seconds: number };
    };

export function nextActionFor(status: 'pending' | 'active', statusUrl: string): NextAction {
  if (status === 'active') return { type: 'none' };
  return {
    type: 'human_verification',
    message:
      'The destination inbox must confirm a verification email. Poll the status URL until ' +
      'status is "active" — the endpoint URL will not change.',
    poll: { url: statusUrl, interval_seconds: POLL_INTERVAL_SECONDS },
  };
}

export interface RouteResourceArgs {
  status: 'pending' | 'active';
  formId: string;
  alias: string;
  endpoint: string;
  statusUrl: string;
  message: string;
  createdAt?: string;
  verificationExpiresAt?: string;
}

/** The uniform success body for provisioning, status, and verify responses. */
export function routeResource(args: RouteResourceArgs): Record<string, unknown> {
  return {
    success: true,
    status: args.status === 'active' ? 'active' : 'pending_verification',
    form_id: args.formId,
    alias: args.alias,
    endpoint: args.endpoint,
    status_url: args.statusUrl,
    ...(args.createdAt ? { created_at: args.createdAt } : {}),
    ...(args.verificationExpiresAt
      ? { verification_expires_at: args.verificationExpiresAt }
      : {}),
    message: args.message,
    next_action: nextActionFor(args.status, args.statusUrl),
  };
}

/** First instant of the month after a `YYYY-MM` quota month, as ISO 8601. */
export function quotaResetsAt(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 1)).toISOString();
}
