import { TRACKING_ID_PATTERN } from '@harbor/contracts';

/**
 * The `?ref=` of the link someone arrived through. It is kept in this browser for a while, so
 * it still counts when they sign up later from the emailed beta link, which has no `ref`.
 */
const KEY = 'harbor0.signup-ref';
const KEEP_MS = 30 * 86400_000;

/** Remembers `ref` when it is a valid tracking id; the first one seen is kept. */
export function rememberSignupRef(ref: string | null) {
  const id = ref?.trim().toLowerCase();
  if (!id || !TRACKING_ID_PATTERN.test(id) || signupRef()) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    // Storage blocked (private window): the ref still goes with this page's own requests.
  }
}

/** The remembered tracking id, if it hasn't expired. */
export function signupRef(): string | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as {
      id?: unknown;
      at?: unknown;
    } | null;
    if (typeof saved?.id !== 'string' || typeof saved.at !== 'number') return undefined;
    if (Date.now() - saved.at > KEEP_MS) {
      localStorage.removeItem(KEY);
      return undefined;
    }
    return saved.id;
  } catch {
    return undefined;
  }
}
