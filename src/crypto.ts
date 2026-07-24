import { parseExceptionList, quotaIdentity } from './email-identity';
import { ConfigError, TokenError } from './errors';
import type { ManageTokenPayload, PendingRoutePayload, RouteTokenPayload } from './types';

type TokenPayload = RouteTokenPayload | PendingRoutePayload | ManageTokenPayload;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN_PREFIX = 'cf1';
const FORM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeSecret(secret: string | undefined, name: string): Uint8Array<ArrayBuffer> {
  if (!secret) {
    throw new ConfigError(`${name} is not configured`);
  }

  let decoded: Uint8Array<ArrayBuffer>;
  try {
    decoded = base64UrlDecode(secret);
  } catch {
    throw new ConfigError(`${name} must be a base64url-encoded 32-byte secret`);
  }

  if (decoded.byteLength !== 32) {
    throw new ConfigError(`${name} must be a base64url-encoded 32-byte secret`);
  }
  return decoded;
}

function purposeCode(kind: TokenPayload['kind']): string {
  if (kind === 'route') return 'r';
  if (kind === 'pending') return 'p';
  return 'm';
}

function purposeFromCode(code: string): TokenPayload['kind'] {
  if (code === 'r') return 'route';
  if (code === 'p') return 'pending';
  if (code === 'm') return 'manage';
  throw new TokenError('Unsupported conForm token purpose');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  if (email.length > 254 || email.includes('\n') || email.includes('\r')) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
}

async function hmacId(value: string, secret: string | undefined): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    decodeSecret(secret, 'OWNER_HASH_SECRET'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature).subarray(0, 18));
}

export async function ownerIdForEmail(email: string, secret: string | undefined): Promise<string> {
  return hmacId(normalizeEmail(email), secret);
}

/**
 * The quota/rate-limit key for an address: the HMAC of its billing identity
 * (see email-identity.ts), unless the exact address is on the operator
 * exception list — then the exact-address hash is used, restoring a separate
 * allowance for a falsely merged mailbox.
 */
export async function quotaKeyForEmail(
  email: string,
  secret: string | undefined,
  exceptionList?: string,
): Promise<string> {
  const exact = await ownerIdForEmail(email, secret);
  if (parseExceptionList(exceptionList).has(exact)) return exact;
  return hmacId(`quota.v1.${quotaIdentity(email)}`, secret);
}

/**
 * Deterministic form ID for an Idempotency-Key: the same owner and key always
 * derive the same ID, which makes route creation replay-safe with no snapshot
 * storage — the route record itself is the idempotency state.
 */
export async function deriveRouteId(
  ownerId: string,
  idempotencyKey: string,
  secret: string | undefined,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    decodeSecret(secret, 'OWNER_HASH_SECRET'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`idem.v1.${ownerId}.${idempotencyKey}`),
  );
  const bytes = new Uint8Array(signature).subarray(0, 16);
  let formId = 'cfm_';
  for (const byte of bytes) {
    formId += FORM_ID_ALPHABET[byte & 31];
  }
  return formId;
}

/** Fingerprint of a creation request body, for idempotent-replay conflict checks. */
export async function requestFingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value)));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function sealToken(
  payload: TokenPayload,
  secret: string | undefined,
): Promise<string> {
  const code = purposeCode(payload.kind);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    'raw',
    decodeSecret(secret, 'ROUTE_TOKEN_SECRET'),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(`${TOKEN_PREFIX}.${code}`),
    },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return `${TOKEN_PREFIX}.${code}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function openToken<T extends TokenPayload>(
  token: string,
  expectedKind: T['kind'],
  secret: string | undefined,
): Promise<T> {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) {
    throw new TokenError('Invalid conForm route token');
  }
  const kind = purposeFromCode(parts[1]);
  if (kind !== expectedKind) {
    throw new TokenError('Unexpected conForm token purpose');
  }

  const key = await crypto.subtle.importKey(
    'raw',
    decodeSecret(secret, 'ROUTE_TOKEN_SECRET'),
    'AES-GCM',
    false,
    ['decrypt'],
  );

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64UrlDecode(parts[2]),
        additionalData: encoder.encode(`${TOKEN_PREFIX}.${parts[1]}`),
      },
      key,
      base64UrlDecode(parts[3]),
    );
  } catch {
    throw new TokenError('Invalid conForm route token');
  }

  const payload = JSON.parse(decoder.decode(plaintext)) as T;
  const version = payload.version as number;
  if (payload.kind !== expectedKind || (version !== 1 && version !== 2)) {
    throw new TokenError('Invalid conForm route token payload');
  }
  return payload;
}

export function randomRouteId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let formId = 'cfm_';
  for (const byte of bytes) {
    formId += FORM_ID_ALPHABET[byte & 31];
  }
  return formId;
}

export function isValidFormId(value: string): boolean {
  return /^cfm_[A-HJ-NP-Z2-9]{16}$/u.test(value);
}
