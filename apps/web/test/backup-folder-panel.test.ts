// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiClient } from '@harbor/api-client';
import { BackupFolderPanel, type BackupDesktop } from '../components/backup-folder-panel';

afterEach(cleanup);

const root = {
  id: 'b1',
  remoteRootDriveItemId: 'folder-1',
  localPathDisplayName: 'Documents',
  deviceName: 'Studio Mac',
  state: 'ACTIVE',
};
const run = {
  id: 'r1',
  state: 'COMPLETED',
  trigger: 'AUTOMATIC',
  startedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  completedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  fileCount: 3,
  sizeBytes: 2048,
};
function api(backups = [root]) {
  const request = vi.fn(async (path: string) => {
    if (path === '/v1/backups') return { items: backups };
    if (path.endsWith('/runs')) return { items: [run] };
    if (path.endsWith('/restores')) return { items: [] };
    throw new Error(`Unexpected ${path}`);
  });
  return { request } as unknown as ApiClient & { request: typeof request };
}

it('shows nothing for a folder that is not a backup', async () => {
  const client = api();
  const { container } = render(
    createElement(BackupFolderPanel, { api: client, folderId: 'other' }),
  );
  await waitFor(() => expect(client.request).toHaveBeenCalledWith('/v1/backups'));
  expect(container.innerHTML).toBe('');
});

it('on the web, shows the status and points to the source computer for controls', async () => {
  render(createElement(BackupFolderPanel, { api: api(), folderId: 'folder-1' }));
  await screen.findByText('Backed up');
  screen.getByText(/To back up now, pause or archive, open the desktop app on Studio Mac/);
  expect(screen.queryByRole('button', { name: 'Back up now' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /History/ }));
  await screen.findByText(/Automatic backup/);
});

it('on the computer that backs it up, offers back up now and pause', async () => {
  const desktop: BackupDesktop = {
    roots: [{ id: 'local-1', remoteId: 'folder-1', paused: false }],
    backup: vi.fn(async () => ({ changes: 2 })),
    disconnect: vi.fn(),
    archive: vi.fn(),
    setPaused: vi.fn(async () => {}),
    download: vi.fn(),
    options: vi.fn(),
    refresh: vi.fn(async () => {}),
  };
  render(createElement(BackupFolderPanel, { api: api(), folderId: 'folder-1', desktop }));
  fireEvent.click(await screen.findByRole('button', { name: 'Back up now' }));
  await screen.findByText('Backing up 2 changed files.');
  expect(desktop.backup).toHaveBeenCalledWith('local-1');
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(desktop.setPaused).toHaveBeenCalledWith(desktop.roots[0], true));
});
