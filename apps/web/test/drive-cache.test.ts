// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DriveItem } from '@harbor/contracts';
import { DriveWorkspace } from '../components/drive-workspace';
import { clearBrowserCaches } from '../lib/browser-cache';

const item = (id: string): DriveItem => ({
  id,
  name: `${id}.txt`,
  normalizedName: `${id}.txt`,
  parentId: null,
  type: 'FILE',
  ownerUserId: 'user',
  sizeBytes: 10,
  mimeType: 'text/plain',
  currentVersionId: 'v1',
  revision: 1,
  favorite: false,
  deletedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});
const defaults = {
  onActivity: vi.fn(),
  parentId: null,
  trail: [],
  breadcrumbs: null,
  query: '',
  onClearSearch: vi.fn(),
  userId: 'user',
  onOpen: vi.fn(),
  onUpload: vi.fn(),
  onDropFiles: vi.fn(),
  onDownload: vi.fn(),
  onChanged: vi.fn(),
  onManageStorage: vi.fn(),
  onRoot: vi.fn(),
};
afterEach(() => {
  cleanup();
  clearBrowserCaches();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it('shows the first page at once, then loads the rest of a big folder without hiding it', async () => {
  // The default sort (newest first) is only right over the whole folder, so later pages load
  // in the background; name order alone would page on demand instead.
  const second = deferred<{ items: DriveItem[]; nextCursor: null }>();
  const request = vi.fn(async (path: string) => {
    if (path.includes('cursor=second')) return second.promise;
    if (path.endsWith('/children')) return { items: [item('first')], nextCursor: 'second' };
    return { items: [], nextCursor: null };
  });
  render(createElement(DriveWorkspace, { ...defaults, request }));
  await screen.findByRole('button', { name: 'first.txt' });
  await waitFor(() =>
    expect(request.mock.calls.some(([path]) => path.includes('cursor=second'))).toBe(true),
  );
  expect(screen.getByRole('button', { name: 'first.txt' })).toBeTruthy();
  expect(screen.queryByLabelText('Loading files')).toBeNull();
  await act(async () => second.resolve({ items: [item('second')], nextCursor: null }));
  expect(await screen.findByRole('button', { name: 'second.txt' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'first.txt' })).toBeTruthy();
});

it('uses cached folders after remount and preserves them if background refresh fails', async () => {
  let fail = false;
  const request = vi.fn(async (path: string) => {
    if (fail) throw new Error('offline');
    if (path.endsWith('/children')) return { items: [item('cached')], nextCursor: null };
    return { items: [], nextCursor: null };
  });
  const first = render(createElement(DriveWorkspace, { ...defaults, request }));
  await screen.findByRole('button', { name: 'cached.txt' });
  first.unmount();
  fail = true;
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 20_000);
  render(createElement(DriveWorkspace, { ...defaults, request }));
  expect(screen.getByRole('button', { name: 'cached.txt' })).toBeTruthy();
  await screen.findByText('offline');
  expect(screen.getByRole('button', { name: 'cached.txt' })).toBeTruthy();
  vi.restoreAllMocks();
});

it('shows a new folder immediately and rolls it back on a failed background save', async () => {
  const save = deferred<unknown>();
  const request = vi.fn(async (_path: string, init?: { method?: string }) =>
    init?.method === 'POST' ? save.promise : { items: [], nextCursor: null },
  );
  render(createElement(DriveWorkspace, { ...defaults, request }));
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'New folder' })[0].hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getAllByRole('button', { name: 'New folder' })[0]);
  fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), {
    target: { value: 'Instant folder' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect(await screen.findByRole('button', { name: 'Instant folder' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull();
  await act(async () => save.reject(new Error('Storage unavailable')));
  await screen.findByText(/Could not create “Instant folder”. Storage unavailable/);
  expect(screen.queryByRole('button', { name: 'Instant folder' })).toBeNull();
});

it('renames before the API returns and restores the old name when it fails', async () => {
  const save = deferred<unknown>();
  const request = vi.fn(async (path: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') return save.promise;
    return { items: path.endsWith('/children') ? [item('original')] : [], nextCursor: null };
  });
  render(createElement(DriveWorkspace, { ...defaults, request }));
  const open = await screen.findByRole('button', { name: 'original.txt' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select original.txt' }));
  fireEvent.keyDown(open, { key: 'F2' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Renamed.txt' },
  });
  fireEvent.submit(screen.getByRole('textbox', { name: 'Name' }).closest('form')!);
  expect(await screen.findByRole('button', { name: 'Renamed.txt' })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => save.reject(new Error('Revision conflict')));
  expect(await screen.findByRole('button', { name: 'original.txt' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Renamed.txt' })).toBeNull();
});

it('does not treat an interrupted initial catalog load as a successful cached catalog', async () => {
  const catalog = deferred<unknown>();
  const request = vi.fn(async (path: string) => {
    if (path === '/v1/sync/folders') return catalog.promise;
    return { items: path.endsWith('/children') ? [item('private')] : [], nextCursor: null };
  });
  const view = render(createElement(DriveWorkspace, { ...defaults, request, refreshKey: 1 }));
  view.rerender(createElement(DriveWorkspace, { ...defaults, request, refreshKey: 2 }));
  await act(async () => catalog.reject(new Error('Catalog unavailable')));
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'private.txt' })).toBeNull();
});

it('keeps a successful save when another file in the same delete batch fails', async () => {
  const failed = deferred<unknown>();
  let current = [item('first'), item('second')];
  const request = vi.fn(async (path: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') {
      if (path.endsWith('/second')) return failed.promise;
      current = current.filter((file) => file.id !== 'first');
      return { item: { ...item('first'), deletedAt: '2026-09-30T00:00:00Z' } };
    }
    return { items: path.endsWith('/children') ? current : [], nextCursor: null };
  });
  render(createElement(DriveWorkspace, { ...defaults, request }));
  await screen.findByRole('button', { name: 'first.txt' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select first.txt' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select second.txt' }));
  fireEvent.keyDown(screen.getByRole('button', { name: 'second.txt' }), {
    key: 'Delete',
  });
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  expect(screen.queryByRole('button', { name: 'first.txt' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'second.txt' })).toBeNull();
  await act(async () => failed.reject(new Error('Conflict')));
  expect(await screen.findByRole('button', { name: 'second.txt' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'first.txt' })).toBeNull();
});

it('ignores a stale folder response that arrives after a newer rename succeeds', async () => {
  let current = item('original');
  let delayed = false;
  const stale = deferred<{ items: DriveItem[]; nextCursor: null }>();
  const request = vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === 'PATCH') {
      current = { ...current, name: 'Latest.txt', revision: 2 };
      delayed = false;
      return { item: current };
    }
    if (path.endsWith('/children')) {
      if (delayed) return stale.promise;
      return { items: [current], nextCursor: null };
    }
    return { items: [], nextCursor: null };
  });
  render(createElement(DriveWorkspace, { ...defaults, request }));
  const open = await screen.findByRole('button', { name: 'original.txt' });
  delayed = true;
  fireEvent.focus(window);
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select original.txt' }));
  fireEvent.keyDown(open, { key: 'F2' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Latest.txt' },
  });
  fireEvent.submit(screen.getByRole('textbox', { name: 'Name' }).closest('form')!);
  await screen.findByRole('button', { name: 'Latest.txt' });
  await act(async () => stale.resolve({ items: [item('original')], nextCursor: null }));
  expect(screen.getByRole('button', { name: 'Latest.txt' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'original.txt' })).toBeNull();
});
