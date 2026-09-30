'use client';
import type { StorageUsage } from '@harbor/contracts';
import { fileSize } from '../lib/file-metadata';
import { Button } from './ui/button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './ui/menu';
import { Progress } from './ui/progress';

export function StorageIndicator({
  storage,
  onManage,
  onRetry,
}: {
  storage?: StorageUsage | null;
  onManage: () => void;
  onRetry?: () => void;
}) {
  return (
    <div className="drive-storage">
      <div className="drive-storage-heading">
        <span>Storage</span>
        <Button variant="link" className="storage-link" onClick={onManage}>
          Manage storage
        </Button>
      </div>
      {storage ? (
        <>
          <Progress
            value={storage.usedBytes}
            max={storage.quotaBytes || 1}
            aria-label="Storage used"
          />
          <p>
            {fileSize(storage.usedBytes)} of {fileSize(storage.quotaBytes)}
          </p>
        </>
      ) : (
        <Button variant="link" onClick={onRetry}>
          Storage unavailable · Retry
        </Button>
      )}
    </div>
  );
}

export function AccountMenu({
  user,
  storage,
  onNavigate,
  onSignOut,
}: {
  user?: { displayName?: string; username?: string; email?: string };
  storage?: StorageUsage | null;
  onNavigate: (section: 'Settings' | 'Devices' | 'Storage') => void;
  onSignOut: () => void;
}) {
  const name = user?.displayName || 'Your account';
  return (
    <Menu>
      <MenuTrigger render={<button className="account-trigger" />} aria-label="Account menu">
        <span className="avatar">{name[0].toUpperCase()}</span>
      </MenuTrigger>
      <MenuContent className="account-menu" sideOffset={8}>
        <MenuLabel className="account-info">
          <strong>{name}</strong>
          {user?.username && <span>@{user.username}</span>}
          {user?.email && <span>{user.email}</span>}
          {storage && (
            <small>
              {fileSize(storage.usedBytes)} of {fileSize(storage.quotaBytes)} used
            </small>
          )}
        </MenuLabel>
        <MenuSeparator />
        <MenuItem onClick={() => onNavigate('Settings')}>Account settings</MenuItem>
        <MenuItem onClick={() => onNavigate('Devices')}>Devices</MenuItem>
        <MenuItem onClick={() => onNavigate('Storage')}>Manage storage</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onSignOut}>Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
}
