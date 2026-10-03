import { expect, it } from 'vitest';
import type { Device, SyncFolderItem } from '@harbor/contracts';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { placeGroups } from '../components/device-folders';
import { placeHref } from '../lib/routes';

const device = (id: string, change: Partial<Device> = {}): Device => ({
  id,
  userId: 'alice',
  name: id,
  platform: 'MACOS',
  appVersion: null,
  devicePublicId: null,
  keyFingerprint: null,
  lastSeenAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  revokedAt: null,
  ...change,
});
const root = (id: string, change: Partial<BackupRoot>): BackupRoot => ({
  id,
  userId: 'alice',
  deviceId: 'mac',
  localPathDisplayName: id,
  remoteRootDriveItemId: `item-${id}`,
  state: 'ACTIVE',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...change,
});
const devices = [
  device('mac', { name: 'MacBook' }),
  device('phone', { name: 'iPhone', platform: 'IOS' }),
  device('web', { platform: 'WEB' }),
];
const backups = [
  root('Photos', {}),
  root('Paused', { state: 'PAUSED' }),
  root('Old', { state: 'ARCHIVED' }),
  root('Gone', { state: 'ARCHIVED', deviceId: 'revoked', deviceName: 'Old PC' }),
  root('Disconnected', { state: 'REMOVED' }),
];

it('groups active backups by the device that made them', () => {
  expect(placeGroups('backups', devices, [], backups)).toEqual([
    expect.objectContaining({
      key: 'mac',
      name: 'MacBook',
      folders: [
        { id: 'item-Paused', name: 'Paused', detail: 'Paused' },
        { id: 'item-Photos', name: 'Photos', detail: 'Backup on' },
      ],
    }),
  ]);
});

it('keeps archives from devices that are no longer connected under their saved name', () => {
  const groups = placeGroups('archives', devices, [], backups);
  expect(groups.map((group) => [group.key, group.folders.map((f) => f.name)])).toEqual([
    ['mac', ['Old']],
    ['other:Old PC', ['Gone']],
  ]);
  expect(groups[1].device).toBeUndefined();
});

it('lists a synced folder under every device that syncs it, never browsers', () => {
  const folder = {
    id: 'docs',
    name: 'Docs',
    syncDevices: [
      { id: 'mac', name: 'MacBook' },
      { id: 'phone', name: 'iPhone' },
      { id: 'web', name: 'web' },
    ],
  } as SyncFolderItem;
  const groups = placeGroups('synced', devices, [folder]);
  expect(groups.map((group) => group.key)).toEqual(['mac', 'phone']);
  expect(groups[0].folders[0].detail).toBe('Also on iPhone, web');
});

it('links places inside My Drive', () => {
  expect(placeHref('synced', 'mac', 'docs')).toBe('/sync?device=mac&folder=docs');
  expect(placeHref('archives')).toBe('/drive?place=archives');
  expect(placeHref('backups', 'other:Old PC')).toBe('/drive?place=backups&device=other%3AOld+PC');
});

it('shows storage at the place, device and folder levels, as a lower bound when partial', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { DevicePlace, placeSizes } = await import('../components/device-folders');
  const groups = placeGroups('backups', devices, [], backups);
  const usage = {
    'item-Photos': { itemId: 'item-Photos', bytes: 2_000_000, files: 3, complete: true },
    'item-Paused': { itemId: 'item-Paused', bytes: 500_000, files: 1, complete: false },
  };
  const render = (groupKey: string | null) =>
    renderToStaticMarkup(
      createElement(DevicePlace, {
        place: 'backups',
        groups,
        groupKey,
        loading: false,
        error: false,
        onRetry: () => {},
        breadcrumbs: null,
        onOpenGroup: () => {},
        onOpenFolder: () => {},
        usage,
      }),
    );
  expect(render(null)).toContain('1 device · At least 2.5 MB used');
  expect(render('mac')).toContain('2 backup folders · At least 2.5 MB used');
  expect(render('mac')).toContain('<span>2.0 MB</span>');
  expect(render('mac')).toContain('<span>At least 500.0 KB</span>');
  expect(placeSizes([], backups, usage)).toEqual({
    synced: '0 B',
    backups: 'At least 2.5 MB',
    archives: '0 B',
  });
});
