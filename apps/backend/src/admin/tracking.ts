import type {
  AdminTracker,
  AdminTrackerDetail,
  AdminTrackerList,
  Staff,
} from '../../../../packages/contracts/src/admin';
import { assert } from '../errors';
import { transact, Transaction } from '../repository';
import { SIGNUP_TRACKING, TRACKER, type SignupTracking, type Tracker } from '../signup-tracking';
import type { AdminService } from './service';

type Counts = Pick<AdminTracker, 'requests' | 'signups' | 'accounts' | 'lastAt'>;
const latest = (row: SignupTracking) =>
  [row.at, row.requestedAt, row.signedUpAt, row.joinedAt].filter(Boolean).sort().at(-1)!;

/**
 * Sign-up tracking ids as staff manage them: each id is named with the source its links were
 * shared in, and counted through the sign-up steps. Every change is audited.
 */
export class AdminTracking {
  constructor(
    private admin: AdminService,
    /** The customer web app, whose sign-up page tracking links point at. */
    private webOrigin: string,
  ) {}
  private get signupUrl() {
    return `${this.webOrigin}/signup`;
  }
  private rows() {
    return new Transaction(this.admin.repo).list<SignupTracking>(SIGNUP_TRACKING, '');
  }
  private view(id: string, tracker: Tracker | undefined, rows: SignupTracking[]): AdminTracker {
    const counts: Counts = {
      requests: rows.filter((r) => r.requestedAt).length,
      signups: rows.filter((r) => r.signedUpAt).length,
      accounts: rows.filter((r) => r.userId).length,
      lastAt: rows.map(latest).sort().at(-1) ?? null,
    };
    return {
      id,
      source: tracker?.source ?? null,
      notes: tracker?.notes ?? '',
      createdAt: tracker?.createdAt ?? null,
      updatedAt: tracker?.updatedAt ?? null,
      updatedBy: tracker?.updatedBy ?? null,
      ...counts,
    };
  }
  /** Named tracking ids and ones sign-ups used without a name, most recently used first. */
  async list(): Promise<AdminTrackerList> {
    const [trackers, rows] = await Promise.all([
      new Transaction(this.admin.repo).list<Tracker>(TRACKER, ''),
      this.rows(),
    ]);
    const byId = new Map<string, SignupTracking[]>();
    for (const row of rows) byId.set(row.trackingId, [...(byId.get(row.trackingId) ?? []), row]);
    const named = new Map(trackers.map((t) => [t.id, t]));
    const ids = new Set([...named.keys(), ...byId.keys()]);
    const items = [...ids].map((id) => this.view(id, named.get(id), byId.get(id) ?? []));
    items.sort(
      (a, b) =>
        (b.lastAt ?? b.createdAt ?? '').localeCompare(a.lastAt ?? a.createdAt ?? '') ||
        a.id.localeCompare(b.id),
    );
    return { items, signupUrl: this.signupUrl };
  }
  async detail(id: string): Promise<AdminTrackerDetail> {
    const [tracker, rows] = await Promise.all([
      new Transaction(this.admin.repo).get<Tracker>(TRACKER, id),
      this.rows().then((all) => all.filter((r) => r.trackingId === id)),
    ]);
    return {
      tracker: this.view(id, tracker, rows),
      signupUrl: this.signupUrl,
      people: rows
        .sort((a, b) => latest(b).localeCompare(latest(a)))
        .map((r) => ({
          email: r.email,
          userId: r.userId ?? null,
          at: r.at,
          requestedAt: r.requestedAt ?? null,
          signedUpAt: r.signedUpAt ?? null,
          joinedAt: r.joinedAt ?? null,
        })),
    };
  }
  /** The source staff named the tracking id with, for the user page. */
  async source(id: string) {
    const tracker = await new Transaction(this.admin.repo).get<Tracker>(TRACKER, id);
    return tracker?.source ?? null;
  }
  async save(
    staff: Staff,
    id: string,
    input: { source: string; notes: string; expectedUpdatedAt: string | null },
  ) {
    await transact(this.admin.repo, async (tx) => {
      const before = await tx.get<Tracker>(TRACKER, id);
      assert(
        (before?.updatedAt ?? null) === input.expectedUpdatedAt,
        'TRACKER_CHANGED',
        before
          ? `${before.updatedBy} changed this tracking link since you opened it. Reload to see their change.`
          : 'This tracking link was removed since you opened it. Reload to see the change.',
        409,
      );
      const at = new Date().toISOString();
      const tracker: Tracker = {
        id,
        source: input.source,
        notes: input.notes,
        createdAt: before?.createdAt ?? at,
        updatedAt: at,
        updatedBy: staff.email,
      };
      await tx.put(TRACKER, id, tracker);
      await this.admin.audit(tx, staff, {
        action: before ? 'TRACKER_CHANGED' : 'TRACKER_CREATED',
        details: {
          id,
          source: input.source,
          ...(before && before.source !== input.source ? { previousSource: before.source } : {}),
        },
      });
    });
    return this.detail(id);
  }
  /** Forgets the name; sign-ups that came through the id keep it and show as unnamed. */
  async remove(staff: Staff, id: string) {
    return transact(this.admin.repo, async (tx) => {
      const before = await tx.get<Tracker>(TRACKER, id);
      if (!before) return { deleted: false };
      await tx.delete(TRACKER, id);
      await this.admin.audit(tx, staff, {
        action: 'TRACKER_DELETED',
        details: { id, source: before.source },
      });
      return { deleted: true };
    });
  }
}
