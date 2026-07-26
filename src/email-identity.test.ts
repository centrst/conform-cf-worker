import { describe, expect, it } from 'vitest';
import { ownerIdForEmail, quotaKeyForEmail } from './crypto';
import { quotaIdentity } from './email-identity';
import { secret } from './test-support';

describe('quotaIdentity', () => {
  it('strips +suffixes on every domain', () => {
    expect(quotaIdentity('Hello+World@Example.COM')).toBe('hello@example.com');
    expect(quotaIdentity('dev+ops@corp.internal.example')).toBe('dev@corp.internal.example');
  });

  it('keeps a leading plus intact', () => {
    expect(quotaIdentity('+lead@example.com')).toBe('+lead@example.com');
  });

  it('strips dots only on gmail and merges the googlemail alias', () => {
    expect(quotaIdentity('first.last+x@gmail.com')).toBe('firstlast@gmail.com');
    expect(quotaIdentity('first.last@googlemail.com')).toBe('firstlast@gmail.com');
    expect(quotaIdentity('first.last@company.com')).toBe('first.last@company.com');
  });

  it('merges the proton domain aliases without touching dots', () => {
    expect(quotaIdentity('a.b@protonmail.com')).toBe('a.b@proton.me');
    expect(quotaIdentity('a.b@pm.me')).toBe('a.b@proton.me');
    expect(quotaIdentity('a.b@proton.me')).toBe('a.b@proton.me');
  });

  it('strips dash subaddresses on yahoo domains only', () => {
    expect(quotaIdentity('base-keyword@yahoo.com')).toBe('base@yahoo.com');
    expect(quotaIdentity('base-keyword@yahoo.co.uk')).toBe('base@yahoo.co.uk');
    expect(quotaIdentity('first-last@company.com')).toBe('first-last@company.com');
    expect(quotaIdentity('-lead@yahoo.com')).toBe('-lead@yahoo.com');
  });
});

describe('quotaKeyForEmail', () => {
  it('merges identity variants into one quota key while owner IDs stay distinct', async () => {
    const tagged = 'hello+work@gmail.com';
    const dotted = 'h.ello@googlemail.com';
    const plain = 'hello@gmail.com';
    const keys = await Promise.all(
      [tagged, dotted, plain].map((email) => quotaKeyForEmail(email, secret(2))),
    );
    expect(keys[0]).toBe(keys[2]);
    expect(keys[1]).toBe(keys[2]);
    const owners = await Promise.all(
      [tagged, plain].map((email) => ownerIdForEmail(email, secret(2))),
    );
    expect(owners[0]).not.toBe(owners[1]);
  });

  it('restores exact-address identity for exception-listed addresses', async () => {
    const email = 'dev+ops@corp.example';
    const exact = await ownerIdForEmail(email, secret(2));
    const merged = await quotaKeyForEmail(email, secret(2));
    const excepted = await quotaKeyForEmail(email, secret(2), ` ${exact} ,other`);
    expect(merged).not.toBe(exact);
    expect(excepted).toBe(exact);
  });
});
