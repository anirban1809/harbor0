/** A file to upload plus the folder path (relative to the drop target) it belongs in. */
export type UploadEntry = { file: File; folders: string[] };

/**
 * Expands a drop into files, walking any dropped folders so their contents keep their layout.
 * `webkitGetAsEntry` must be called synchronously inside the drop handler, before the
 * DataTransfer is cleared, so call this directly from `onDrop` and await the result after.
 */
export function readDroppedFiles(data: DataTransfer): Promise<UploadEntry[]> {
  const entries = Array.from(data.items, (item) =>
    item.kind === 'file' ? item.webkitGetAsEntry?.() : null,
  );
  // Browsers without the entries API only expose top-level files.
  if (!entries.some(Boolean)) return Promise.resolve(filesOnly(data.files));
  return Promise.all(entries.map((entry) => (entry ? walk(entry, []) : []))).then((groups) =>
    groups.flat(),
  );
}

export function filesOnly(files: FileList | File[]): UploadEntry[] {
  return Array.from(files, (file) => ({ file, folders: [] }));
}

async function walk(entry: FileSystemEntry, folders: string[]): Promise<UploadEntry[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    return [{ file, folders }];
  }
  if (!entry.isDirectory) return [];
  const path = [...folders, entry.name];
  const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
  const nested = await Promise.all(children.map((child) => walk(child, path)));
  return nested.flat();
}

// readEntries returns results in batches (100 in Chrome) until it yields an empty array.
async function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) return all;
    all.push(...batch);
  }
}
