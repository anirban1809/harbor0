// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SyncFolderItem } from '@harbor/contracts';
import type { SyncFolder } from '../src/sync-state';

const selectSyncLocal = vi.fn();
const addSyncRoot = vi.fn();
const rootSettings = vi.fn();
let SyncFolderPanel: typeof import('../src/sync-page').SyncFolderPanel;
beforeAll(async () => {
  Object.defineProperty(window, 'harbor', {
    configurable: true,
    value: { selectSyncLocal, addSyncRoot, rootSettings },
  });
  ({ SyncFolderPanel } = await import('../src/sync-page'));
});
beforeEach(() => {
  selectSyncLocal
    .mockReset()
    .mockResolvedValue({ selectionId: 'local', path: '/local/docs', name: 'docs' });
  addSyncRoot.mockReset().mockResolvedValue({});
  rootSettings.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

const state = { online: true, paused: false, issues: [] } as never;

it('offers a folder synced on another device and links it to a local folder', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const remote = {
    id: 'elsewhere',
    ownerUserId: 'me',
    name: 'Folder elsewhere',
    type: 'FOLDER',
    syncDevices: [{ id: 'laptop', name: 'Laptop' }],
  } as unknown as SyncFolderItem;
  render(
    createElement(SyncFolderPanel, {
      remote,
      state,
      jobs: [],
      refresh,
      manageStorage: vi.fn(),
    }),
  );
  screen.getByText('Not synced on this computer');
  screen.getByText(/Synced on Laptop/);
  fireEvent.click(screen.getByRole('button', { name: 'Sync to this computer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose local folder' }));
  await screen.findByText('/local/docs');
  fireEvent.click(screen.getByRole('button', { name: 'Start syncing' }));
  await waitFor(() =>
    expect(addSyncRoot).toHaveBeenCalledWith({
      selectionId: 'local',
      rootId: undefined,
      cloudFolderId: 'elsewhere',
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

it('shows a folder synced here with its status and pauses it', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const root = {
    id: 'root',
    localPath: '/local/here',
    localPathDisplay: '~/here',
    localPathDisplayName: 'here',
    remoteId: 'here',
    mode: 'sync',
    paused: false,
    excluded: ['node_modules'],
    fileCount: 0,
    folderCount: 0,
  } as unknown as SyncFolder;
  render(
    createElement(SyncFolderPanel, { root, state, jobs: [], refresh, manageStorage: vi.fn() }),
  );
  screen.getByText('Synced on this computer');
  screen.getByText('Up to date');
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() =>
    expect(rootSettings).toHaveBeenCalledWith({
      id: 'root',
      paused: true,
      excluded: ['node_modules'],
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

it('shows nothing for a folder that is not synced anywhere', () => {
  const { container } = render(
    createElement(SyncFolderPanel, { state, jobs: [], refresh: vi.fn(), manageStorage: vi.fn() }),
  );
  expect(container.innerHTML).toBe('');
});
