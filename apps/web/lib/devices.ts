import type { Device } from '@harbor/contracts';
import type { BackupRoot } from '../../../packages/contracts/src/backups';

export const platformNames: Record<string, string> = {
  WEB: 'Web browser',
  MACOS: 'Mac',
  WINDOWS: 'Windows PC',
  LINUX: 'Linux computer',
  IOS: 'iPhone or iPad',
  ANDROID: 'Android device',
};
export const isPhone = (device: Pick<Device, 'platform'>) =>
  device.platform === 'IOS' || device.platform === 'ANDROID';

/**
 * Whether a backup came from this device. Each sign-in is a new session, so backups are
 * matched by installation when the server reports it, then by session, then by name.
 */
export function ownsBackup(
  device: Pick<Device, 'id' | 'name' | 'devicePublicId'>,
  root: Pick<BackupRoot, 'deviceId' | 'deviceName' | 'devicePublicId'>,
) {
  if (root.devicePublicId && device.devicePublicId)
    return root.devicePublicId === device.devicePublicId;
  return root.deviceId === device.id || (!!root.deviceName && root.deviceName === device.name);
}
