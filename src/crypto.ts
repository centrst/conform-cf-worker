import type { PendingRoutePayload, RouteTokenPayload } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN_PREFIX = 'cf1';

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
    throw new Error(`${name} is not configured`);
  }

  let decoded: Uint8Array<ArrayBuffer>;
  try {
    decoded = base64UrlDecode(secret);
  } catch {
    throw new Error(`${name} must be a base64url-encoded 32-byte secret`);
  }

  if (decoded.byteLength !== 32) {
    throw new Error(`${name} must be a base64url-encoded 32-byte secret`);
  }
  return decoded;
}

function purposeCode(kind: RouteTokenPayload['kind'] | PendingRoutePayload['kind']): string {
  return kind === 'route' ? 'r' : 'p';
}

function purposeFromCode(code: string): RouteTokenPayload['kind'] | PendingRoutePayload['kind'] {
  if (code === 'r') return 'route';
  if (code === 'p') return 'pending';
  throw new Error('Unsupported Conform token purpose');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  if (email.length > 254 || email.includes('\n') || email.includes('\r')) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
}

export async function ownerIdForEmail(email: string, secret: string | undefined): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    decodeSecret(secret, 'OWNER_HASH_SECRET'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(normalizeEmail(email)));
  return base64UrlEncode(new Uint8Array(signature).subarray(0, 18));
}

export async function sealToken(
  payload: RouteTokenPayload | PendingRoutePayload,
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

export async function openToken<T extends RouteTokenPayload | PendingRoutePayload>(
  token: string,
  expectedKind: T['kind'],
  secret: string | undefined,
): Promise<T> {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) {
    throw new Error('Invalid Conform route token');
  }
  const kind = purposeFromCode(parts[1]);
  if (kind !== expectedKind) {
    throw new Error('Unexpected Conform token purpose');
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
    throw new Error('Invalid Conform route token');
  }

  const payload = JSON.parse(decoder.decode(plaintext)) as T;
  if (payload.kind !== expectedKind || payload.version !== 1) {
    throw new Error('Invalid Conform route token payload');
  }
  return payload;
}

export function randomRouteId(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}
