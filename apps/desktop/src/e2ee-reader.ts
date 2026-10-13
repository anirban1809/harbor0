import type { ApiClient } from '@harbor/api-client';
import {
  FileCipher,
  HEADER_SIZE,
  plainSize,
  type AccountKeys,
} from '../../../packages/api-client/src/e2ee';

/** Plaintext bytes [begin, end) of a stored encrypted file. */
export type PlainReader = {
  size: number;
  read: (begin: number, end: number) => Promise<Uint8Array>;
};

/**
 * Opens an encrypted file for reading by range, for previews: only the chunks a range touches
 * are downloaded and decrypted. Download links expire after a few minutes; an expired one is
 * signed again once.
 */
export async function openEncryptedFile(
  api: ApiClient,
  driveItemId: string,
  keys: AccountKeys,
): Promise<PlainReader> {
  let link = await api.download({ driveItemId });
  const fetchRange = async (begin: number, end: number): Promise<Uint8Array> => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(link.downloadUrl, {
        headers: { Range: `bytes=${begin}-${end - 1}` },
        signal: AbortSignal.timeout(60_000),
      });
      if ((response.status === 403 || response.status === 400) && attempt === 0) {
        await response.body?.cancel();
        link = await api.download({ driveItemId });
        continue;
      }
      if (!response.ok) throw new Error(`Could not read the file (${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      // Storage that ignores Range sends the whole file.
      return response.status === 200 ? bytes.subarray(begin, end) : bytes;
    }
  };
  const cipher = await FileCipher.open(keys, await fetchRange(0, HEADER_SIZE));
  const size = plainSize(link.sizeBytes);
  return {
    size,
    read: async (begin, end) => {
      end = Math.min(end, size);
      if (end <= begin) return new Uint8Array();
      const r = cipher.cipherRange(size, begin, end);
      return cipher.decryptRange(size, begin, end, await fetchRange(r.start, r.end));
    },
  };
}
