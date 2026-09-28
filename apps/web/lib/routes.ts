export const workspaceRoutes = {
  'My Drive': '/drive',
  Received: '/received',
  Sent: '/sent',
  Shared: '/shared',
  Favorites: '/favorites',
  Trash: '/trash',
  Backups: '/backups',
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

export function driveHref(folderId: string | null = null): string {
  return folderId ? `/drive?${new URLSearchParams({ folder: folderId })}` : '/drive';
}

// Only known workspace pages can be used as a post-login destination.
export function loginDestination(path: string | null): string {
  const [pathname, search = ''] = (path ?? '').split('?');
  const route = Object.values(workspaceRoutes).find((route) => route === pathname);
  if (route === '/drive') return driveHref(new URLSearchParams(search).get('folder'));
  return route ?? '/drive';
}
