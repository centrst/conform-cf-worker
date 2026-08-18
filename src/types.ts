export type DeliveryMode = 'verified' | 'arbitrary';

export interface EmailAttachment {
  content: string;
  filename: string;
  type: string;
  disposition: 'attachment';
}

export interface EmailMessageBuilder {
  to: string | string[];
  from: string | { email: string; name?: string };
  replyTo?: string | { email: string; name?: string };
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
}

export interface EmailSendResult {
  messageId: string;
}

export interface EmailSender {
  send(message: EmailMessageBuilder): Promise<EmailSendResult>;
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  EMAIL: EmailSender;
  QUOTAS?: DurableObjectNamespace;
  ROUTES: DurableObjectNamespace;
  REGISTRATION_RATE_LIMITER?: RateLimiter;
  SUBMISSION_RATE_LIMITER?: RateLimiter;
  THROTTLE_REPORT_LIMITER?: RateLimiter;

  DELIVERY_MODE?: DeliveryMode;
  MONTHLY_LIMIT?: string;
  QUOTA_IDENTITY_EXCEPTIONS?: string;
  MAX_REQUEST_SIZE?: string;
  FROM_EMAIL?: string;
  FROM_NAME?: string;
  PUBLIC_URL?: string;
  SOURCE_URL?: string;
  SOURCE_COMMIT?: string;
  DOCS_URL?: string;
  MCP_URL?: string;
  /** Optional secret used by a trusted account broker to list routes by verified email. */
  ACCOUNT_LOOKUP_SECRET?: string;

  ROUTE_TOKEN_SECRET?: string;
  OWNER_HASH_SECRET?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

export type RouteDeliveryMode = 'email' | 'webhook' | 'both';

export interface WebhookDeliveryConfig {
  url: string;
  secret: string;
}

export interface RouteDeliveryConfig {
  mode: RouteDeliveryMode;
  webhook?: WebhookDeliveryConfig;
}

export interface RouteTokenPayload {
  kind: 'route';
  version: 1 | 2;
  ownerId: string;
  routeId: string;
  email: string;
  formName: string;
  issuedAt: number;
  /** Present (version 2) when the route also or exclusively delivers by webhook. */
  delivery?: RouteDeliveryConfig;
}

export interface PendingRoutePayload {
  kind: 'pending';
  version: 1 | 2;
  ownerId: string;
  routeId: string;
  email: string;
  formName: string;
  issuedAt: number;
  expiresAt: number;
  delivery?: RouteDeliveryConfig;
}

export interface ManageTokenPayload {
  kind: 'manage';
  version: 1;
  ownerId: string;
  routeId: string;
  issuedAt: number;
}

export interface QuotaReservation {
  allowed: boolean;
  used: number;
  limit: number;
  month: string;
  /**
   * Set when this reservation is the one that crossed a warning mark. Claimed
   * inside the quota Durable Object, so it is returned at most once per mark
   * per month however many submissions race or roll back.
   */
  warn?: 'low' | 'full';
}

export type SubmissionValue = string | string[];
export type SubmissionFields = Record<string, SubmissionValue>;

export interface StoredRouteRecord {
  formId: string;
  alias: string;
  ownerId: string;
  encryptedRoute: string;
  status: 'pending' | 'active';
  destinationId?: string;
  createdAt: string;
  /** Fingerprint of the creation request when an Idempotency-Key was used. */
  requestHash?: string;
  /** Opaque billing-identity hash; falls back to ownerId for legacy rows. */
  quotaKey?: string;
}
