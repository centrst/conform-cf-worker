#!/usr/bin/env node
// Prints the opaque hash of an exact email address for the
// QUOTA_IDENTITY_EXCEPTIONS var. The hash is the same HMAC used for route
// owner IDs, so no plaintext address ever needs to appear in configuration.
//
//   OWNER_HASH_SECRET=<base64url 32 bytes> node scripts/hash-email.mjs someone@example.com

import { webcrypto } from 'node:crypto';

const email = process.argv[2];
const secret = process.env.OWNER_HASH_SECRET;

if (!email || !secret) {
  console.error('Usage: OWNER_HASH_SECRET=<secret> node scripts/hash-email.mjs <email>');
  process.exit(1);
}

function base64UrlDecode(value) {
  return new Uint8Array(Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64'));
}

function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

const keyBytes = base64UrlDecode(secret);
if (keyBytes.byteLength !== 32) {
  console.error('OWNER_HASH_SECRET must be a base64url-encoded 32-byte secret');
  process.exit(1);
}

const key = await webcrypto.subtle.importKey(
  'raw',
  keyBytes,
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign'],
);
const signature = await webcrypto.subtle.sign(
  'HMAC',
  key,
  new TextEncoder().encode(email.trim().toLowerCase()),
);
console.log(base64UrlEncode(new Uint8Array(signature).subarray(0, 18)));
