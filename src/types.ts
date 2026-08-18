import type { FormSchema } from './schema';

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
  /**
   * Separate binding from SUBMISSION_RATE_LIMITER so the per-client ceiling can
   * be lower than the per-form one. A single binding cannot carry two limits,
   * which is why the asymmetry this file has always described was never real.
   */
  SUBMISSION_CLIENT_RATE_LIMITER?: RateLimiter;
  THROTTLE_REPORT_LIMITER?: RateLimiter;
  ROTATION_RATE_LIMITER?: RateLimiter;

  DELIVERY_MODE?: DeliveryMode;
  MONTHLY_LIMIT?: string;
  DAILY_LIMIT?: string;
  MAX_FIELDS?: string;
  MAX_FIELD_LENGTH?: string;
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
  /**
   * Who runs this deployment. Named in the llms.txt one-liner, and nowhere
   * else. Unset, the text simply omits the attribution rather than inheriting
   * the upstream operator's -- a self-hoster's origin should not announce
   * itself as somebody else's product.
   */
  OPERATOR_NAME?: string;
  /**
   * Set to "true" to require a granted plan before a route may declare a
   * schema. Only an operator charging for this needs it; a deployment that
   * bills nobody should leave it unset, and the default is off so that running
   * this Worker yourself never refuses you a feature you cannot unlock.
   */
  PLAN_ENFORCEMENT?: string;

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
  version: 1 | 2 | 3;
  ownerId: string;
  routeId: string;
  email: string;
  formName: string;
  issuedAt: number;
  /** Present (version 2) when the route also or exclusively delivers by webhook. */
  delivery?: RouteDeliveryConfig;
  /**
   * Present (version 3) when the form has declared its shape. Sealed with the
   * rest of the payload rather than stored beside it: field names are the
   * customer's, and the storage boundary this project documents says only the
   * alias is kept in plaintext.
   */
  schema?: FormSchema;
}

export interface PendingRoutePayload {
  kind: 'pending';
  version: 1 | 2 | 3;
  ownerId: string;
  routeId: string;
  email: string;
  formName: string;
  issuedAt: number;
  expiresAt: number;
  delivery?: RouteDeliveryConfig;
  schema?: FormSchema;
}

export interface ManageTokenPayload {
  kind: 'manage';
  version: 1;
  ownerId: string;
  routeId: string;
  issuedAt: number;
}

/**
 * Mints access keys and nothing else. Deliberately not the management token:
 * this one lives in a CI secret, and a management token can delete the route
 * along with its inbox binding.
 */
export interface RotateTokenPayload {
  kind: 'rotate';
  version: 1;
  ownerId: string;
  routeId: string;
  issuedAt: number;
}

export interface RouteAccessKey {
  /** Public label. Identifies a key in listings without revealing it. */
  keyId: string;
  /**
   * Assigned by the route object, strictly increasing. Supersession is ordered
   * by this rather than by `createdAt`, because two builds can mint inside one
   * millisecond and a tied timestamp cannot say which key replaced which.
   */
  seq?: number;
  /** HMAC of the key. The key itself is returned once, when it is minted. */
  hash: string;
  createdAt: string;
  /**
   * Set the first time this key is accepted on a submission. Retiring the
   * previous key waits for this rather than a timer, so a pipeline that mints
   * a key and then fails to deploy leaves the live site working.
   */
  usedAt?: string;
}

export interface QuotaReservation {
  allowed: boolean;
  used: number;
  limit: number;
  month: string;
  /** Which ceiling refused it. Absent means the monthly allowance. */
  reason?: 'daily';
  day?: string;
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
  /** Newest first. Bounded by MAX_LIVE_KEYS in routes.ts, plus the newest accepted key. */
  accessKeys?: RouteAccessKey[];
  /** When set, a submission without a recognised access key is refused. */
  requireKey?: boolean;
}
