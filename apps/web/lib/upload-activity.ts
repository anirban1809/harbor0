export type UploadPhase = 'queued' | 'hashing' | 'uploading' | 'paused' | 'done' | 'failed';

/** One file's upload. Files from a dropped or chosen folder share a `group`. */
export type FileUpload = {
  key: string;
  name: string;
  size: number;
  loaded: number;
  phase: UploadPhase;
  error?: string;
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
