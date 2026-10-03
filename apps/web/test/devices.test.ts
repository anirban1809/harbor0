import { describe, expect, it } from 'vitest';
import type { Device } from '@harbor/contracts';
import { ownsBackup } from '../lib/devices';
import { loginDestination, placeHref, syncHref } from '../lib/routes';

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
const root = (
  deviceId: string,
  change: {
    devicePublicId?: string | null;
    deviceName?: string;
    state?: 'ACTIVE' | 'REMOVED';
  } = {},
) => ({
  id: `backup-${deviceId}`,
  userId: 'alice',
  deviceId,
  localPathDisplayName: 'Documents',
  remoteRootDriveItemId: `folder-${deviceId}`,
  state: 'ACTIVE' as const,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...change,
});

describe('devices on the Backups and Sync pages', () => {
  it('matches backups by installation, so a device keeps them after signing in again', () => {
    const mac = device('new-session', { devicePublicId: 'mac' });
    expect(ownsBackup(mac, root('old-session', { devicePublicId: 'mac' }))).toBe(true);
    expect(ownsBackup(mac, root('new-session', { devicePublicId: 'other' }))).toBe(false);
    // Older servers don't report the installation: fall back to the session, then the name.
    expect(ownsBackup(device('s1'), root('s1'))).toBe(true);
    expect(ownsBackup(device('s2', { name: 'Mac' }), root('s1', { deviceName: 'Mac' }))).toBe(true);
  });

  it('keeps the chosen device and folder through sign-in', () => {
    expect(loginDestination(syncHref('d1', 'f1'))).toBe('/sync?device=d1&folder=f1');
    expect(loginDestination(placeHref('backups', 'd1', 'f1'))).toBe(
      '/drive?place=backups&device=d1&folder=f1',
    );
    // Links to the old Backups page open the same device in My Drive.
    expect(loginDestination('/backups?device=d1')).toBe('/drive?place=backups&device=d1');
    expect(loginDestination('/backups?device=all')).toBe('/drive?place=backups');
    expect(loginDestination('/sync')).toBe('/sync');
  });
});
