import { describe, expect, it } from 'vitest';
import {
  normalizeEmail,
  openToken,
  ownerIdForEmail,
  sealToken,
} from './crypto';
import type { RouteTokenPayload } from './types';

function secret(fill: number): string {
  const bytes = new Uint8Array(32);
  bytes.fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

describe('route token cryptography', () => {
  it('encrypts and authenticates route data', async () => {
    const payload: RouteTokenPayload = {
      kind: 'route',
      version: 1,
      ownerId: 'owner',
      routeId: 'route',
      email: 'owner@example.com',
      formName: 'Contact',
      issuedAt: 1,
    };

    const token = await sealToken(payload, secret(1));
    expect(token).toMatch(/^cf1\.r\./u);
    expect(token).not.toContain(payload.email);
    await expect(openToken(token, 'route', secret(1))).resolves.toEqual(payload);
    await expect(openToken(token, 'route', secret(2))).rejects.toThrow(
      'Invalid Conform route token',
    );
  });

  it('uses the same opaque owner id for normalized versions of an inbox', async () => {
    const first = await ownerIdForEmail(' Owner@Example.com ', secret(3));
    const second = await ownerIdForEmail('owner@example.com', secret(3));
    expect(first).toBe(second);
    expect(first).not.toContain('owner');
    expect(normalizeEmail(' Owner@Example.com ')).toBe('owner@example.com');
  });
});
