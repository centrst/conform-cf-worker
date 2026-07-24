export interface ErrorSpec {
  status: number;
  retryable: boolean;
  /** Declared in the contract but not yet reachable at runtime. */
  planned?: true;
}

/**
 * The single source of truth for the machine error contract. Every non-2xx
 * response carries one of these codes; contract.test.ts enforces that this
 * table, openapi.json, and the runtime never drift apart. Entries marked
 * `planned` are reserved for features that have a designed contract but no
 * implementation yet — they appear in the spec as planned and must not be
 * emitted at runtime.
 */
export const ERROR_TABLE = {
  invalid_json: { status: 400, retryable: false },
  invalid_email: { status: 400, retryable: false },
  invalid_alias: { status: 400, retryable: false },
  invalid_idempotency_key: { status: 400, retryable: false, planned: true },
  idempotency_key_conflict: { status: 422, retryable: false, planned: true },
  delivery_config_unsupported: { status: 400, retryable: false, planned: true },
  invalid_webhook_url: { status: 400, retryable: false, planned: true },
  invalid_redirect_url: { status: 400, retryable: false, planned: true },
  unknown_framework: { status: 400, retryable: false, planned: true },
  rate_limited: { status: 429, retryable: true },
  verified_destination_capacity: { status: 503, retryable: false },
  route_not_found: { status: 404, retryable: false },
  verification_token_required: { status: 400, retryable: false },
  verification_token_invalid: { status: 401, retryable: false },
  verification_token_expired: { status: 410, retryable: false },
  verification_mismatch: { status: 409, retryable: false },
  verification_unavailable: { status: 404, retryable: false },
  management_token_required: { status: 401, retryable: false, planned: true },
  management_token_invalid: { status: 403, retryable: false, planned: true },
  submission_empty: { status: 400, retryable: false },
  submission_too_large: { status: 413, retryable: false },
  unsupported_media_type: { status: 415, retryable: false },
  file_uploads_unsupported: { status: 400, retryable: false },
  inbox_not_verified: { status: 409, retryable: true },
  monthly_allowance_exhausted: { status: 429, retryable: false },
  delivery_failed: { status: 503, retryable: true },
  webhook_delivery_failed: { status: 502, retryable: true, planned: true },
  method_not_allowed: { status: 405, retryable: false },
  not_found: { status: 404, retryable: false },
  config_incomplete: { status: 500, retryable: false },
  internal_error: { status: 500, retryable: true },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_TABLE;

/** A failure with a stable machine code and a human-readable message. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly extras?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, extras?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.extras = extras;
  }
}

/** The Worker is missing configuration; the caller cannot fix this. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** A sealed token failed to parse, decrypt, or match its expected purpose. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function errorResponse(error: ApiError, extraHeaders?: HeadersInit): Response {
  const spec: ErrorSpec = ERROR_TABLE[error.code];
  return json(
    {
      success: false,
      error: error.code,
      message: error.message,
      retryable: spec.retryable,
      ...error.extras,
    },
    spec.status,
    extraHeaders,
  );
}
