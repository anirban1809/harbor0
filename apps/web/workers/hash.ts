import { createSHA256 } from 'hash-wasm';
self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const hasher = await createSHA256();
    hasher.init();
    const file = event.data;
    for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
      hasher.update(
        new Uint8Array(await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer()),
      );
      self.postMessage({ progress: Math.min(1, (offset + 4 * 1024 * 1024) / file.size) });
    }
    self.postMessage({ hash: hasher.digest() });
  } catch {
    self.postMessage({ error: 'Could not read this file.' });
  }
};
