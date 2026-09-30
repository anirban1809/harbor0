'use client';
import { useEffect, useMemo, useReducer, useRef } from 'react';

/** Hide restored/deleted trash rows immediately, including during background polling. */
export function useOptimisticRemoval<T extends { id: string }>(
  items: T[],
  scope: string,
  onError: (message: string) => void,
  refresh: () => Promise<unknown>,
) {
  const hidden = useMemo(() => new Map<string, boolean>(), [scope]);
  const active = useRef(hidden);
  active.current = hidden;
  const [, changed] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    let removed = false;
    for (const [id, pending] of hidden) {
      if (!pending && !items.some((item) => item.id === id)) {
        hidden.delete(id);
        removed = true;
      }
    }
    if (removed) changed();
  }, [items, hidden]);
  async function remove(targets: T[], save: () => Promise<unknown>) {
    if (targets.some((item) => hidden.has(item.id))) return;
    targets.forEach((item) => hidden.set(item.id, true));
    changed();
    try {
      await save();
      targets.forEach((item) => hidden.set(item.id, false));
    } catch (error) {
      targets.forEach((item) => hidden.delete(item.id));
      if (active.current === hidden) onError((error as Error).message);
    } finally {
      if (active.current === hidden) {
        changed();
        void refresh().catch((error) => onError((error as Error).message));
      }
    }
  }
  return { items: items.filter((item) => !hidden.has(item.id)), remove };
}
