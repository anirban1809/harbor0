import { ApiError, type ApiClient } from '@harbor/api-client';
import {
  ACTIVITY_BATCH,
  type ActivityAction,
  type ActivityEvent,
  type ActivityReason,
  type ActivityScope,
  type ActivityStatus,
} from '@harbor/contracts';
import type { Journal } from './journal';

/** What one subject is doing now: the engine, a sync folder or a backup folder. */
export type ActivitySubject = {
  scope: ActivityScope;
  /** A sync folder's cloud id or a backup's id; none for the engine. */
  folderId?: string;
  status: ActivityStatus;
  reason?: ActivityReason;
  files?: number;
  bytes?: number;
  failed?: number;
  runId?: string;
};
type Reported = { status: ActivityStatus; reason: ActivityReason | null };

/** Unsent events kept at most; the oldest go first. */
export const ACTIVITY_QUEUE_MAX = 500;
/** A sync folder counts as idle only after this long with nothing to do. */
export const SYNC_IDLE_MS = 30_000;
/** How soon after a change its events are sent. */
const SEND_DELAY_MS = 3_000;
const QUEUE = 'activity-queue';
const REPORTED = 'activity-reported';

const keyOf = (s: Pick<ActivitySubject, 'scope' | 'folderId'>) => `${s.scope}#${s.folderId ?? '-'}`;

/** What happened, going from the status last reported to the new one. */
function actionFor(previous: Reported | undefined, next: ActivitySubject): ActivityAction {
  if (next.status === 'PAUSED') return 'PAUSED';
  if (previous?.status === 'PAUSED') return 'RESUMED';
  if (next.status === 'BLOCKED') return 'BLOCKED';
  if (previous?.status === 'BLOCKED') return 'UNBLOCKED';
  if (next.status === 'ACTIVE') return 'STARTED';
  return previous ? 'FINISHED' : 'IDLE';
}

/**
 * Tells the server what the sync and backup engine is doing (docs/specs/device-activity.md).
 * The engine describes every subject after each change; an event is queued only when one's
 * status or reason differs from what was last reported, and queued events go in batches,
 * surviving restarts and time offline.
 */
export class ActivityReporter {
  private reported: Record<string, Reported>;
  private queue: ActivityEvent[];
  /** When each sync folder last had work, so a short pause between edits isn't "finished". */
  private busyAt = new Map<string, number>();
  /** Files a sync folder moved since it started, which the engine's own count forgets. */
  private moved = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | undefined;
  /** An older server without the route: stop until the app restarts. */
  private unsupported = false;
  /** The engine stopped: its journal may be closed, so nothing more is read or written. */
  private stopped = false;

  constructor(
    private api: ApiClient,
    private journal: Journal,
    private now: () => number = Date.now,
  ) {
    this.reported = journal.get<Record<string, Reported>>(REPORTED) ?? {};
    this.queue = journal.get<ActivityEvent[]>(QUEUE) ?? [];
  }

  /** A sync folder finished moving one file. */
  fileMoved(folderId: string) {
    this.moved.set(folderId, (this.moved.get(folderId) ?? 0) + 1);
  }

  /** Compares every subject with what was last reported and queues an event for each change. */
  observe(subjects: ActivitySubject[]) {
    if (this.unsupported || this.stopped) return;
    const now = this.now();
    const seen = new Set<string>();
    let queued = false;
    for (const subject of subjects) {
      const key = keyOf(subject);
      seen.add(key);
      const previous = this.reported[key];
      let next = subject;
      if (subject.scope === 'SYNC') {
        if (subject.status === 'ACTIVE') this.busyAt.set(key, now);
        // Idle only once it has had nothing to do for a while.
        else if (
          subject.status === 'IDLE' &&
          previous?.status === 'ACTIVE' &&
          now - (this.busyAt.get(key) ?? 0) < SYNC_IDLE_MS
        )
          continue;
      }
      const reason = next.reason ?? null;
      if (previous && previous.status === next.status && previous.reason === reason) continue;
      const action = actionFor(previous, next);
      if (subject.scope === 'SYNC') {
        if (action === 'STARTED') this.moved.set(subject.folderId!, 0);
        if (action === 'FINISHED')
          next = { ...next, files: this.moved.get(subject.folderId!) ?? 0 };
      }
      this.queue.push({
        id: crypto.randomUUID(),
        at: new Date(now).toISOString(),
        scope: next.scope,
        ...(next.folderId !== undefined ? { folderId: next.folderId } : {}),
        action,
        status: next.status,
        ...(next.reason ? { reason: next.reason } : {}),
        ...(next.files !== undefined ? { files: next.files } : {}),
        ...(next.bytes !== undefined ? { bytes: next.bytes } : {}),
        ...(next.failed !== undefined ? { failed: next.failed } : {}),
        ...(next.runId !== undefined ? { runId: next.runId } : {}),
      });
      this.reported[key] = { status: next.status, reason };
      queued = true;
    }
    // A folder no longer set up is forgotten, so setting it up again reports it afresh.
    let forgot = false;
    for (const key of Object.keys(this.reported))
      if (!seen.has(key)) {
        delete this.reported[key];
        this.busyAt.delete(key);
        forgot = true;
      }
    if (!queued && !forgot) return;
    if (this.queue.length > ACTIVITY_QUEUE_MAX)
      this.queue.splice(0, this.queue.length - ACTIVITY_QUEUE_MAX);
    this.save();
    if (queued) this.soon();
  }

  /** Sends what is queued; what fails waits for the next try. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // A report that can't be sent waits for the next try; it never fails the caller.
    this.sending ??= this.send()
      .catch(() => {})
      .finally(() => {
        this.sending = undefined;
      });
    return this.sending;
  }

  /** The engine started again (after a settings change, say): report and send as before. */
  start() {
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async send() {
    while (this.queue.length && !this.unsupported && !this.stopped) {
      const batch = this.queue.slice(0, ACTIVITY_BATCH);
      try {
        await this.api.request('/v1/activity', { method: 'POST', body: { events: batch } });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          this.unsupported = true;
          this.queue = [];
          this.save();
        }
        // Refused for its content: dropped rather than sent again forever.
        else if (error instanceof ApiError && error.status === 400) {
          this.queue.splice(0, batch.length);
          this.save();
          continue;
        }
        return;
      }
      this.queue.splice(0, batch.length);
      this.save();
    }
  }

  private soon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, SEND_DELAY_MS);
    this.timer.unref?.();
  }

  private save() {
    if (this.stopped) return;
    this.journal.transaction(() => {
      this.journal.set(QUEUE, this.queue);
      this.journal.set(REPORTED, this.reported);
    });
  }
}
