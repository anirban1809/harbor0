// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SyncFolder } from '../src/sync-state';

const request = vi.fn();
const selectSyncLocal = vi.fn();
const addSyncRoot = vi.fn();
let SyncPage: typeof import('../src/sync-page').SyncPage;
beforeAll(async () => {
  Object.defineProperty(window, 'harbor', {
    configurable: true,
    value: { request, selectSyncLocal, addSyncRoot },
  });
  ({ SyncPage } = await import('../src/sync-page'));
});
const folder = (id: string, ownerUserId = 'me') => ({
  id,
  ownerUserId,
  name: `Folder ${id}`,
  type: 'FOLDER',
  syncDevices: [{ id: 'laptop', name: 'Laptop' }],
});
beforeEach(() => {
  request.mockReset().mockResolvedValue({
    items: [folder('here'), folder('elsewhere'), folder('theirs', 'other')],
  });
  selectSyncLocal
    .mockReset()
    .mockResolvedValue({ selectionId: 'local', path: '/local/docs', name: 'docs' });
  addSyncRoot.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

it('offers folders synced on other devices and links one to a local folder', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const root = {
    id: 'root',
    localPath: '/local/here',
    localPathDisplayName: 'here',
    remoteId: 'here',
    mode: 'sync',
    paused: false,
    excluded: [],
    fileCount: 0,
    folderCount: 0,
  } as SyncFolder;
  render(
    createElement(SyncPage, {
      roots: [root],
      jobs: [],
      state: { online: true, issues: [] } as never,
      deviceName: 'Desktop',
      accountId: 'me',
      refresh,
      openCloud: vi.fn(),
      manageStorage: vi.fn(),
    }),
  );
  await screen.findByText('Folder elsewhere');
  expect(request).toHaveBeenCalledWith({ path: '/v1/sync/folders' });
  // Already linked here, or shared by another account: not offered.
  expect(screen.queryByText('Folder here')).toBeNull();
  expect(screen.queryByText('Folder theirs')).toBeNull();
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
