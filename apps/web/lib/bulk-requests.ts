import { ApiError } from '@harbor/api-client';

// A bulk action fired every request at once, so selecting 20 files and moving them to trash
// spent 20 Lambda executions in the same instant and most were throttled.
export const BULK_CONCURRENCY = 4;
const RETRY_DELAYS_MS = [500, 1500, 4000];

const transient = (error: unknown) =>
  error instanceof ApiError &&
  (error.code === 'BACKEND_UNAVAILABLE' || error.code === 'RATE_LIMITED' || error.status >= 500);

/** Retries a request that failed for a reason unrelated to the request itself. Only for calls
 * that are safe to repeat: a mutation needs a baseRevision (a repeat then conflicts rather than
 * applying twice) or the same operationId on every attempt. */
export async function retryTransient<T>(
  call: () => Promise<T>,
  wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length || !transient(error)) throw error;
      await wait(RETRY_DELAYS_MS[attempt] * (0.75 + Math.random() / 2));
    }
  }
}

/** Promise.allSettled, but with at most `limit` calls in flight. */
export async function settleBounded<T, R>(
  items: T[],
  run: (item: T) => Promise<R>,
  limit = BULK_CONCURRENCY,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await run(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
