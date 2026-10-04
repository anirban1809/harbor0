import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@harbor/api-client';
import { backoffDelay, retrying } from '../src/retry';
import { RenewalError } from '../src/session';

const instant = () => 0;
function failing(...errors: unknown[]) {
  const transport = vi.fn(async () => {
    const error = errors.shift();
    if (error) throw error;
    return { ok: true };
  });
  return transport;
}

describe('desktop request retries', () => {
  it('backs off exponentially up to a cap', () => {
    expect([0, 1, 2, 3, 6].map((n) => backoffDelay(n, () => 1))).toEqual([
      500, 1000, 2000, 4000, 8000,
    ]);
    expect(backoffDelay(2, () => 0)).toBe(1000);
  });

  it('retries reads through throttling, server errors and dropped connections', async () => {
    const transport = failing(
      new ApiError('RATE_LIMITED', 'Too many requests.', 429),
      new ApiError('INTERNAL_ERROR', 'Failed.', 500),
      new TypeError('fetch failed'),
    );
    await expect(retrying(transport, instant)('/v1/users/me')).resolves.toEqual({ ok: true });
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('gives up after four retries', async () => {
    const errors = Array.from({ length: 6 }, () => new ApiError('X', 'Failed.', 503));
    const transport = failing(...errors);
    await expect(retrying(transport, instant)('/v1/users/me')).rejects.toBeInstanceOf(ApiError);
    expect(transport).toHaveBeenCalledTimes(5);
  });

  it('repeats a write only when it was refused up front or carries an operation ID', async () => {
    const plain = failing(new ApiError('INTERNAL_ERROR', 'Failed.', 500));
    await expect(
      retrying(plain, instant)('/v1/uploads', { method: 'POST', body: {} }),
    ).rejects.toMatchObject({ status: 500 });
    expect(plain).toHaveBeenCalledTimes(1);

    const throttled = failing(new ApiError('RATE_LIMITED', 'Slow down.', 429));
    await retrying(throttled, instant)('/v1/uploads', { method: 'POST', body: {} });
    expect(throttled).toHaveBeenCalledTimes(2);

    const idempotent = failing(new ApiError('CONCURRENT_UPDATE', 'Busy.', 409));
    await retrying(idempotent, instant)('/v1/drive/folders', {
      method: 'POST',
      body: { operationId: 'op' },
    });
    expect(idempotent).toHaveBeenCalledTimes(2);
  });

  it('never retries client errors, failed session renewals, or cancelled requests', async () => {
    for (const error of [
      new ApiError('NOT_FOUND', 'Missing.', 404),
      new ApiError('AUTH_INVALID', 'Sign in.', 401),
      new RenewalError('RATE_LIMITED', 'Too many requests.', 429),
    ]) {
      const transport = failing(error);
      await expect(retrying(transport, instant)('/v1/users/me')).rejects.toBe(error);
      expect(transport).toHaveBeenCalledTimes(1);
    }
    const controller = new AbortController();
    controller.abort();
    const transport = failing(new TypeError('fetch failed'));
    await expect(
      retrying(transport, instant)('/v1/users/me', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('times out a hung attempt and retries it only when repeating is safe', async () => {
    const hung = vi.fn(
      (_path: string, init?: { signal?: AbortSignal }) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    );
    await expect(retrying(hung, instant, 5)('/v1/users/me')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(hung).toHaveBeenCalledTimes(5);
    hung.mockClear();
    await expect(
      retrying(hung, instant, 5)('/v1/uploads', { method: 'POST', body: {} }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(hung).toHaveBeenCalledTimes(1);
  });
});
