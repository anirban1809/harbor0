export const workspaceRoutes = {
  'My Drive': '/drive',
  Shared: '/shared',
  Trash: '/trash',
  Backups: '/backups',
  Sync: '/sync',
  Devices: '/devices',
  Storage: '/storage',
  Settings: '/settings',
  Notifications: '/notifications',
} as const;

export type WorkspaceSection = keyof typeof workspaceRoutes;

export const authRoutes = {
  login: '/login',
  signup: '/signup',
  confirm: '/confirm',
  forgot: '/forgot-password',
  reset: '/reset-password',
} as const;

export type AuthMode = keyof typeof authRoutes;

// Legal pages live on the marketing site, which is deployed separately.
export const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://harbor0.com').replace(
  /\/$/,
  '',
);
export const termsUrl = `${siteUrl}/terms`;
export const privacyUrl = `${siteUrl}/privacy`;

export function driveHref(folderId: string | null = null): string {
  return folderId ? `/drive?${new URLSearchParams({ folder: folderId })}` : '/drive';
}

/** Sync folders: every device, one device's folders, or a folder opened from it. */
export function syncHref(deviceId: string | null = null, folderId: string | null = null): string {
  const params = new URLSearchParams();
  if (deviceId) params.set('device', deviceId);
  if (folderId) params.set('folder', folderId);
  return params.size ? `/sync?${params}` : '/sync';
}

/** A place in My Drive (Synced Folders, Backups, Archives), then one device, then a folder. */
export function placeHref(
  place: 'synced' | 'backups' | 'archives',
  deviceId: string | null = null,
  folderId: string | null = null,
): string {
  if (place === 'synced') return syncHref(deviceId, folderId);
  const params = new URLSearchParams({ place });
  if (deviceId) params.set('device', deviceId);
  if (folderId) params.set('folder', folderId);
  return `/drive?${params}`;
}

export function sharedHref(tab: 'Received' | 'Sent' = 'Received'): string {
  return tab === 'Sent' ? '/shared?tab=sent' : '/shared';
}

// Only known workspace pages can be used as a post-login destination.
export function loginDestination(path: string | null): string {
  const [pathname, search = ''] = (path ?? '').split('?');
  if (pathname === '/received') return sharedHref();
  if (pathname === '/sent') return sharedHref('Sent');
  const route = Object.values(workspaceRoutes).find((route) => route === pathname);
  const params = new URLSearchParams(search);
  const place = params.get('place');
  if (route === '/drive' && (place === 'backups' || place === 'archives'))
    return placeHref(place, params.get('device'), params.get('folder'));
  if (route === '/drive') return driveHref(params.get('folder'));
  // Backups now live in My Drive.
  if (route === '/backups') {
    const device = params.get('device');
    return placeHref('backups', device && device !== 'all' ? device : null);
  }
  if (route === '/sync') return syncHref(params.get('device'), params.get('folder'));
  if (route === '/shared') return sharedHref(params.get('tab') === 'sent' ? 'Sent' : 'Received');
  return route ?? '/drive';
}
