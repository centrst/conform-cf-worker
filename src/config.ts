import type { DeliveryMode, Env } from './types';

export function deliveryMode(env: Env): DeliveryMode {
  return env.DELIVERY_MODE === 'arbitrary' ? 'arbitrary' : 'verified';
}

export function monthlyLimit(env: Env): number {
  const parsed = Number.parseInt(env.MONTHLY_LIMIT ?? '250', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 250;
}

export function maxRequestSize(env: Env): number {
  const parsed = Number.parseInt(env.MAX_REQUEST_SIZE ?? '102400', 10);
  return Number.isFinite(parsed) ? Math.max(1024, parsed) : 102400;
}
