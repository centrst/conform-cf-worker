import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  destinationAddressStatus,
  ensureDestinationAddress,
} from './cloudflare-destinations';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verified destination registration', () => {
  it('reuses an existing verified destination without creating another record', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        result: [
          {
            id: 'destination-id',
            email: 'owner@example.com',
            verified: '2026-07-23T00:00:00Z',
          },
        ],
        result_info: { total_pages: 1 },
      }),
    );

    const result = await ensureDestinationAddress(
      'Owner@example.com',
      'account',
      'token',
      fetchMock as typeof fetch,
    );
    expect(result).toEqual({ status: 'verified', addressId: 'destination-id' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates a missing destination and reports pending verification', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [],
          result_info: { total_pages: 1 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            id: 'destination-id',
            email: 'owner@example.com',
            verified: null,
          },
        }),
      );

    const result = await ensureDestinationAddress(
      'owner@example.com',
      'account',
      'token',
      fetchMock as typeof fetch,
    );
    expect(result).toEqual({ status: 'pending', addressId: 'destination-id' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ email: 'owner@example.com' }),
    });
  });

  it('refreshes a destination by its Cloudflare address id', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        result: {
          id: 'destination-id',
          email: 'owner@example.com',
          verified: '2026-07-23T00:00:00Z',
        },
      }),
    );

    const result = await destinationAddressStatus(
      'destination-id',
      'account',
      'token',
      fetchMock as typeof fetch,
    );

    expect(result).toEqual({ status: 'verified', addressId: 'destination-id' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account/email/routing/addresses/destination-id',
      {
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
      },
    );
  });
});
