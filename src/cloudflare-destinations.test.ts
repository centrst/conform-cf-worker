import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureDestinationAddress } from './cloudflare-destinations';

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
});
