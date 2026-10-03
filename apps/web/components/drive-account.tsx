'use client';
import type { StorageUsage } from '@harbor/contracts';
import { AlertCircle, CheckCircle2, Pause, RefreshCw } from 'lucide-react';
import { fileSize } from '../lib/file-metadata';
import { FolderProgress } from './folder-progress';
import { Button } from './ui/button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './ui/menu';
import { Progress } from './ui/progress';

/** How sync and backups are doing overall, for the line above the storage meter. */
export type FolderActivity = {
  tone: 'ok' | 'busy' | 'paused' | 'error';
  label: string;
  percent?: number;
};

/** One line in the sidebar for sync and backups; it opens the folders it is about. */
export function FolderActivityStatus({
  activity,
  onOpen,
}: {
  activity: FolderActivity | null;
  onOpen: () => void;
}) {
  if (!activity) return null;
  const Icon =
    activity.tone === 'ok'
      ? CheckCircle2
      : activity.tone === 'busy'
        ? RefreshCw
        : activity.tone === 'paused'
          ? Pause
          : AlertCircle;
  return (
    <button
      className="folder-activity"
      data-tone={activity.tone}
      onClick={onOpen}
      title={activity.label}
      role="status"
      aria-live="polite"
    >
      <span className="folder-activity-label">
        <Icon aria-hidden="true" className={activity.tone === 'busy' ? 'spin' : undefined} />
        <span>{activity.label}</span>
      </span>
      {activity.percent !== undefined && (
        <FolderProgress percent={activity.percent} label={activity.label} showValue={false} />
      )}
    </button>
  );
}

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
