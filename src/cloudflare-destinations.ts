import { normalizeEmail } from './crypto';

interface CloudflareAddress {
  id?: string;
  email?: string;
  verified?: string | null;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: { total_pages?: number };
}

export interface DestinationStatus {
  status: 'pending' | 'verified';
  addressId?: string;
}

export class DestinationCapacityError extends Error {
  constructor() {
    super('Cloudflare destination-address capacity has been reached');
  }
}

function apiHeaders(apiToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
}

function configuration(accountId?: string, apiToken?: string): [string, string] {
  if (!accountId || !apiToken) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required in verified delivery mode',
    );
  }
  return [accountId, apiToken];
}

export async function ensureDestinationAddress(
  email: string,
  accountId?: string,
  apiToken?: string,
  fetcher: typeof fetch = fetch,
): Promise<DestinationStatus> {
  const [account, token] = configuration(accountId, apiToken);
  const normalized = normalizeEmail(email);
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${account}/email/routing/addresses`;

  for (let page = 1; page <= 20; page += 1) {
    const listUrl = new URL(baseUrl);
    listUrl.searchParams.set('page', String(page));
    listUrl.searchParams.set('per_page', '50');
    const response = await fetcher(listUrl, { headers: apiHeaders(token) });
    const body = (await response.json()) as CloudflareApiResponse<CloudflareAddress[]>;
    if (!response.ok || !body.success || !Array.isArray(body.result)) {
      throw new Error('Cloudflare destination lookup failed');
    }

    const existing = body.result.find(
      (address) => address.email && normalizeEmail(address.email) === normalized,
    );
    if (existing) {
      return {
        status: existing.verified ? 'verified' : 'pending',
        addressId: existing.id,
      };
    }

    const totalPages = body.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
  }

  const response = await fetcher(baseUrl, {
    method: 'POST',
    headers: apiHeaders(token),
    body: JSON.stringify({ email: normalized }),
  });
  const body = (await response.json()) as CloudflareApiResponse<CloudflareAddress>;
  if (!response.ok || !body.success || !body.result) {
    const capacityReached = body.errors?.some((error) => {
      const message = error.message?.toLowerCase() ?? '';
      return message.includes('limit') || message.includes('maximum');
    });
    if (capacityReached) throw new DestinationCapacityError();
    throw new Error('Cloudflare destination registration failed');
  }

  return {
    status: body.result.verified ? 'verified' : 'pending',
    addressId: body.result.id,
  };
}

export async function destinationAddressStatus(
  addressId: string,
  accountId?: string,
  apiToken?: string,
  fetcher: typeof fetch = fetch,
): Promise<DestinationStatus> {
  const [account, token] = configuration(accountId, apiToken);
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${account}/email/routing/addresses/${encodeURIComponent(addressId)}`,
    { headers: apiHeaders(token) },
  );
  const body = (await response.json()) as CloudflareApiResponse<CloudflareAddress>;
  if (!response.ok || !body.success || !body.result) {
    throw new Error('Cloudflare destination status lookup failed');
  }
  return {
    status: body.result.verified ? 'verified' : 'pending',
    addressId: body.result.id ?? addressId,
  };
}
