import type { ApiClient } from '@harbor/api-client';
import {
  CHUNK_SIZE,
  FileCipher,
  HEADER_SIZE,
  encryptedSize,
  plainSize,
  type AccountKeys,
} from '../../../packages/api-client/src/e2ee';

/** Plaintext bytes [begin, end) of a stored encrypted file. */
export type PlainReader = {
  size: number;
  read: (begin: number, end: number) => Promise<Uint8Array>;
};

/** Reads a stored file's bytes by range from its signed link, signing it again once it expires. */
async function storedRanges(api: ApiClient, driveItemId: string) {
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
  return { storedSize: link.sizeBytes, fetchRange };
}

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
  const { storedSize, fetchRange } = await storedRanges(api, driveItemId);
  // The header comes with the first chunk: reads mostly start there, and a file of one chunk
  // then needs a single request.
  const head = await fetchRange(0, Math.min(storedSize, encryptedSize(CHUNK_SIZE)));
  const cipher = await FileCipher.open(keys, head.subarray(0, HEADER_SIZE));
  const size = plainSize(storedSize);
  return {
    size,
    read: async (begin, end) => {
      end = Math.min(end, size);
      if (end <= begin) return new Uint8Array();
      const r = cipher.cipherRange(size, begin, end);
      const stored =
        r.end <= head.length ? head.subarray(r.start, r.end) : await fetchRange(r.start, r.end);
      return cipher.decryptRange(size, begin, end, stored);
    },
  };
}

/** Opens an unencrypted file for reading by range. */
export async function openPlainFile(api: ApiClient, driveItemId: string): Promise<PlainReader> {
  const { storedSize: size, fetchRange } = await storedRanges(api, driveItemId);
  return {
    size,
    read: async (begin, end) => {
      end = Math.min(end, size);
      return end <= begin ? new Uint8Array() : fetchRange(begin, end);
    },
  };
}
