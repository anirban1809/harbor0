// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  connectAccountAppearance,
  useAppearance,
  setAppearancePreset,
  setAppearanceColor,
  setAppearanceMode,
  retryAppearance,
} from '../lib/appearance';
import type { AppearancePreference } from '@harbor/contracts';

const ocean: AppearancePreference = {
  preference: 'dark',
  preset: 'ocean',
  palettes: { light: {}, dark: {} },
};
let disconnect: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
});
afterEach(() => {
  act(() => disconnect?.());
  disconnect = undefined;
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('account appearance sync', () => {
  it('loads account settings over device preferences and saves mode, preset and custom colors together', async () => {
    localStorage.setItem('harbor-theme', 'light');
    const request = vi.fn().mockResolvedValue({ user: { appearance: ocean } });
    const { result } = renderHook(useAppearance);
    act(() => {
      disconnect = connectAccountAppearance(request);
    });
    await settle();
    expect(result.current).toMatchObject({ mode: 'dark', preset: 'ocean', status: 'saved' });
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#60a5fa');
    act(() => {
      setAppearancePreset('forest');
      setAppearanceMode('light');
      setAppearanceColor('primary', '#aabbcc');
    });
    expect(result.current.status).toBe('saving');
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(request).toHaveBeenLastCalledWith(
      '/v1/users/me',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.objectContaining({
          appearance: {
            preset: 'forest',
            preference: 'light',
            palettes: { light: { primary: '#aabbcc' }, dark: {} },
          },
        }),
      }),
    );
    expect(result.current.status).toBe('saved');
  });
  it('serializes rapid changes while a save is in flight', async () => {
    let finish!: () => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ user: {} })
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({});
    const { result } = renderHook(useAppearance);
    act(() => {
      disconnect = connectAccountAppearance(request);
    });
    await settle();
    act(() => setAppearancePreset('ocean'));
    await act(() => vi.advanceTimersByTimeAsync(300));
    act(() => setAppearancePreset('sunset'));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => finish());
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][1].body.appearance.preset).toBe('sunset');
    expect(result.current).toMatchObject({ preset: 'sunset', status: 'saved' });
  });
  it('keeps failed changes visible and retries without needing device storage', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ user: {} })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({});
    const { result } = renderHook(useAppearance);
    act(() => {
      disconnect = connectAccountAppearance(request);
    });
    await settle();
    act(() => setAppearancePreset('violet'));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(result.current).toMatchObject({ preset: 'violet', status: 'error' });
    act(() => retryAppearance());
    await settle();
    expect(result.current.status).toBe('saved');
  });
  it('does not allow failed or delayed loads to overwrite user choices', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ user: { appearance: ocean } });
    const { result } = renderHook(useAppearance);
    act(() => {
      disconnect = connectAccountAppearance(request);
    });
    await settle();
    expect(result.current).toMatchObject({ ready: false, status: 'error' });
    act(() => setAppearancePreset('forest'));
    expect(request).toHaveBeenCalledTimes(1);
    act(() => retryAppearance());
    await settle();
    expect(result.current).toMatchObject({ ready: true, preset: 'ocean' });
  });
  it('ignores the previous account’s late responses and cancels pending writes on sign out', async () => {
    let finish!: (value: unknown) => void;
    const oldRequest = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(useAppearance);
    act(() => {
      disconnect = connectAccountAppearance(oldRequest);
    });
    act(() => disconnect?.());
    const newRequest = vi.fn().mockResolvedValue({ user: {} });
    act(() => {
      disconnect = connectAccountAppearance(newRequest);
    });
    await settle();
    await act(async () => finish({ user: { appearance: ocean } }));
    expect(result.current.preset).toBe('default');
    act(() => {
      setAppearancePreset('forest');
      disconnect?.();
    });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(newRequest).toHaveBeenCalledTimes(1);
    expect(result.current.preset).toBe('default');
  });
});
