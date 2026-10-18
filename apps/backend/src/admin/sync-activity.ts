import * as c from '@harbor/contracts';
import type { DriveItem } from '@harbor/contracts';
import type { ActivityState } from '../../../../packages/contracts/src/activity';
import { isEncryptedName } from '../../../../packages/contracts/src/e2ee';
import {
  ADMIN_ACTIVITY_LIMIT,
  type AdminDeviceActivity,
  type AdminSync,
} from '../../../../packages/contracts/src/admin';
import { StorageService, userPK } from '../domain';
import { syncDeviceKey, type SyncMapping } from '../sync-relay';
import { list } from './backup-runs';
import type { ActivitySource } from './activity';

const RANGE_SECONDS = { '1h': 3600, '24h': 86_400, '7d': 7 * 86_400, '30d': 30 * 86_400 };

/**
 * Each device's synced folders, named by the folder alone (nothing inside it), with what the
 * device last reported about each and about its engine.
 */
export async function syncActivity(service: StorageService, userId: string): Promise<AdminSync> {
  const repo = service.repo;
  const [mappings, states, { items: devices }] = await Promise.all([
    list<SyncMapping>(repo, userPK(userId), 'SYNCFOLDERS#'),
    list<ActivityState>(repo, userPK(userId), 'ACTIVITY#'),
    service.devices(userId),
  ]);
  const named = async (folderId: string) => {
    const owner =
      ((await repo.get({ pk: 'ITEMOWNER', sk: folderId }))?.data as { userId?: string })?.userId ??
      userId;
    const item = (await repo.get({ pk: userPK(owner), sk: `ITEM#${folderId}` }))?.data as
      DriveItem | undefined;
    const encrypted = !!item && isEncryptedName(item.name);
    return { name: item && !encrypted ? item.name : null, encrypted, shared: owner !== userId };
  };
  const out = await Promise.all(
    mappings.map(async (mapping) => {
      // The newest session of the installation names it.
      const device = devices
        .filter((d) => syncDeviceKey(d) === mapping.key)
        .sort((a, b) =>
          (b.lastSeenAt ?? b.createdAt).localeCompare(a.lastSeenAt ?? a.createdAt),
        )[0];
      const mine = states.filter((s) => s.deviceKey === mapping.key);
      return {
        deviceKey: mapping.key,
        deviceName: device?.name ?? null,
        platform: device?.platform ?? null,
        signedIn: !!device && (device.status ?? 'ACTIVE') === 'ACTIVE',
        engine: mine.find((s) => s.scope === 'ENGINE') ?? null,
        folders: await Promise.all(
          mapping.folderIds.map(async (folderId) => ({
            folderId,
            ...(await named(folderId)),
            status: mine.find((s) => s.scope === 'SYNC' && s.folderId === folderId) ?? null,
          })),
        ),
      };
    }),
  );
  return {
    checkedAt: new Date().toISOString(),
    devices: out.filter((d) => d.folders.length || d.engine),
  };
}

const iso = (value: string | undefined) =>
  value ? new Date(`${value.replace(' ', 'T')}Z`).toISOString() : '';
const num = (value: string | undefined) => (value ? Number(value) : null);

/** The account's apps' activity reports, newest first, from the request log. */
export async function deviceActivityLog(
  source: ActivitySource,
  userId: string,
  options: { range: keyof typeof RANGE_SECONDS; scope: 'ALL' | c.ActivityScope },
  now = Date.now(),
): Promise<AdminDeviceActivity> {
  const end = Math.floor(now / 1000);
  // Ids are letters, digits, "-" and "_", so the filter never needs escaping.
  const scope = options.scope === 'ALL' ? '' : ` and scope = "${options.scope}"`;
  const rows = await source(
    `filter event = "activity" and userId = "${c.id.parse(userId)}"${scope}` +
      ' | fields @timestamp, at, deviceId, platform, appVersion, scope, folderId, action, status, reason, files, bytes, failed' +
      ` | sort at desc | limit ${ADMIN_ACTIVITY_LIMIT + 1}`,
    end - RANGE_SECONDS[options.range],
    end,
  );
  return {
    events: rows.slice(0, ADMIN_ACTIVITY_LIMIT).map((r) => ({
      // When it happened on the device; the log time is when it arrived.
      at: r.at || iso(r['@timestamp']),
      deviceId: r.deviceId || null,
      platform: r.platform || null,
      appVersion: r.appVersion || null,
      scope: r.scope as c.ActivityScope,
      folderId: r.folderId || null,
      action: r.action as c.ActivityAction,
      status: r.status as c.ActivityStatus,
      reason: (r.reason || null) as c.ActivityReason | null,
      files: num(r.files),
      bytes: num(r.bytes),
      failed: num(r.failed),
    })),
    more: rows.length > ADMIN_ACTIVITY_LIMIT,
  };
}
