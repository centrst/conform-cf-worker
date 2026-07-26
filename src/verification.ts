import { destinationAddressStatus } from './cloudflare-destinations';
import { deliveryMode } from './config';
import { activateStoredRoute } from './routes';
import type { Env, StoredRouteRecord } from './types';

export async function refreshVerifiedRoute(
  env: Env,
  record: StoredRouteRecord,
): Promise<StoredRouteRecord> {
  if (
    record.status === 'active' ||
    deliveryMode(env) !== 'verified' ||
    !record.destinationId
  ) {
    return record;
  }
  const destination = await destinationAddressStatus(
    record.destinationId,
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_API_TOKEN,
  );
  if (destination.status !== 'verified') return record;
  return (await activateStoredRoute(env, record.formId)) ?? record;
}
