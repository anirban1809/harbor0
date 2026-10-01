import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, LiveUpdates, LIVE_PING_MS, type LiveMessage } from '../src/index';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop() {
    this.onclose?.({});
  }
}
let messages: LiveMessage[];
let states: boolean[];
let tickets: number;
let failTicket: Error | undefined;
const live = () =>
  new LiveUpdates({
    ticket: async () => {
      tickets++;
      if (failTicket) throw failTicket;
      return { url: 'wss://live.example.test/live', ticket: `t${tickets}` };
    },
    onMessage: (message) => messages.push(message),
    onConnected: (connected) => states.push(connected),
    socket: (url) => new FakeSocket(url) as never,
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  FakeSocket.all = [];
  messages = [];
  states = [];
  tickets = 0;
  failTicket = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('connects with a fresh ticket, forwards hints, pings, and stops cleanly', async () => {
  const updates = live();
  updates.start();
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeSocket.all[0];
  expect(socket.url).toBe('wss://live.example.test/live?ticket=t1');
  socket.open();
  expect(states).toEqual([true]);
  socket.onmessage!({ data: JSON.stringify({ type: 'changes' }) });
  socket.onmessage!({ data: JSON.stringify({ type: 'notification' }) });
  socket.onmessage!({ data: 'not json' });
  socket.onmessage!({ data: JSON.stringify({ type: 'other' }) });
  expect(messages).toEqual([{ type: 'changes' }, { type: 'notification' }]);
  await vi.advanceTimersByTimeAsync(LIVE_PING_MS);
  expect(socket.sent).toEqual([JSON.stringify({ type: 'ping' })]);
  updates.stop();
  expect(socket.closed).toBe(true);
  expect(states).toEqual([true, false]);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(FakeSocket.all).toHaveLength(1);
});

it('reconnects with growing delays and resets them after a successful connection', async () => {
  const updates = live();
  updates.start();
  await vi.advanceTimersByTimeAsync(0);
  FakeSocket.all[0].drop();
  await vi.advanceTimersByTimeAsync(999);
  expect(FakeSocket.all).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeSocket.all).toHaveLength(2);
  FakeSocket.all[1].drop();
  await vi.advanceTimersByTimeAsync(1999);
  expect(FakeSocket.all).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeSocket.all).toHaveLength(3);
  FakeSocket.all[2].open();
  FakeSocket.all[2].drop();
  expect(states).toEqual([true, false]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(FakeSocket.all).toHaveLength(4);
  expect(tickets).toBe(4);
  updates.stop();
});

it('waits ten minutes before asking again when the server has no live updates', async () => {
  failTicket = new ApiError('REALTIME_UNAVAILABLE', 'Live updates are not available.', 503);
  const updates = live();
  updates.start();
  await vi.advanceTimersByTimeAsync(9 * 60_000);
  expect(tickets).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(tickets).toBe(2);
  expect(FakeSocket.all).toHaveLength(0);
  updates.stop();
});

it('treats a malformed ticket response as unavailable instead of throwing', async () => {
  const updates = new LiveUpdates({
    ticket: async () => {
      tickets++;
      return {} as never;
    },
    onMessage: (message) => messages.push(message),
    onConnected: (connected) => states.push(connected),
    socket: (url) => new FakeSocket(url) as never,
  });
  updates.start();
  await vi.advanceTimersByTimeAsync(9 * 60_000);
  expect(tickets).toBe(1);
  expect(FakeSocket.all).toHaveLength(0);
  expect(states).toEqual([]);
  updates.stop();
});
