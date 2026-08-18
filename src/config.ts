import type { DeliveryMode, Env } from './types';

export function deliveryMode(env: Env): DeliveryMode {
  return env.DELIVERY_MODE === 'arbitrary' ? 'arbitrary' : 'verified';
}

export function monthlyLimit(env: Env): number {
  const parsed = Number.parseInt(env.MONTHLY_LIMIT ?? '250', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 250;
}

/**
 * A ceiling on one day's deliveries. The monthly quota bounds the total but
 * not how fast it goes: at the per-minute rate limit alone a 250 allowance
 * drains in under an hour. A day cap bounds the damage without dropping a
 * legitimately busy afternoon the way a tighter per-minute limit would.
 */
export function dailyLimit(env: Env): number {
  const parsed = Number.parseInt(env.DAILY_LIMIT ?? '', 10);
  if (Number.isFinite(parsed)) return Math.max(0, parsed);
  // An unmetered deployment stays unmetered. Deriving a floor of 25 from a
  // monthly limit of zero would put a day cap on a Worker configured for
  // unlimited delivery -- today the reservation short-circuits before the day
  // ceiling is consulted, so it would only bite if that order ever changed.
  const monthly = monthlyLimit(env);
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
