// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useOptimisticRemoval } from '../lib/use-optimistic-removal';
it('does not resurrect a pending restore during polling and rolls back a failed call', async () => {
  const onError = vi.fn();
  const refresh = vi.fn(async () => {});
  let reject!: (error: Error) => void;
  const save = new Promise((_, no) => {
    reject = no;
  });
  const { result, rerender } = renderHook(
    ({ items }) => useOptimisticRemoval(items, 'account', onError, refresh),
    {
      initialProps: { items: [{ id: 'a' }, { id: 'b' }] },
    },
  );
  let operation!: Promise<void>;
  act(() => {
    operation = result.current.remove([{ id: 'a' }], () => save);
  });
  expect(result.current.items).toEqual([{ id: 'b' }]);
  rerender({ items: [{ id: 'a' }, { id: 'b' }] });
  expect(result.current.items).toEqual([{ id: 'b' }]);
  await act(async () => {
    reject(new Error('offline'));
    await operation;
  });
  expect(result.current.items).toEqual([{ id: 'a' }, { id: 'b' }]);
  expect(onError).toHaveBeenCalledWith('offline');
  expect(refresh).toHaveBeenCalledOnce();
});

it('keeps confirmed removals hidden until polling confirms them, then accepts later changes', async () => {
  const { result, rerender } = renderHook(
    ({ items }) => useOptimisticRemoval(items, 'account', vi.fn(), async () => {}),
    {
      initialProps: { items: [{ id: 'a' }] },
    },
  );
  await act(async () => result.current.remove([{ id: 'a' }], async () => {}));
  expect(result.current.items).toEqual([]);
  rerender({ items: [] });
  await waitFor(() => expect(result.current.items).toEqual([]));
  rerender({ items: [{ id: 'a' }] });
  expect(result.current.items).toEqual([{ id: 'a' }]);
});
