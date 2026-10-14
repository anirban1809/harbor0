import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transport } from '@harbor/api-client';

// The server refuses more than 600 requests a minute per account. This computer stays below
// that with room to spare, and keeps a share for what the person is doing in the window so a
// large backup or sync never makes the app itself fail with "Too many requests".
export const REQUEST_LIMIT = 560;
export const FOREGROUND_RESERVE = 80;
const WINDOW_MS = 60_000;

/** Set while a request is made for the window (listing a folder, reading the account). */
export const foreground = new AsyncLocalStorage<boolean>();

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    const aborted = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/**
 * Requests sent in the last minute. Background work may use all but the reserve; requests for
 * the window may use it all. A request over its share waits for the oldest to age out instead
 * of being refused by the server. Counting over any 60 seconds keeps every calendar minute,
 * which is what the server counts, under the limit too.
 */
export class RequestBudget {
  private sent: number[] = [];
  constructor(
    private limit = REQUEST_LIMIT,
    private reserve = FOREGROUND_RESERVE,
    private now = () => Date.now(),
    private sleep = wait,
  ) {}
  async take(inForeground: boolean, signal?: AbortSignal) {
    for (;;) {
      const now = this.now();
      while (this.sent.length && this.sent[0] <= now - WINDOW_MS) this.sent.shift();
      const share = inForeground ? this.limit : this.limit - this.reserve;
      if (this.sent.length < share) {
        this.sent.push(now);
        return;
      }
      // The request that has to age out before this one fits.
      const oldest = this.sent[this.sent.length - share];
      await this.sleep(Math.max(10, oldest + WINDOW_MS - now), signal);
    }
  }
}

/** Sends each request once the budget has room for it; see RequestBudget. */
export function budgeted(transport: Transport, budget: RequestBudget): Transport {
  return async (endpoint, init) => {
    await budget.take(foreground.getStore() === true, init?.signal);
    return transport(endpoint, init);
  };
}
