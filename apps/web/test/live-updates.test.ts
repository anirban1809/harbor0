import { afterEach, expect, it, vi } from 'vitest';
import { LIVE_COALESCE_MS, onLive, publishLive } from '../lib/live-updates';

afterEach(() => vi.useRealTimers());

it('delivers a burst of pushed changes as one refresh now and one after the window', () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  const seen: string[] = [];
  const off = onLive((message) => seen.push(message.type));
  for (let i = 0; i < 20; i++) publishLive({ type: 'changes' });
  publishLive({ type: 'notification' });
  expect(seen).toEqual(['changes', 'notification']);
  vi.advanceTimersByTime(LIVE_COALESCE_MS);
  expect(seen).toEqual(['changes', 'notification', 'changes']);
  vi.advanceTimersByTime(LIVE_COALESCE_MS * 2);
  expect(seen).toHaveLength(3);
  publishLive({ type: 'changes' });
  expect(seen).toHaveLength(4);
  off();
  vi.unstubAllGlobals();
});
