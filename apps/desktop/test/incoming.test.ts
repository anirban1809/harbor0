import { expect, it, vi } from 'vitest';
import { IncomingMonitor } from '../src/incoming';

const transfer = (id: string, extra = {}) => ({ id, state: 'PENDING', ...extra });
const share = (id: string, extra = {}) => ({
  id,
  direction: 'RECEIVED',
  syncState: 'PENDING',
  ...extra,
});
function fixture() {
  let transfers = [transfer('file'), transfer('folder')];
  let shares = [share('sync')];
  const saved: string[][] = [];
  const notify = vi.fn(() => true);
  const request = vi.fn(async (path: string) => ({
    items: path.startsWith('/v1/transfers') ? transfers : shares,
  }));
  const options = {
    request,
    notify,
    seen: [] as string[],
    save: (ids: string[]) => saved.push(ids),
    active: () => true,
  };
  return {
    options,
    notify,
    request,
    saved,
    transfers: (items: any[]) => {
      transfers = items;
    },
    shares: (items: any[]) => {
      shares = items;
    },
  };
}
it('notifies for pending files, folders and sync invitations, once across polls and restarts', async () => {
  const f = fixture();
  const monitor = new IncomingMonitor(f.options);
  await monitor.poll();
  await monitor.poll();
  expect(f.notify.mock.calls).toHaveLength(3);
  expect(f.saved.at(-1)).toEqual(
    expect.arrayContaining(['transfer:file', 'transfer:folder', 'sync:sync']),
  );
  await new IncomingMonitor({ ...f.options, seen: f.saved.at(-1)! }).poll();
  expect(f.notify).toHaveBeenCalledTimes(3);
});
it('only notifies when prepared and ignores answered, expired, sent, and revoked content', async () => {
  const f = fixture();
  f.transfers([
    transfer('building', { preparationState: 'BUILDING' }),
    transfer('failed', { preparationState: 'FAILED' }),
    transfer('accepted', { state: 'ACCEPTED' }),
    transfer('expired', { expiresAt: '2000-01-01' }),
  ]);
  f.shares([
    share('sent', { direction: 'SENT' }),
    share('accepted', { syncState: 'ACCEPTED' }),
    share('revoked', { revokedAt: '2026-01-01' }),
  ]);
  const monitor = new IncomingMonitor(f.options);
  await monitor.poll();
  expect(f.notify).not.toHaveBeenCalled();
  f.transfers([transfer('building', { preparationState: 'READY' })]);
  await monitor.poll();
  expect(f.notify).toHaveBeenCalledOnce();
});
it('follows cursors even when a filtered page is empty', async () => {
  const f = fixture();
  f.shares([]);
  f.request.mockImplementation(async (path) =>
    path.includes('cursor=')
      ? { items: [transfer('last')] }
      : path.startsWith('/v1/transfers')
        ? { items: [], nextCursor: 'page two' }
        : { items: [] },
  );
  await new IncomingMonitor(f.options).poll();
  expect(f.request).toHaveBeenCalledWith('/v1/transfers/received?state=PENDING&cursor=page%20two');
  expect(f.notify).toHaveBeenCalledOnce();
});
it('retries an offline source while the other source continues', async () => {
  const f = fixture();
  f.request.mockImplementationOnce(async () => {
    throw new Error('Offline');
  });
  const monitor = new IncomingMonitor(f.options);
  await monitor.poll();
  expect(f.notify).toHaveBeenCalledTimes(1);
  await monitor.poll();
  expect(f.notify).toHaveBeenCalledTimes(3);
});
it('suppresses late responses and overlapping polls after sign-out', async () => {
  const f = fixture();
  let resolve!: (value: { items: any[] }) => void;
  // Use one deferred response for both requests.
  const response = new Promise<{ items: any[] }>((done) => {
    resolve = done;
  });
  f.request.mockImplementation(() => response);
  const monitor = new IncomingMonitor(f.options);
  const poll = monitor.poll();
  await monitor.poll();
  expect(f.request).toHaveBeenCalledTimes(2);
  monitor.stop();
  resolve({ items: [transfer('late'), share('late')] });
  await poll;
  expect(f.notify).not.toHaveBeenCalled();
  expect(f.saved).toEqual([]);
});
it('keeps account notification history separate and retries unsupported notifications', async () => {
  const f = fixture();
  f.notify.mockReturnValue(false);
  const monitor = new IncomingMonitor(f.options);
  await monitor.poll();
  expect(f.saved).toEqual([]);
  f.notify.mockReturnValue(true);
  await monitor.poll();
  expect(f.saved.at(-1)).toHaveLength(3);
  f.notify.mockClear();
  await new IncomingMonitor({ ...f.options, seen: [] }).poll();
  expect(f.notify).toHaveBeenCalledTimes(3);
});
it('does no work during an account transition', async () => {
  const f = fixture();
  await new IncomingMonitor({ ...f.options, active: () => false }).poll();
  expect(f.request).not.toHaveBeenCalled();
});
it('only remembers a notification after the OS confirms it was shown', async () => {
  const f = fixture();
  f.transfers([transfer('file')]);
  f.shares([]);
  let shown!: (value: boolean) => void;
  const notify = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        shown = resolve;
      }),
  );
  const monitor = new IncomingMonitor({ ...f.options, notify });
  const first = monitor.poll();
  await Promise.resolve();
  expect(f.saved).toEqual([]);
  shown(false);
  await first;
  expect(f.saved).toEqual([]);
  const second = monitor.poll();
  await Promise.resolve();
  shown(true);
  await second;
  expect(f.saved).toEqual([['transfer:file']]);
});
it('does not save an OS acknowledgement that arrives after sign-out', async () => {
  const f = fixture();
  f.transfers([transfer('file')]);
  f.shares([]);
  let shown!: (value: boolean) => void;
  const monitor = new IncomingMonitor({
    ...f.options,
    notify: () =>
      new Promise<boolean>((resolve) => {
        shown = resolve;
      }),
  });
  const poll = monitor.poll();
  await Promise.resolve();
  monitor.stop();
  shown(true);
  await poll;
  expect(f.saved).toEqual([]);
});
it('retries alerts rejected by the OS without replaying successful alerts', async () => {
  const f = fixture();
  const monitor = new IncomingMonitor(f.options);
  await monitor.poll();
  monitor.retry({ kind: 'transfer', item: transfer('file') } as any);
  expect(f.saved.at(-1)).not.toContain('transfer:file');
  f.notify.mockClear();
  await monitor.poll();
  expect(f.notify).toHaveBeenCalledExactlyOnceWith({ kind: 'transfer', item: transfer('file') });
});
