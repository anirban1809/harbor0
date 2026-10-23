import { ApiError, type ApiClient } from '@harbor/api-client';
import type { Device, SyncFolderItem } from '@harbor/contracts';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { ownsBackup } from '../../web/lib/devices';
import type { DavDrive, DavEntry } from './drive-dav';

/**
 * My Drive's top as the web and desktop apps show it: synced, backed-up and archived folders sit
 * in Synced Folders, Backups and Archives, one folder per device inside each, rather than beside
 * the cloud files. Those folders and the device folders are the app's to arrange; everything
 * inside a synced or backed-up folder works as anywhere else.
 */

export type PlaceCatalog = {
  devices: Device[];
  syncFolders: SyncFolderItem[];
  backups: BackupRoot[];
};

const PLACES = [
  { key: 'synced', name: 'Synced Folders' },
  { key: 'backups', name: 'Backups' },
  { key: 'archives', name: 'Archives' },
] as const;
type PlaceKey = (typeof PLACES)[number]['key'];

const PREFIX = 'place:';
const isPlace = (id: string | null) => !!id?.startsWith(PREFIX);
const CATALOG_TTL_MS = 10_000;

type Tree = {
  /** The cloud items at the top, without the folders placed below. */
  top: DavEntry[];
  /** Every folder the places add, by id: places, devices, and the folders a device holds. */
  listings: Map<string, DavEntry[]>;
  at: number;
};

const folderEntry = (id: string, parentId: string | null, name: string, inside: DavEntry[]) => {
  const modified =
    inside
      .map((entry) => entry.modified)
      .sort()
      .at(-1) ?? new Date(0).toISOString();
  return {
    id,
    parentId,
    name,
    folder: true,
    size: 0,
    mimeType: '',
    created: modified,
    modified,
    etag: `${id}-${modified}`,
  } satisfies DavEntry;
};

/** `name`, or `name (2)` and on while another entry here is called that. */
function unique(name: string, taken: Set<string>) {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** The places and what's in them, from the drive's top and the account's devices and folders. */
export function placeTree(top: DavEntry[], catalog: PlaceCatalog): Tree {
  const byId = new Map(top.map((entry) => [entry.id, entry]));
  const placed = new Set<string>();
  const groups: Record<PlaceKey, Map<string, { name: string; folders: DavEntry[] }>> = {
    synced: new Map(),
    backups: new Map(),
    archives: new Map(),
  };
  const add = (place: PlaceKey, key: string, device: string, folder: DavEntry) => {
    const group = groups[place].get(key) ?? { name: device, folders: [] };
    group.folders.push(folder);
    groups[place].set(key, group);
  };
  for (const folder of catalog.syncFolders) {
    const entry = byId.get(folder.id);
    // A synced folder deeper in My Drive stays where it is.
    if (!entry) continue;
    placed.add(entry.id);
    const devices = folder.syncDevices.length
      ? folder.syncDevices
      : [{ id: 'other', name: 'Other device' }];
    // On several devices, it's listed under each, as in the app.
    for (const device of devices) add('synced', device.id, device.name, entry);
  }
  // Browsers never back up folders.
  const candidates = catalog.devices.filter((device) => device.platform !== 'WEB');
  for (const root of catalog.backups) {
    if (root.state === 'REMOVED') continue;
    const entry = byId.get(root.remoteRootDriveItemId);
    if (!entry) continue;
    placed.add(entry.id);
    const device = candidates.find((candidate) => ownsBackup(candidate, root));
    const name = device?.name ?? root.deviceName ?? 'Other device';
    add(root.state === 'ARCHIVED' ? 'archives' : 'backups', device?.id ?? `other:${name}`, name, {
      ...entry,
      // Named for the folder on the computer, as the app shows it, unless that name is taken.
      name: root.localPathDisplayName || entry.name,
    });
  }

  const listings = new Map<string, DavEntry[]>();
  const cloud = top.filter((entry) => !placed.has(entry.id));
  const topNames = new Set(cloud.map((entry) => entry.name.toLowerCase()));
  const places: DavEntry[] = [];
  for (const place of PLACES) {
    const placeId = `${PREFIX}${place.key}`;
    const deviceNames = new Set<string>();
    const devices = [...groups[place.key]]
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([key, group]) => {
        const deviceId = `${placeId}/${key}`;
        const names = new Set<string>();
        const folders = group.folders.map((folder) => ({
          ...folder,
          parentId: deviceId,
          name: names.has(folder.name.toLowerCase())
            ? unique(byId.get(folder.id)!.name, names)
            : unique(folder.name, names),
        }));
        listings.set(deviceId, folders);
        return folderEntry(deviceId, placeId, unique(group.name, deviceNames), folders);
      });
    listings.set(placeId, devices);
    // A cloud folder of the same name keeps its name; the place gives way.
    places.push(folderEntry(placeId, null, unique(place.name, topNames), devices));
  }
  return { top: [...places, ...cloud], listings, at: Date.now() };
}

const refuse = (message: string) => new ApiError('PLACE_READ_ONLY', message, 403);
const MANAGED = 'Synced and backed-up folders are managed in the harbor0 app.';

/** `drive` with My Drive's top arranged into places; without the catalog, it's left as it is. */
export function placesDrive(drive: DavDrive, catalog: () => Promise<PlaceCatalog>): DavDrive {
  let tree: Promise<Tree> | undefined;
  let treeAt = 0;
  const read = () => {
    const next = Promise.all([drive.list(null), catalog().catch(() => undefined)]).then(
      ([top, places]) =>
        places ? placeTree(top, places) : { top, listings: new Map(), at: Date.now() },
    );
    tree = next;
    treeAt = Date.now();
    next.catch(() => {
      if (tree === next) tree = undefined;
    });
    return next;
  };
  const current = () => (tree && Date.now() - treeAt < CATALOG_TTL_MS ? tree : read());
  return {
    ...drive,
    async list(folderId) {
      // The top is read again every time the server asks; it keeps its own listings.
      if (folderId === null) return (await read()).top;
      if (!isPlace(folderId)) return drive.list(folderId);
      let listing = (await current()).listings.get(folderId);
      // A folder made since the last reading.
      listing ??= (await read()).listings.get(folderId);
      if (!listing) throw new ApiError('NOT_FOUND', 'Not found.', 404);
      return listing;
    },
    async write(parentId, ...rest) {
      if (isPlace(parentId)) throw refuse(MANAGED);
      return drive.write(parentId, ...rest);
    },
    async mkdir(parentId, name) {
      if (isPlace(parentId)) throw refuse(MANAGED);
      return drive.mkdir(parentId, name);
    },
    async move(entry, parentId, name) {
      if (isPlace(entry.id) || isPlace(entry.parentId) || isPlace(parentId)) throw refuse(MANAGED);
      return drive.move(entry, parentId, name);
    },
    async remove(entry) {
      if (isPlace(entry.id) || isPlace(entry.parentId)) throw refuse(MANAGED);
      return drive.remove(entry);
    },
  };
}

/** The account's devices, synced folders and backups, through the app's API client. */
export const apiCatalog = (api: ApiClient) => async (): Promise<PlaceCatalog> => {
  const [devices, syncFolders, backups] = await Promise.all([
    api.request('/v1/devices'),
    api.request('/v1/sync/folders'),
    api.request('/v1/backups'),
  ]);
  return { devices: devices.items, syncFolders: syncFolders.items, backups: backups.items };
};
