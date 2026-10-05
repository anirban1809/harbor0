import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Transport } from '@harbor/api-client';
import { guardTransport, renewSession } from '../lib/session-guard';

const expired = () => new ApiError('AUTH_INVALID', 'Your session expired.', 401);

describe('session guard', () => {
  it('renews once and retries a request whose access token lapsed', async () => {
    const transport = vi
      .fn<Transport>()
      .mockRejectedValueOnce(expired())
      .mockResolvedValueOnce({ ok: true });
    const renew = vi.fn(async () => {});
    expect(await guardTransport(transport, renew)('/v1/users/me')).toEqual({ ok: true });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('leaves wrong-password answers from sign-in forms alone', async () => {
    const transport = vi.fn<Transport>().mockRejectedValue(expired());
    const renew = vi.fn(async () => {});
    await expect(guardTransport(transport, renew)('/v1/auth/login')).rejects.toThrow(ApiError);
    expect(renew).not.toHaveBeenCalled();
  });

  it('passes a failed renewal through instead of retrying', async () => {
    const transport = vi.fn<Transport>().mockRejectedValue(expired());
    const outage = new ApiError('BACKEND_UNAVAILABLE', 'Unavailable.', 503);
    const renew = vi.fn(async () => {
      throw outage;
    });
    await expect(guardTransport(transport, renew)('/v1/backups')).rejects.toBe(outage);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('shares one renewal between concurrent requests', async () => {
    let finish!: () => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(Response.json({ renewed: true }));
        }),
    );
    const first = renewSession(fetcher as typeof fetch);
    const second = renewSession(fetcher as typeof fetch);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    finish();
    await first;
    // A later renewal starts afresh.
    void renewSession(fetcher as typeof fetch);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    finish();
  });

  it('reports an ended sign-in as 401 and an outage as 503', async () => {
    const answer = (status: number) => async () =>
      Response.json({ error: { message: 'No.' } }, { status });
    await expect(renewSession(answer(401) as typeof fetch)).rejects.toMatchObject({ status: 401 });
    await expect(renewSession(answer(429) as typeof fetch)).rejects.toMatchObject({ status: 503 });
  });
});
