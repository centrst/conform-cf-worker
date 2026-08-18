import type { DeliveryMode, Env } from './types';

export function deliveryMode(env: Env): DeliveryMode {
  return env.DELIVERY_MODE === 'arbitrary' ? 'arbitrary' : 'verified';
}

export function monthlyLimit(env: Env): number {
  const parsed = Number.parseInt(env.MONTHLY_LIMIT ?? '250', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 250;
}

/**
 * An operator's explicit day ceiling, or 0 meaning "derive one".
 *
 * Deliberately not the derived value. A day cap has to come from the allowance
 * actually in force, and that is the *granted* plan, which only the quota
 * object knows -- so the derivation lives there, beside effectiveLimit. Doing
 * it here read the deployment default instead: an inbox granted 10,000 a month
 * was still held to a day cap derived from 250, which capped it at 1,500 and
 * made the allowance it had been sold unreachable.
 */
export function dailyLimitOverride(env: Env): number | undefined {
  const parsed = Number.parseInt(env.DAILY_LIMIT ?? '', 10);
  // undefined, not 0: DAILY_LIMIT="0" is an operator turning the ceiling off,
  // and it has to survive the trip to the quota object as a decision rather
  // than as an absence.
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

/**
 * The day ceiling an inbox with no granted plan gets. For discovery and docs
 * only -- the delivery path takes the number the quota object returns, because
 * only that object knows what the inbox is entitled to.
 */
export function defaultDailyLimit(env: Env): number {
  return dailyLimitOverride(env) ?? derivedDailyLimit(monthlyLimit(env));
}

/**
 * A fifth of a month in one day, floor 25. The monthly quota bounds the total
 * but not how fast it goes: at the per-minute rate limit alone a 250 allowance
 * drains in under an hour. A day cap bounds the damage without dropping a
 * legitimately busy afternoon the way a tighter per-minute limit would.
 */
export function derivedDailyLimit(monthly: number): number {
  if (monthly === 0) return 0;
  return Math.max(25, Math.ceil(monthly * 0.2));
}

/** Distinct fields one submission may carry. A form with fourteen inputs never sends two hundred. */
export function maxFields(env: Env): number {
  const parsed = Number.parseInt(env.MAX_FIELDS ?? '100', 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 100;
}

/** Characters one field may carry. Bounds a single pasted payload inside an otherwise normal body. */
export function maxFieldLength(env: Env): number {
  const parsed = Number.parseInt(env.MAX_FIELD_LENGTH ?? '20000', 10);
  return Number.isFinite(parsed) ? Math.max(64, parsed) : 20000;
}

export function maxRequestSize(env: Env): number {
  const parsed = Number.parseInt(env.MAX_REQUEST_SIZE ?? '102400', 10);
  return Number.isFinite(parsed) ? Math.max(1024, parsed) : 102400;
}
