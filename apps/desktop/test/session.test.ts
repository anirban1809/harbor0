import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, SESSION_DURATION_SECONDS } from '@harbor/api-client';
import { DesktopSession } from '../src/session';

const tokens = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 900 };
function fixture() {
  const options = {
    renew: vi.fn(async (_token: string) => ({ ...tokens, accessToken: 'renewed' })),
    persist: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    signedOut: vi.fn(),
  };
  return { session: new DesktopSession(options), ...options };
}
afterEach(() => vi.useRealTimers());

describe('desktop sessions', () => {
  it('persists a 30-day refresh session and restores it after restart', async () => {
    const f = fixture();
    vi.useFakeTimers();
    const start = Date.now();
    await f.session.signIn(tokens);
    expect(f.persist).toHaveBeenCalledWith({
      refreshToken: 'refresh',
      expiresAt: start + SESSION_DURATION_SECONDS * 1000,
    });
    const restarted = fixture();
    vi.setSystemTime(start + 29 * 86400_000);
    await restarted.session.restore({
      refreshToken: 'refresh',
      expiresAt: start + SESSION_DURATION_SECONDS * 1000,
    });
    expect(await restarted.session.token()).toBe('renewed');
    expect(restarted.session.signedIn).toBe(true);
    expect(restarted.persist).toHaveBeenCalledWith({
      refreshToken: 'refresh',
      expiresAt: start + SESSION_DURATION_SECONDS * 1000,
    });
  });

  it('rejects missing and expired credentials without contacting the server', async () => {
    const f = fixture();
    await expect(f.session.token()).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await expect(
      f.session.restore({ refreshToken: 'old', expiresAt: Date.now() - 1 }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    expect(f.renew).not.toHaveBeenCalled();
    expect(f.session.signedIn).toBe(false);
    expect(f.signedOut).toHaveBeenCalled();
    expect(f.clear).toHaveBeenCalled();
  });

  it('renews short-lived access tokens once for concurrent callers', async () => {
    const f = fixture();
    vi.useFakeTimers();
    await f.session.signIn(tokens);
    vi.setSystemTime(Date.now() + 900_000);
    expect(await Promise.all([f.session.token(), f.session.token()])).toEqual([
      'renewed',
      'renewed',
    ]);
    expect(f.renew).toHaveBeenCalledTimes(1);
  });

  it('returns to login at the 30-day boundary, even with an access token', async () => {
    const f = fixture();
    vi.useFakeTimers();
    await f.session.signIn(tokens);
    vi.setSystemTime(Date.now() + SESSION_DURATION_SECONDS * 1000);
    await expect(f.session.token()).rejects.toMatchObject({ status: 401 });
    expect(f.session.signedIn).toBe(false);
    expect(f.signedOut).toHaveBeenCalledTimes(1);
    expect(f.clear).toHaveBeenCalledTimes(1);
  });

  it.each([
    new ApiError('AUTH_INVALID', 'Expired', 401),
    new ApiError('DEVICE_REVOKED', 'Revoked', 403),
  ])('clears rejected sessions and notifies the renderer', async (error) => {
    const f = fixture();
    await f.session.signIn(tokens);
    f.renew.mockRejectedValue(error);
    await expect(f.session.refresh()).rejects.toBe(error);
    expect(f.session.signedIn).toBe(false);
    expect(f.session.refreshToken).toBe('');
    expect(f.clear).toHaveBeenCalledTimes(1);
    expect(f.signedOut).toHaveBeenCalledTimes(1);
  });

  it.each([new TypeError('Offline'), new ApiError('UNAVAILABLE', 'Try later', 503)])(
    'preserves credentials during temporary connection failures',
    async (error) => {
      const f = fixture();
      await f.session.signIn(tokens);
      f.renew.mockRejectedValueOnce(error);
      await expect(f.session.refresh()).rejects.toBe(error);
      expect(f.clear).not.toHaveBeenCalled();
      expect(f.signedOut).not.toHaveBeenCalled();
      await f.session.refresh();
      expect(await f.session.token()).toBe('renewed');
    },
  );

  it('does not restore a session when an in-flight refresh completes after logout', async () => {
    const f = fixture();
    await f.session.signIn(tokens);
    let resolve!: (value: typeof tokens) => void;
    f.renew.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const refreshing = f.session.refresh();
    await f.session.invalidate();
    resolve(tokens);
    await expect(refreshing).rejects.toMatchObject({ status: 401 });
    expect(f.session.signedIn).toBe(false);
    expect(f.persist).toHaveBeenCalledTimes(1);
  });
});
