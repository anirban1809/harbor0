export type UploadPhase = 'queued' | 'hashing' | 'uploading' | 'paused' | 'done' | 'failed';

/** One file's upload. Files from a dropped or chosen folder share a `group`. */
export type FileUpload = {
  key: string;
  name: string;
  size: number;
  loaded: number;
  phase: UploadPhase;
  error?: string;
  /** Failed because the folder already has an item with this name: a file can be replaced. */
  conflict?: 'file' | 'folder';
  group?: { key: string; name: string };
};

/** A row in the upload card: a single file, or a whole folder rolled up. */
export type UploadActivity = {
  key: string;
  kind: 'file' | 'folder';
  name: string;
  size: number;
  loaded: number;
  phase: UploadPhase;
  error?: string;
  files: number;
  filesDone: number;
  filesFailed: number;
  /** The file keys this row covers, for pausing, resuming or cancelling them together. */
  keys: string[];
  /** Failed files whose name is taken, to replace or keep both. */
  conflictKeys: string[];
  /** Every name conflict is with a file, so replacing is possible. */
  replaceable: boolean;
};

const active = (phase: UploadPhase) => phase === 'hashing' || phase === 'uploading';

export function summarizeUploads(uploads: FileUpload[]): UploadActivity[] {
  const groups = new Map<string, FileUpload[]>();
  for (const upload of uploads) {
    const key = upload.group?.key ?? upload.key;
    groups.set(key, [...(groups.get(key) ?? []), upload]);
  }
  return Array.from(groups, ([key, members]) => {
    const [first] = members;
    const phases = members.map((m) => m.phase);
    const phase: UploadPhase = !first.group
      ? first.phase
      : phases.some(active)
        ? 'uploading'
        : phases.includes('paused')
          ? 'paused'
          : phases.includes('queued')
            ? 'queued'
            : phases.includes('failed')
              ? 'failed'
              : 'done';
    return {
      key,
      kind: first.group ? 'folder' : 'file',
      name: first.group?.name ?? first.name,
      size: members.reduce((sum, m) => sum + m.size, 0),
      loaded: members.reduce((sum, m) => sum + (m.phase === 'done' ? m.size : m.loaded), 0),
      phase,
      error: members.find((m) => m.phase === 'failed')?.error,
      files: members.length,
      filesDone: phases.filter((p) => p === 'done').length,
      filesFailed: phases.filter((p) => p === 'failed').length,
      keys: members.map((m) => m.key),
      conflictKeys: members.filter((m) => m.phase === 'failed' && m.conflict).map((m) => m.key),
      replaceable: members.every((m) => m.phase !== 'failed' || m.conflict !== 'folder'),
    };
  });
}

/** Applies updates to an upload list by key, appending uploads it hasn't seen. */
export function mergeUploads(list: FileUpload[], updates: FileUpload[]): FileUpload[] {
  const byKey = new Map(updates.map((u) => [u.key, u]));
  const merged = list.map((u) => {
    const update = byKey.get(u.key);
    byKey.delete(u.key);
    return update ?? u;
  });
  return byKey.size ? [...merged, ...byKey.values()] : merged;
}

/** Keys of files whose row has finished (uploaded or failed), for dismissing them together. */
export function finishedKeys(uploads: FileUpload[]): Set<string> {
  return new Set(
    summarizeUploads(uploads)
      .filter((a) => a.phase === 'done' || a.phase === 'failed')
      .flatMap((a) => a.keys),
  );
}

export type UploadTotals = {
  files: number;
  done: number;
  failed: number;
  paused: number;
  /** Files still queued or transferring. */
  pending: number;
  size: number;
  loaded: number;
};

/** File-level totals across every upload in the card, for the header summary. */
export function uploadTotals(uploads: FileUpload[]): UploadTotals {
  const totals = {
    files: uploads.length,
    done: 0,
    failed: 0,
    paused: 0,
    pending: 0,
    size: 0,
    loaded: 0,
  };
  for (const u of uploads) {
    totals.size += u.size;
    totals.loaded += u.phase === 'done' ? u.size : u.loaded;
    if (u.phase === 'done') totals.done++;
    else if (u.phase === 'failed') totals.failed++;
    else if (u.phase === 'paused') totals.paused++;
    else totals.pending++;
  }
  return totals;
}

const rank: Record<UploadPhase, number> = {
  uploading: 0,
  hashing: 0,
  failed: 1,
  paused: 2,
  queued: 3,
  done: 4,
};

/** Rows in display order: transferring first, then failed, paused, waiting, finished. */
export function orderActivity(activity: UploadActivity[]): UploadActivity[] {
  return activity
    .map((a, i) => [a, i] as const)
    .sort(([a, i], [b, j]) => rank[a.phase] - rank[b.phase] || i - j)
    .map(([a]) => a);
}

export type RateSample = { at: number; loaded: number };

/** Bytes per second over the samples, or null until there's at least a second of history. */
export function transferRate(samples: RateSample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const seconds = (last.at - first.at) / 1000;
  if (seconds < 1) return null;
  const rate = (last.loaded - first.loaded) / seconds;
  return rate > 0 ? rate : null;
}
