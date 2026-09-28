'use client';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Cloud } from 'lucide-react';
import type { StorageUsage } from '@harbor/contracts';
import { fileSize } from '../lib/file-metadata';
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
      <div className="storage-caption">
        <Cloud size={16} />
        <span>Storage</span>
      </div>
      {storage ? (
        <>
          <p>
            {fileSize(storage.usedBytes)} of {fileSize(storage.quotaBytes)}
          </p>
          <progress
            value={storage.usedBytes}
            max={storage.quotaBytes || 1}
            aria-label="Storage used"
          />
        </>
      ) : (
        <button onClick={onRetry}>Storage unavailable · Retry</button>
      )}
      <button className="storage-link" onClick={onManage}>
        Manage storage
      </button>
    </div>
  );
}
export function AccountMenu({
  user,
  storage,
  onNavigate,
  onSignOut,
  footer = false,
}: {
  user?: { displayName?: string; username?: string; email?: string };
  storage?: StorageUsage | null;
  onNavigate: (section: 'Settings' | 'Devices' | 'Storage') => void;
  onSignOut: () => void;
  footer?: boolean;
}) {
  const name = user?.displayName || 'Your account';
  return (
    <Menu.Root>
      <Menu.Trigger
        className={footer ? 'account drive-account-trigger' : 'avatar small'}
        aria-label="Account menu"
      >
        <span className={footer ? 'avatar' : undefined}>{name[0].toUpperCase()}</span>
        {footer && (
          <div>
            <strong>{name}</strong>
            {user?.username && <small>@{user.username}</small>}
          </div>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="dropdown drive-account-menu" align="end" sideOffset={8}>
          <Menu.Label className="drive-account-info">
            <strong>{name}</strong>
            {user?.username && <span>@{user.username}</span>}
            {user?.email && <span>{user.email}</span>}
            {storage && (
              <small>
                {fileSize(storage.usedBytes)} of {fileSize(storage.quotaBytes)} used
              </small>
            )}
          </Menu.Label>
          <Menu.Separator />
          <Menu.Item onSelect={() => onNavigate('Settings')}>Account settings</Menu.Item>
          <Menu.Item onSelect={() => onNavigate('Devices')}>Devices</Menu.Item>
          <Menu.Item onSelect={() => onNavigate('Storage')}>Manage storage</Menu.Item>
          <Menu.Separator />
          <Menu.Item onSelect={onSignOut}>Sign out</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
