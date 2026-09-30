// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IncomingContent } from '../src/incoming';

const request = vi.fn();
const selectSyncLocal = vi.fn();
const addSyncRoot = vi.fn();
let IncomingDialog: typeof import('../src/incoming-dialog').IncomingDialog;
beforeAll(async () => {
  Object.defineProperty(window, 'harbor', {
    configurable: true,
    value: { request, selectSyncLocal, addSyncRoot },
  });
  ({ IncomingDialog } = await import('../src/incoming-dialog'));
});
beforeEach(() => {
  request.mockReset().mockResolvedValue({});
  selectSyncLocal
    .mockReset()
    .mockResolvedValue({ selectionId: 'local', path: '/local/team', name: 'team' });
  addSyncRoot.mockReset().mockResolvedValue({});
});
afterEach(cleanup);
function show(kind: 'transfer' | 'sync') {
  const close = vi.fn();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const content = {
    kind,
    item:
      kind === 'transfer'
        ? {
            id: 'transfer',
            displayNames: ['Photos'],
            sender: { displayName: 'Alice', username: 'alice' },
            items: [],
          }
        : {
            id: 'share',
            name: 'Team folder',
            driveItemId: 'folder',
            syncState: 'PENDING',
            owner: { displayName: 'Alice', username: 'alice' },
          },
  } as IncomingContent;
  render(createElement(IncomingDialog, { content, close, refresh }));
  return { close, refresh };
}
it.each([
  ['Accept', 'accept'],
  ['Reject', 'decline'],
])('responds to a received transfer with %s', async (label, action) => {
  const { close, refresh } = show('transfer');
  fireEvent.click(screen.getByRole('button', { name: label }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      path: `/v1/transfers/transfer/${action}`,
      method: 'POST',
      body: { operationId: expect.any(String) },
    }),
  );
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(refresh).toHaveBeenCalledOnce();
});
it('keeps failed responses visible and allows retry', async () => {
  request.mockRejectedValueOnce(new Error('Connection lost'));
  const { close } = show('transfer');
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Connection lost');
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
it('rejects a sync invitation without choosing or touching a local folder', async () => {
  const { close } = show('sync');
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith({
    path: '/v1/sync/shares/share/respond',
    method: 'POST',
    body: { action: 'DECLINED' },
  });
  expect(selectSyncLocal).not.toHaveBeenCalled();
  expect(addSyncRoot).not.toHaveBeenCalled();
});
it('requires a folder before accepting and starting shared sync', async () => {
  const { close } = show('sync');
  expect(
    (screen.getByRole('button', { name: 'Accept and start syncing' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Choose local folder' }));
  await screen.findByText('/local/team');
  fireEvent.click(screen.getByRole('button', { name: 'Accept and start syncing' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith({
    path: '/v1/sync/shares/share/respond',
    method: 'POST',
    body: { action: 'ACCEPTED' },
  });
  expect(addSyncRoot).toHaveBeenCalledWith({
    selectionId: 'local',
    cloudFolderId: 'folder',
    shareId: 'share',
  });
});
