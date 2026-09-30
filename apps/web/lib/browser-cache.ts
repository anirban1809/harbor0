/** Bounded, session-only LRU cache. Never persists file names, contents or signed URLs. */
export class BrowserCache<T> {
  private entries = new Map<string, { value: T; expires: number }>();
  private pending = new Map<string, Promise<T>>();
  private generation = 0;

  constructor(
    private capacity = 80,
    private lifetime = 5 * 60_000,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= Date.now()) {
      this.entries.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, lifetime = this.lifetime) {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + lifetime });
    while (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
  }

  async load(key: string, loader: () => Promise<T>, lifetime = this.lifetime): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        // Invalidating during a request must not let its old response repopulate the cache.
        if (generation === this.generation) this.set(key, value, lifetime);
        return value;
      });
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    }
  }

  delete(key: string) {
    this.generation++;
    this.entries.delete(key);
    this.pending.delete(key);
  }

  clear() {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
  }
}

// Transport identity and account ID both form the isolation boundary.
let sessions = new WeakMap<
  object,
  Map<string, { data: BrowserCache<any>; views: BrowserCache<any> }>
>();
const cleaners = new Set<() => void>();
export function browserSession(transport: object, account: string) {
  let accounts = sessions.get(transport);
  if (!accounts) sessions.set(transport, (accounts = new Map()));
  let session = accounts.get(account);
  if (!session) {
    session = { data: new BrowserCache(160, 15_000), views: new BrowserCache(40) };
    accounts.set(account, session);
    if (accounts.size > 4) accounts.delete(accounts.keys().next().value!);
  }
  return session;
}
export function onBrowserCacheClear(clear: () => void) {
  cleaners.add(clear);
}
export function clearBrowserCaches() {
  sessions = new WeakMap();
  for (const clear of cleaners) clear();
}

export type OptimisticChange<T> = { item: T; pending: boolean };
/** Apply changes by item, so rolling back one save never rolls back an unrelated save. */
export function applyOptimisticItems<
  T extends { id: string; parentId: string | null; deletedAt?: string | null },
>(
  items: T[],
  changes: Map<string, OptimisticChange<T>>,
  parentId: string | null,
  search = false,
): T[] {
  const result = new Map(items.map((item) => [item.id, item]));
  for (const [id, { item }] of changes) {
    if (item.deletedAt || (!search && item.parentId !== parentId)) result.delete(id);
    else if (result.has(id) || (!search && item.parentId === parentId)) result.set(id, item);
  }
  return [...result.values()];
}
