import { featureFlags, isFlagKey, type FlagKey, type FlagRule } from '@harbor/contracts';
import type {
  AdminFlag,
  AdminFlagBody,
  AdminFlagDetail,
  AdminFlagList,
  AuditEntry,
  Staff,
} from '../../../../packages/contracts/src/admin';
import { assert } from '../errors';
import {
  decide,
  emptyFlag,
  FeatureFlags,
  featureFlagsFor,
  FLAG_PK,
  isOn,
  type StoredFlag,
} from '../flags';
import { transact, type Transaction } from '../repository';
import type { AdminService } from './service';

const history = (key: string) => `ADMIN_AUDIT#FLAG#${key}`;
const summary = (flag: FlagRule) => ({
  mode: flag.mode,
  percent: flag.percent,
  users: flag.userIds.length,
  minVersions: flag.minVersions,
});

/** Feature flag rules as staff manage them. Every change is audited, globally and per flag. */
export class AdminFlags {
  // Staff always see the stored rules, never a cached copy.
  private fresh: FeatureFlags;
  constructor(private admin: AdminService) {
    this.fresh = new FeatureFlags(admin.repo, 0);
  }
  private key(key: string): FlagKey {
    assert(isFlagKey(key), 'FLAG_NOT_FOUND', 'No feature flag has this name.', 404);
    return key;
  }
  private view(flag: StoredFlag): AdminFlag {
    return {
      key: flag.key,
      description: featureFlags[flag.key].description,
      mode: flag.mode,
      userIds: flag.userIds,
      percent: flag.percent,
      minVersions: flag.minVersions,
      users: flag.userIds.map((id) => ({ id, email: flag.userEmails[id] ?? null })),
      updatedAt: flag.updatedAt,
      updatedBy: flag.updatedBy,
    };
  }
  private accounts() {
    return this.admin
      .storageTotals()
      .then((t) => t.accounts)
      .catch(() => null);
  }
  async list(): Promise<AdminFlagList> {
    const [flags, accounts] = await Promise.all([this.fresh.all(), this.accounts()]);
    return { items: [...flags.values()].map((f) => this.view(f)), accounts };
  }
  async detail(name: string): Promise<AdminFlagDetail> {
    const key = this.key(name);
    const [flags, accounts, log] = await Promise.all([
      this.fresh.all(),
      this.accounts(),
      this.admin.repo.query(history(key), '', 30),
    ]);
    return {
      flag: this.view(flags.get(key)!),
      accounts,
      history: log.rows.map((r) => r.data as AuditEntry),
    };
  }
  /** Each flag for one account, as the console shows it on the account's page. */
  async forUser(userId: string) {
    const flags = await this.fresh.all();
    return [...flags.values()].map((flag) => {
      const reason = decide(flag, userId);
      return { key: flag.key, enabled: isOn(reason), reason };
    });
  }

  /** Reads, changes and audits one flag in a transaction, then drops cached rules. */
  private async change(
    staff: Staff,
    key: FlagKey,
    update: (
      tx: Transaction,
      flag: StoredFlag,
    ) => Promise<{
      action: string;
      reason: string;
      userId?: string;
      userEmail?: string | null;
      details: Record<string, unknown>;
    }>,
  ) {
    const result = await transact(this.admin.repo, async (tx) => {
      const flag = { ...emptyFlag(key), ...(await tx.get<StoredFlag>(FLAG_PK, key)), key };
      const entry = await update(tx, flag);
      flag.updatedAt = new Date().toISOString();
      flag.updatedBy = staff.email;
      await tx.put(FLAG_PK, key, flag);
      await this.admin.audit(tx, staff, {
        ...entry,
        details: { key, ...entry.details },
        scope: history(key),
      });
      return flag;
    });
    featureFlagsFor(this.admin.repo).invalidate();
    return this.view(result);
  }
  /** Emails for newly allowlisted accounts, refusing IDs that match no account. */
  private async emails(ids: string[]) {
    const found = await Promise.all(ids.map((id) => this.admin.email(id)));
    const missing = ids.filter((_, i) => !found[i]);
    assert(!missing.length, 'USER_NOT_FOUND', `No account has the ID ${missing.join(', ')}.`, 404);
    return Object.fromEntries(ids.map((id, i) => [id, found[i]!]));
  }

  async set(staff: Staff, name: string, input: AdminFlagBody) {
    const key = this.key(name);
    const userIds = [...new Set(input.userIds)];
    return this.change(staff, key, async (_tx, flag) => {
      assert(
        flag.updatedAt === input.expectedUpdatedAt,
        'FLAG_CHANGED',
        `${flag.updatedBy ?? 'Someone'} changed this flag since you opened it. Reload to see their change.`,
        409,
      );
      const before = summary(flag);
      const added = userIds.filter((id) => !flag.userIds.includes(id));
      const removed = flag.userIds.filter((id) => !userIds.includes(id));
      const emails = await this.emails(added);
      const removedEmails = removed.map((id) => flag.userEmails[id] ?? id);
      flag.mode = input.mode;
      flag.percent = input.percent;
      flag.minVersions = input.minVersions;
      flag.userIds = userIds;
      flag.userEmails = Object.fromEntries(
        userIds.map((id) => [id, emails[id] ?? flag.userEmails[id] ?? id]),
      );
      return {
        action: 'FLAG_CHANGED',
        reason: input.reason,
        details: {
          before,
          after: summary(flag),
          added: added.map((id) => emails[id]),
          removed: removedEmails,
        },
      };
    });
  }
  /** Turns the flag on for one account by adding it to the allowlist. */
  async addUser(staff: Staff, name: string, userId: string, reason: string) {
    const key = this.key(name);
    const emails = await this.emails([userId]);
    return this.change(staff, key, async (_tx, flag) => {
      assert(
        !flag.userIds.includes(userId),
        'INVALID_STATE',
        'This account is already on the list.',
        409,
      );
      flag.userIds = [...flag.userIds, userId];
      flag.userEmails = { ...flag.userEmails, [userId]: emails[userId] };
      return {
        action: 'FLAG_USER_ADDED',
        reason,
        userId,
        userEmail: emails[userId],
        details: { mode: flag.mode },
      };
    });
  }
  async removeUser(staff: Staff, name: string, userId: string, reason: string) {
    const key = this.key(name);
    return this.change(staff, key, async (_tx, flag) => {
      assert(
        flag.userIds.includes(userId),
        'INVALID_STATE',
        'This account is not on the list.',
        409,
      );
      const email = flag.userEmails[userId] ?? null;
      flag.userIds = flag.userIds.filter((id) => id !== userId);
      flag.userEmails = { ...flag.userEmails };
      delete flag.userEmails[userId];
      return {
        action: 'FLAG_USER_REMOVED',
        reason,
        userId,
        userEmail: email,
        details: { mode: flag.mode },
      };
    });
  }
}
