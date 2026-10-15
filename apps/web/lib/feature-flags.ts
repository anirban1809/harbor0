import { useCallback, useContext, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import type { FlagKey, FlagStates } from '@harbor/contracts';

/**
 * Whether a feature still being rolled out is on for the signed-in account. Reads the flags
 * the app shell already loaded with the account, so it costs no request; off until then.
 * The server checks the same flag on the feature's own routes.
 *
 * It reads the cache rather than observing the ['me'] query: an observer without the shell's
 * queryFn would become the query's options, and the next focus refetch would fail with
 * "No queryFn was passed". Without a query client (as in component tests) every flag is off.
 */
export function useFeatureFlag(key: FlagKey) {
  const queries = useContext(QueryClientContext);
  const subscribe = useCallback(
    (changed: () => void) => queries?.getQueryCache().subscribe(changed) ?? (() => {}),
    [queries],
  );
  const read = () => queries?.getQueryData<{ flags?: FlagStates }>(['me'])?.flags?.[key] === true;
  return useSyncExternalStore(subscribe, read, () => false);
}
