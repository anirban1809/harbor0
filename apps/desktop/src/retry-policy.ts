import type { Stats } from 'node:fs';
import type { LocalJob } from './journal';

/**
 * How a file that keeps failing is retried. Each failure waits twice as long as the one before,
 * up to a limit, and after enough failures harbor0 stops trying by itself: the file waits, with
 * its error shown, until it changes or the person asks again (Back up now, or Resume). Without
 * this, a file harbor0 can never take was tried every minute for as long as the app ran.
 */
export const GIVE_UP_AFTER = { backup: 8, sync: 12 } as const;
/** Set as a given-up job's attempts, so counts of work waiting can leave it out cheaply. */
export const GAVE_UP_ATTEMPTS = 1000;

/** The wait after the `attempts`-th failure: `first`, doubling each time, at most `max`. */
export function retryDelay(attempts: number, first: number, max: number) {
  return Math.min(max, first * 2 ** Math.max(0, Math.min(attempts, 30) - 1));
}

/** What a given-up file looked like, so a change to it brings it back. */
export type GaveUp = { at: number; size: number | null; mtimeMs: number | null };

export const gaveUp = (job: LocalJob) => job.attempts >= GAVE_UP_ATTEMPTS;

/** Stops retrying `job` until its file changes or the person asks; `info` is the file now. */
export function giveUp(job: LocalJob, info: Stats | null | undefined) {
  job.attempts = GAVE_UP_ATTEMPTS;
  job.payload.gaveUp = {
    at: Date.now(),
    size: info?.size ?? null,
    mtimeMs: info?.mtimeMs ?? null,
  } satisfies GaveUp;
  delete job.payload.retryAt;
  delete job.payload.retryAfter;
}

/** Tries it again from the start: its file changed, or the person asked. */
export function revive(job: LocalJob) {
  job.attempts = 0;
  delete job.payload.gaveUp;
  delete job.payload.retryAt;
  delete job.payload.retryAfter;
}

/** Whether a given-up file is as it was when harbor0 stopped trying it (`info` is it now). */
export function unchangedSinceGivingUp(job: LocalJob, info: Stats | null | undefined) {
  const was = job.payload.gaveUp as GaveUp | undefined;
  if (!was) return false;
  return (info?.size ?? null) === was.size && (info?.mtimeMs ?? null) === was.mtimeMs;
}

/** The error shown for a file harbor0 stopped retrying. */
export const gaveUpMessage = (message: string, mode: 'sync' | 'backup') =>
  `${message} harbor0 stopped retrying after several tries and will try again when the file changes${mode === 'backup' ? ' or you back up now' : ' or you resume syncing'}.`;
