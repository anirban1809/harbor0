import { useQuery } from '@tanstack/react-query';
import type { FlagKey, FlagStates } from '@harbor/contracts';

/**
 * Whether a feature still being rolled out is on for the signed-in account. Reads the flags
 * the app shell already loaded with the account, so it costs no request; off until then.
 * The server checks the same flag on the feature's own routes.
 */
export function useFeatureFlag(key: FlagKey) {
  const me = useQuery<{ flags?: FlagStates }>({ queryKey: ['me'], enabled: false });
  return me.data?.flags?.[key] === true;
}
