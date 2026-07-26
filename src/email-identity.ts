/**
 * Quota identity rules — the spec for how conForm decides which addresses
 * share one monthly allowance. This is deliberately separate from
 * `normalizeEmail` (the delivery form): identity normalization applies to
 * quota and rate-limit keys ONLY, never to delivery routing, verification,
 * route ownership, or idempotency scope.
 *
 * Rules, applied in order:
 *   1. trim + lowercase
 *   2. domain aliases that provably share a mailbox namespace
 *   3. universal `+suffix` stripping (all domains)
 *   4. provider-scoped rules: dots are insignificant on gmail.com;
 *      `-suffix` subaddressing on yahoo.* domains only
 *
 * Operators can exempt an exact address from all rules via the
 * QUOTA_IDENTITY_EXCEPTIONS var (see quotaKeyForEmail in crypto.ts): the
 * escape hatch for the rare false merge, e.g. a corporate system where
 * `dev+ops@` is a real, distinct mailbox.
 */

/** Domains that are alternate names for the same mailbox namespace. */
export const DOMAIN_ALIASES: Record<string, string> = {
  'googlemail.com': 'gmail.com',
  'protonmail.com': 'proton.me',
  'pm.me': 'proton.me',
};

/** Providers where dots in the local part do not distinguish mailboxes. */
export const DOT_INSIGNIFICANT_DOMAINS = new Set(['gmail.com']);

function isYahooDomain(domain: string): boolean {
  return domain === 'yahoo.com' || domain.startsWith('yahoo.');
}

/**
 * The billing/quota identity of an address. Not a deliverable address —
 * never use this for routing mail.
 */
export function quotaIdentity(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return normalized;

  let local = normalized.slice(0, at);
  let domain = normalized.slice(at + 1);

  domain = DOMAIN_ALIASES[domain] ?? domain;

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);

  if (DOT_INSIGNIFICANT_DOMAINS.has(domain)) {
    local = local.replaceAll('.', '');
  } else if (isYahooDomain(domain)) {
    const dash = local.indexOf('-');
    if (dash > 0) local = local.slice(0, dash);
  }

  return `${local}@${domain}`;
}

/** Parses the QUOTA_IDENTITY_EXCEPTIONS var: comma-separated opaque hashes. */
export function parseExceptionList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}
