'use client';
import type { ReactNode } from 'react';
import { Archive, FolderSync, HardDriveUpload, Laptop, Smartphone } from 'lucide-react';
import type { Device, SyncFolderItem } from '@harbor/contracts';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { isPhone, ownsBackup, platformNames } from '../lib/devices';
import { fileDate } from '../lib/file-metadata';
import { totalUsage, usageLabel, type UsageMap } from '../lib/folder-usage';
import { EmptyState, LoadError } from './empty-state';
import { FileCollection, FileCollectionSkeleton, type PinnedEntry } from './file-collection';
import { ContentSkeleton } from './loading-states';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';

export function DeviceIcon({ device }: { device: Pick<Device, 'platform'> }) {
  const Icon = isPhone(device) ? Smartphone : Laptop;
  return <Icon aria-hidden="true" />;
}

/** Permanent places in My Drive that hold each device's synced, backed-up or archived folders. */
export type DrivePlace = 'synced' | 'backups' | 'archives';
export const drivePlaceOrder: DrivePlace[] = ['synced', 'backups', 'archives'];
export const drivePlaces: Record<
  DrivePlace,
  {
    name: string;
    icon: typeof FolderSync;
    /** What the place is for, under its name in My Drive. */
    detail: string;
    folder: string;
    empty: string;
    deviceEmpty: (device: string, phone: boolean) => string;
  }
> = {
  synced: {
    name: 'Synced Folders',
    icon: FolderSync,
    detail: 'Folders synced on your devices',
    folder: 'synced folder',
    empty:
      'Sync a folder from the harbor0 desktop or mobile app. Each device gets a folder here, holding the folders it syncs.',
    deviceEmpty: (device, phone) =>
      phone
        ? `Folders you choose to sync in the harbor0 app on ${device} will appear here.`
        : `Folders you sync in the harbor0 desktop app on ${device} will appear here.`,
  },
  backups: {
    name: 'Backups',
    icon: HardDriveUpload,
    detail: 'Folders backed up from your devices',
    folder: 'backup folder',
    empty:
      'Back up a folder from the harbor0 desktop or mobile app. Each device gets a folder here, holding the folders it backs up.',
    deviceEmpty: (device) => `Folders backed up from ${device} will appear here.`,
  },
  archives: {
    name: 'Archives',
    icon: Archive,
    detail: 'Backups kept only in the cloud',
    folder: 'archived folder',
    empty:
      'When you archive a backup, its files are removed from the device and kept here, read-only.',
    deviceEmpty: (device) => `Backups archived from ${device} will appear here.`,
  },
};
export const isDrivePlace = (value: string | null): value is DrivePlace =>
  !!value && value in drivePlaces;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One device inside a place, with the folders it holds there. */
export type PlaceGroup = {
  /** The device ID, or `other:<name>` for backups whose device is no longer connected. */
  key: string;
  name: string;
  device?: Device;
  folders: { id: string; name: string; detail?: string }[];
};

const backupStates: Record<string, string> = {
  ACTIVE: 'Backup on',
  PAUSED: 'Paused',
  ERROR: 'Needs attention',
};

/**
 * The devices in a place. A synced folder on several devices is listed under each of them; a
 * backup belongs to the device that made it, or to its saved name once that device is gone.
 */
export function placeGroups(
  place: DrivePlace,
  devices: Device[],
  syncFolders: SyncFolderItem[] = [],
  backups: BackupRoot[] = [],
): PlaceGroup[] {
  // Browsers never sync or back up folders.
  const candidates = devices.filter((device) => device.platform !== 'WEB');
  const groups = new Map<string, PlaceGroup>();
  const group = (key: string, name: string, device?: Device) => {
    if (!groups.has(key)) groups.set(key, { key, name, device, folders: [] });
    return groups.get(key)!;
  };
  if (place === 'synced') {
    for (const device of candidates)
      for (const folder of syncFolders) {
        if (!folder.syncDevices.some((entry) => entry.id === device.id)) continue;
        const others = folder.syncDevices.filter((entry) => entry.id !== device.id);
        group(device.id, device.name, device).folders.push({
          id: folder.id,
          name: folder.name,
          detail: others.length
            ? `Also on ${others.map((entry) => entry.name).join(', ')}`
            : `Only on ${device.name}`,
        });
      }
  } else {
    const archived = place === 'archives';
    for (const root of backups) {
      if (root.state === 'REMOVED' || (root.state === 'ARCHIVED') !== archived) continue;
      const device = candidates.find((candidate) => ownsBackup(candidate, root));
      const name = device?.name ?? root.deviceName ?? 'Other device';
      group(device?.id ?? `other:${name}`, name, device).folders.push({
        id: root.remoteRootDriveItemId,
        name: root.localPathDisplayName,
        detail: archived
          ? `Archived ${fileDate(root.updatedAt).date}`
          : (backupStates[root.state] ?? root.state),
      });
    }
  }
  return [...groups.values()]
    .map((entry) => ({
      ...entry,
      folders: entry.folders.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort(
      (a, b) =>
        Number(!a.device) - Number(!b.device) ||
        Number(!!a.device?.revokedAt) - Number(!!b.device?.revokedAt) ||
        Number(!!a.device && isPhone(a.device)) - Number(!!b.device && isPhone(b.device)) ||
        a.name.localeCompare(b.name),
    );
}

/** Every folder a place holds, each once, whether or not its device is still listed. */
export function placeFolderIds(
  place: DrivePlace,
  syncFolders: SyncFolderItem[] = [],
  backups: BackupRoot[] = [],
) {
  if (place === 'synced') return syncFolders.map((folder) => folder.id);
  return backups
    .filter(
      (root) => root.state !== 'REMOVED' && (root.state === 'ARCHIVED') === (place === 'archives'),
    )
    .map((root) => root.remoteRootDriveItemId);
}

/**
 * My Drive › a place: one folder per computer or phone, each holding that device's folders in
 * this place. Opening a folder continues in the ordinary drive browser.
 */
export function DevicePlace({
  place,
  groups,
  groupKey,
  loading,
  error,
  onRetry,
  breadcrumbs,
  onOpenGroup,
  onOpenFolder,
  usage,
  actions,
}: {
  place: DrivePlace;
  /** Buttons beside the heading, e.g. “Back up a folder” on the desktop app. */
  actions?: ReactNode;
  groups: PlaceGroup[];
  /** Storage used by each folder, once loaded. */
  usage?: UsageMap;
  /** The open device, or null to list every device. */
  groupKey: string | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  breadcrumbs: ReactNode;
  onOpenGroup: (key: string) => void;
  onOpenFolder: (key: string, folderId: string) => void;
}) {
  const info = drivePlaces[place];
  const open = groupKey ? groups.find((entry) => entry.key === groupKey) : undefined;
  const entries: PinnedEntry[] = groupKey
    ? (open?.folders ?? []).map((folder) => ({
        id: folder.id,
        name: folder.name,
        icon: info.icon,
        detail: folder.detail,
        size: usageLabel(totalUsage([folder.id], usage)),
        onOpen: () => onOpenFolder(groupKey, folder.id),
      }))
    : groups.map((entry) => ({
        id: entry.key,
        name: entry.name,
        icon: entry.device && isPhone(entry.device) ? Smartphone : Laptop,
        detail: [
          entry.device ? (platformNames[entry.device.platform] ?? entry.device.platform) : null,
          plural(entry.folders.length, info.folder),
          entry.device?.revokedAt ? 'Signed out' : !entry.device ? 'No longer connected' : null,
        ]
          .filter(Boolean)
          .join(' · '),
        size: usageLabel(
          totalUsage(
            entry.folders.map((folder) => folder.id),
            usage,
          ),
        ),
        onOpen: () => onOpenGroup(entry.key),
      }));
  const title = groupKey ? (open?.name ?? 'Device') : info.name;
  // The open level's total: this device's folders, or every device's, each folder once.
  const total = usageLabel(
    totalUsage(
      (groupKey ? (open?.folders ?? []) : groups.flatMap((entry) => entry.folders)).map(
        (folder) => folder.id,
      ),
      usage,
    ),
  );
  return (
    <section className="drive-workspace" aria-label={info.name}>
      <div className="drive-tabs">
        <div className="page-heading drive-heading">
          <div className="drive-title">
            <h1>{title}</h1>
          </div>
          {actions && <div className="heading-actions">{actions}</div>}
        </div>
        <nav className="breadcrumbs drive-breadcrumbs" aria-label="Drive location">
          {breadcrumbs}
        </nav>
        {!loading && entries.length > 0 && (
          <p className="drive-item-count place-summary">
            {plural(entries.length, groupKey ? info.folder : 'device')}
            {total && ` · ${total} used`}
          </p>
        )}
      </div>
      <div className="drive-content">
        {loading ? (
          <div className="drive-collection">
            <FileCollectionSkeleton compact />
          </div>
        ) : error && !entries.length ? (
          <LoadError onRetry={onRetry} />
        ) : !entries.length ? (
          <EmptyState
            icon={<info.icon />}
            title={groupKey ? `No ${info.folder}s` : `Nothing in ${info.name} yet`}
            description={
              groupKey
                ? info.deviceEmpty(title, !!open?.device && isPhone(open.device))
                : info.empty
            }
            actions={actions}
          />
        ) : (
          <FileCollection
            label={groupKey ? `${info.name} from ${title}` : info.name}
            compact
            items={[]}
            pinned={entries}
            renderActions={() => null}
            onOpen={() => {}}
          />
        )}
      </div>
    </section>
  );
}

/** The three places as pinned rows at the top of My Drive, with the storage each uses. */
export function drivePlacePins(
  onOpen: (place: DrivePlace) => void,
  sizes: Partial<Record<DrivePlace, string>> = {},
): PinnedEntry[] {
  return drivePlaceOrder.map((place) => ({
    id: `place:${place}`,
    name: drivePlaces[place].name,
    icon: drivePlaces[place].icon,
    detail: drivePlaces[place].detail,
    size: sizes[place],
    onOpen: () => onOpen(place),
  }));
}

/** Each place's total, for its pinned row. */
export function placeSizes(
  syncFolders: SyncFolderItem[] | undefined,
  backups: BackupRoot[] | undefined,
  usage: UsageMap | undefined,
) {
  const sizes: Partial<Record<DrivePlace, string>> = {};
  for (const place of drivePlaceOrder) {
    const ready = place === 'synced' ? syncFolders : backups;
    if (ready)
      sizes[place] = usageLabel(totalUsage(placeFolderIds(place, syncFolders, backups), usage));
  }
  return sizes;
}

const lastActive = (device: Device) =>
  device.revokedAt
    ? 'Signed out'
    : `Last active ${fileDate(device.lastSeenAt ?? device.createdAt).date}`;

const connection = (device: Device) =>
  device.status === 'SIGNED_OUT' || device.revokedAt
    ? 'Signed out · sync and backups paused'
    : lastActive(device);

/** Devices signed in to the account, each with Sign out (pause) and Revoke (remove). */
export function ConnectedDevices({
  devices,
  currentId,
  loading,
  error,
  onRetry,
  onSignOut,
  onRevoke,
}: {
  devices: Device[] | undefined;
  /** This computer, on desktop. */
  currentId?: string | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onSignOut: (device: Device) => void;
  onRevoke: (device: Device) => void;
}) {
  const list = [...(devices ?? [])].sort(
    (a, b) =>
      Number(a.status === 'SIGNED_OUT') - Number(b.status === 'SIGNED_OUT') ||
      Number(a.platform === 'WEB') - Number(b.platform === 'WEB') ||
      a.name.localeCompare(b.name),
  );
  return (
    <Card
      className="panel"
      title="Connected devices"
      description="Sign out a device to pause its sync and backups until it signs in again. Revoke a device to remove it for good."
    >
      {loading ? (
        <ContentSkeleton label="Loading devices" />
      ) : error && !list.length ? (
        <LoadError compact onRetry={onRetry} />
      ) : !list.length ? (
        <EmptyState
          compact
          icon={<Laptop />}
          title="No connected devices"
          description="Sign in to harbor0 on a computer or phone. Your devices will appear here."
          actions={
            <Button variant="outline" onClick={onRetry}>
              Refresh devices
            </Button>
          }
        />
      ) : (
        list.map((device) => (
          <article className="list-row simple-row" key={device.id}>
            <span className="icon-tile">
              <DeviceIcon device={device} />
            </span>
            <div className="list-row-text">
              <strong>
                {device.name}
                {device.id === currentId && (
                  <>
                    {' '}
                    <Badge tone="accent">This device</Badge>
                  </>
                )}
              </strong>
              <small>
                {platformNames[device.platform] ?? device.platform} · {connection(device)}
              </small>
            </div>
            <div className="list-row-actions">
              {device.status !== 'SIGNED_OUT' && !device.revokedAt && (
                <Button size="sm" variant="outline" onClick={() => onSignOut(device)}>
                  Sign out
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => onRevoke(device)}>
                Revoke
              </Button>
            </div>
          </article>
        ))
      )}
    </Card>
  );
}

/** What revoking a device does, for the confirmation before it happens. */
export function RevokeDetails({
  device,
  backups,
  syncFolders,
}: {
  device: Device;
  /** This device's backup folders that are still running. */
  backups: { id: string; localPathDisplayName: string }[];
  /** Sync folders this device takes part in, with every device on each. */
  syncFolders: SyncFolderItem[];
}) {
  const alone = syncFolders.filter((folder) =>
    folder.syncDevices.every((entry) => entry.id === device.id),
  );
  return (
    <div className="revoke-details">
      <p>
        {device.name} is signed out and removed from your devices. Nothing stored on it is deleted.
      </p>
      <section>
        <h3>Backups stop</h3>
        {backups.length ? (
          <>
            <p>
              {plural(backups.length, 'backup folder')} {backups.length === 1 ? 'is' : 'are'}{' '}
              archived in the cloud. Every backed-up file and version is kept, read-only.
            </p>
            <ul>
              {backups.map((root) => (
                <li key={root.id}>{root.localPathDisplayName}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>This device doesn’t back up any folders.</p>
        )}
      </section>
      <section>
        <h3>Sync stops</h3>
        {syncFolders.length ? (
          <>
            <p>
              It leaves {plural(syncFolders.length, 'synced folder')}. Your other devices keep
              syncing them.
            </p>
            <ul>
              {syncFolders.map((folder) => (
                <li key={folder.id}>{folder.name}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>This device doesn’t sync any folders.</p>
        )}
      </section>
      {alone.length > 0 && (
        <Alert>
          {alone.map((folder) => folder.name).join(', ')} {alone.length === 1 ? 'isn’t' : 'aren’t'}{' '}
          synced to any other device. {alone.length === 1 ? 'It stays' : 'They stay'} in My Drive
          under {drivePlaces.synced.name}.
        </Alert>
      )}
      <p className="muted">
        If someone signs in on {device.name} again later, it’s added as a new device.
      </p>
    </div>
  );
}
