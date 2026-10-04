import { ApiError, type Transport } from '@harbor/api-client';
import { RenewalError } from './session';

const RETRIES = 4;
const BASE_MS = 500;
const MAX_MS = 8_000;
// No API request may hang: a stuck connection fails this attempt instead of blocking sync.
export const ATTEMPT_TIMEOUT_MS = 60_000;

/** Exponential backoff with jitter: half the step is fixed, half is random. */
export function backoffDelay(retry: number, random = Math.random) {
  const step = Math.min(MAX_MS, BASE_MS * 2 ** retry);
  return step / 2 + random() * (step / 2);
}

// A request is safe to repeat when it reads, or when its operation ID makes the server
// return the first result instead of applying it twice.
function repeatable(init: Parameters<Transport>[1]) {
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body as { operationId?: unknown } | undefined;
  return method === 'GET' || typeof body?.operationId === 'string';
}

export function shouldRetry(error: unknown, init: Parameters<Transport>[1]) {
  if (init?.signal?.aborted) return false;
  // Renewing the session has its own rate limit; repeating it only spends that budget.
  if (error instanceof RenewalError) return false;
  if (error instanceof ApiError) {
    // Refused before the handler ran, so even a non-repeatable request did nothing.
    if (error.status === 429 || error.status === 503) return true;
    return repeatable(init) && (error.status >= 500 || error.code === 'CONCURRENT_UPDATE');
  }
  // Network failures (TypeError), non-JSON gateway bodies (SyntaxError) and attempts that
  // ran out of time (the caller's own signal was checked above).
  return (
    repeatable(init) &&
    (error instanceof TypeError ||
      error instanceof SyntaxError ||
      (error as Error | undefined)?.name === 'TimeoutError')
  );
}

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

/** Retries transient failures (throttling, server errors, dropped connections). */
export function retrying(
  transport: Transport,
  delay = backoffDelay,
  timeout = ATTEMPT_TIMEOUT_MS,
): Transport {
  return async (endpoint, init) => {
    for (let retry = 0; ; retry++) {
      const limit = AbortSignal.timeout(timeout);
      try {
        return await transport(endpoint, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit,
        });
      } catch (error) {
        if (retry >= RETRIES || !shouldRetry(error, init)) throw error;
        await wait(delay(retry), init?.signal);
      }
    }
  };
}
