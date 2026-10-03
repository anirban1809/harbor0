'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Cloud, HardDrive, Laptop, Menu, Settings, Trash2, Users } from 'lucide-react';
import type { StorageUsage } from '@harbor/contracts';
import { workspaceRoutes, type WorkspaceSection } from '../lib/routes';
import { Drawer } from './ui/dialog';
import { FolderActivityStatus, StorageIndicator, type FolderActivity } from './drive-account';
import { ThemeToggle } from './theme-toggle';

const tabs: { name: WorkspaceSection; label: string; icon: LucideIcon }[] = [
  { name: 'My Drive', label: 'Drive', icon: HardDrive },
  { name: 'Shared', label: 'Shared', icon: Users },
  { name: 'Trash', label: 'Trash', icon: Trash2 },
];
const more: { name: WorkspaceSection; icon: LucideIcon; hint: string }[] = [
  { name: 'Devices', icon: Laptop, hint: 'Computers and phones signed in' },
  { name: 'Storage', icon: Cloud, hint: 'Usage and plan' },
  { name: 'Settings', icon: Settings, hint: 'Profile and appearance' },
];

/** Phone navigation: a bottom tab bar, with the less frequent pages in a “More” sheet. */
export function MobileTabBar({
  section,
  storage,
  onNavigate,
  onManageStorage,
  activity = null,
  onOpenActivity,
}: {
  section: WorkspaceSection;
  storage?: StorageUsage | null;
  onNavigate: () => void;
  onManageStorage: () => void;
  activity?: FolderActivity | null;
  onOpenActivity?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const inMore = !tabs.some((tab) => tab.name === section);
  return (
    <>
      <nav className="mobile-tabbar" aria-label="Tab bar">
        {tabs.map(({ name, label, icon: Icon }) => (
          <Link
            key={name}
            href={workspaceRoutes[name]}
            onNavigate={onNavigate}
            className="mobile-tab"
            aria-current={section === name ? 'page' : undefined}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </Link>
        ))}
        <button
          className="mobile-tab"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-active={inMore || undefined}
          onClick={() => setOpen(true)}
        >
          <Menu aria-hidden="true" />
          <span>More</span>
        </button>
      </nav>
      <Drawer open={open} onOpenChange={setOpen} title="More" className="mobile-more-sheet">
        <nav className="mobile-more-links" aria-label="More pages">
          {more.map(({ name, icon: Icon, hint }) => (
            <Link
              key={name}
              href={workspaceRoutes[name]}
              onNavigate={() => {
                onNavigate();
                setOpen(false);
              }}
              className="mobile-more-link"
              aria-current={section === name ? 'page' : undefined}
            >
              <span className="icon-tile">
                <Icon aria-hidden="true" />
              </span>
              <span className="list-row-text">
                <strong>{name}</strong>
                <small>{hint}</small>
              </span>
            </Link>
          ))}
        </nav>
        <div className="mobile-more-theme">
          <span>Theme</span>
          <ThemeToggle />
        </div>
        <FolderActivityStatus
          activity={activity}
          onOpen={() => {
            setOpen(false);
            onOpenActivity?.();
          }}
        />
        <StorageIndicator
          storage={storage}
          onManage={() => {
            setOpen(false);
            onManageStorage();
          }}
        />
      </Drawer>
    </>
  );
}
