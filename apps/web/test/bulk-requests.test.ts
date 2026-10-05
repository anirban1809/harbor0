import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@harbor/api-client';
import { retryTransient, settleBounded } from '../lib/bulk-requests';

const unavailable = () => new ApiError('BACKEND_UNAVAILABLE', 'harbor0 is unavailable.', 503);
const wait = async () => {};

describe('bulk requests', () => {
  it('retries a throttled request until it succeeds', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce('done');
    expect(await retryTransient(call, wait)).toBe('done');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('does not retry a request the server rejected', async () => {
    const conflict = new ApiError('REVISION_CONFLICT', 'Changed elsewhere.', 409);
    const call = vi.fn().mockRejectedValue(conflict);
    await expect(retryTransient(call, wait)).rejects.toBe(conflict);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('gives up after a bounded number of attempts', async () => {
    const call = vi.fn().mockRejectedValue(unavailable());
    await expect(retryTransient(call, wait)).rejects.toThrow('unavailable');
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('keeps at most the limit in flight and reports results in order', async () => {
    let active = 0;
    let peak = 0;
    const results = await settleBounded(
      Array.from({ length: 20 }, (_, index) => index),
      async (index) => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        if (index === 7) throw new Error('seven');
        return index * 2;
      },
      4,
    );
    expect(peak).toBe(4);
    expect(results[3]).toEqual({ status: 'fulfilled', value: 6 });
    expect(results[7]).toMatchObject({ status: 'rejected' });
    expect(results).toHaveLength(20);
  });
});
