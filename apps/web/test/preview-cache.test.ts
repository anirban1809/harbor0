// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FilePreview } from '../components/file-preview';
import { clearBrowserCaches } from '../lib/browser-cache';
import type { FileEntry } from '../lib/file-metadata';
const item: FileEntry = { id: 'text', name: 'notes.txt', type: 'FILE', sizeBytes: 4, revision: 1 };
afterEach(() => {
  cleanup();
  clearBrowserCaches();
});

it('reuses text previews on reopen but loads new revisions and other accounts separately', async () => {
  const load = vi.fn(async () => ({ text: 'body', truncated: false }));
  const props = { item, load, cacheScope: 'account-a', onClose: vi.fn(), onDownload: vi.fn() };
  const first = render(createElement(FilePreview, props));
  await screen.findByText('body');
  first.unmount();
  const second = render(createElement(FilePreview, props));
  expect(screen.getByText('body')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
  second.rerender(createElement(FilePreview, { ...props, item: { ...item, revision: 2 } }));
  await screen.findByText('body');
  expect(load).toHaveBeenCalledTimes(2);
  second.rerender(createElement(FilePreview, { ...props, cacheScope: 'account-b' }));
  await screen.findByText('body');
  expect(load).toHaveBeenCalledTimes(3);
});

it('shares an in-flight preview across closing and reopening', async () => {
  let resolve!: (value: { text: string; truncated: boolean }) => void;
  const load = vi.fn(
    () =>
      new Promise<{ text: string; truncated: boolean }>((done) => {
        resolve = done;
      }),
  );
  const props = { item, load, cacheScope: 'a', onClose: vi.fn(), onDownload: vi.fn() };
  const first = render(createElement(FilePreview, props));
  await act(async () => {
    await Promise.resolve();
  });
  first.unmount();
  render(createElement(FilePreview, props));
  await act(async () => resolve({ text: 'finished', truncated: false }));
  expect(screen.getByText('finished')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
});

it('retries media with a new signed link after a playback error', async () => {
  const load = vi.fn(async () => ({
    url: `https://example.test/image-${load.mock.calls.length}.png`,
  }));
  render(
    createElement(FilePreview, {
      item: { ...item, name: 'photo.png', mimeType: 'image/png' },
      load,
      cacheScope: 'a',
      onClose: vi.fn(),
      onDownload: vi.fn(),
    }),
  );
  fireEvent.error(await screen.findByRole('img'));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  const image = await screen.findByRole('img');
  expect(image.getAttribute('src')).toBe('https://example.test/image-2.png');
  expect(load).toHaveBeenCalledTimes(2);
});
