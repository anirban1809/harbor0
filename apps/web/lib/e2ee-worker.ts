import {
  E2eeError,
  FileCipher,
  HEADER_SIZE,
  sha256Stream,
  unwrapWithPassphrase,
  wrapWithPassphrase,
  type AccountKeys,
  type Argon2Cost,
} from '../../../packages/api-client/src/e2ee';
import type { PassphraseEnvelope } from '@harbor/contracts';

/**
 * The page's side of workers/e2ee.ts. Encrypting, decrypting, hashing and Argon2id all run in
 * one worker, so a large upload or a migration doesn't freeze the page. Where workers aren't
 * available, the same code runs in the page.
 */
let worker: Worker | null | undefined;
let calls = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
function getWorker() {
  if (worker === undefined) {
    try {
      worker =
        typeof Worker === 'undefined'
          ? null
          : new Worker(new URL('../workers/e2ee.ts', import.meta.url), { type: 'module' });
      worker?.addEventListener('message', (event: MessageEvent) => {
        const { call, result, error } = event.data;
        const p = pending.get(call);
        pending.delete(call);
        if (!p) return;
        if (!error) return p.resolve(result);
        p.reject(
          error.name === 'E2eeError'
            ? new E2eeError(error.code, error.message)
            : Object.assign(new Error(error.message), { code: error.code }),
        );
      });
      worker?.addEventListener('error', () => {
        for (const p of pending.values()) p.reject(new Error('Encryption stopped unexpectedly.'));
        pending.clear();
        worker = undefined;
      });
    } catch {
      worker = null;
    }
  }
  return worker;
}
function run<T>(op: string, args: Record<string, unknown>, transfer: Transferable[] = []) {
  const w = getWorker()!;
  const call = ++calls;
  return new Promise<T>((resolve, reject) => {
    pending.set(call, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ call, op, ...args }, transfer);
  });
}
/** A buffer the worker can take; copies a view of a larger buffer so nothing else is lost. */
const own = (b: Uint8Array) =>
  b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice();

let ids = 0;
/** One file version's key, held in the worker: the same operations as FileCipher. */
export interface Cipher {
  header: Uint8Array;
  chunkSize: number;
  cipherRange: FileCipher['cipherRange'];
  plainRangeFor: FileCipher['plainRangeFor'];
  /** Stored bytes [start, end); `hash` adds them to the file's running SHA-256. */
  encryptedRange(
    plainTotal: number,
    start: number,
    end: number,
    read: (begin: number, end: number) => Promise<Uint8Array>,
    hash?: boolean,
  ): Promise<Uint8Array>;
  decryptRange(
    plainTotal: number,
    begin: number,
    end: number,
    stored: Uint8Array,
  ): Promise<Uint8Array>;
  /** Adds bytes to the running SHA-256; returns the same bytes. */
  hash(bytes: Uint8Array): Promise<Uint8Array>;
  digest(): Promise<string>;
  close(): void;
}

/** In the page, for when there is no worker. */
async function local(c: FileCipher): Promise<Cipher> {
  const h = await sha256Stream();
  return {
    header: c.header,
    chunkSize: c.chunkSize,
    cipherRange: c.cipherRange.bind(c),
    plainRangeFor: c.plainRangeFor.bind(c),
    async encryptedRange(total, start, end, read, hash) {
      const bytes = await c.encryptedRange(total, start, end, read);
      if (hash) h.update(bytes);
      return bytes;
    },
    decryptRange: c.decryptRange.bind(c),
    async hash(bytes) {
      h.update(bytes);
      return bytes;
    },
    digest: async () => h.hex(),
    close() {},
  };
}

async function remote(id: number, header: Uint8Array): Promise<Cipher> {
  // A FileCipher without its key, for the range arithmetic.
  const shape = Object.create(FileCipher.prototype) as FileCipher;
  const chunkSize = new DataView(header.buffer, header.byteOffset).getUint32(8);
  Object.assign(shape, { header, chunkSize });
  return {
    header,
    chunkSize,
    cipherRange: shape.cipherRange.bind(shape),
    plainRangeFor: shape.plainRangeFor.bind(shape),
    async encryptedRange(plainTotal, start, end, read, hash) {
      const range = shape.plainRangeFor(plainTotal, start, end);
      const plain = range ? own(await read(range[0], range[1])) : null;
      return run<Uint8Array>(
        'encrypt',
        { cipher: id, plainTotal, start, end, plain, plainBegin: range?.[0] ?? 0, hash },
        plain ? [plain.buffer] : [],
      );
    },
    decryptRange(plainTotal, begin, end, stored) {
      const s = own(stored);
      return run('decrypt', { cipher: id, plainTotal, begin, end, stored: s }, [s.buffer]);
    },
    hash(bytes) {
      const b = own(bytes);
      return run('hash', { cipher: id, bytes: b }, [b.buffer]);
    },
    digest: () => run<string>('digest', { cipher: id }),
    close: () => void run('close', { cipher: id }).catch(() => {}),
  };
}

/** A new random key for a new file version. */
export async function newCipher(keys: Pick<AccountKeys, 'fileWrap'>) {
  if (!getWorker()) return local(await FileCipher.create(keys));
  const id = ++ids;
  return remote(id, await run<Uint8Array>('create', { cipher: id, fileWrap: keys.fileWrap }));
}
/** The key of a stored file, from its header. */
export async function openCipher(keys: Pick<AccountKeys, 'fileWrap'>, header: Uint8Array) {
  if (!getWorker()) return local(await FileCipher.open(keys, header));
  const id = ++ids;
  const head = header.slice(0, HEADER_SIZE);
  await run('open', { cipher: id, fileWrap: keys.fileWrap, header: head });
  return remote(id, head);
}
/** Only a running SHA-256, for uploads that aren't encrypted. */
export async function plainHasher(): Promise<Pick<Cipher, 'hash' | 'digest' | 'close'>> {
  if (!getWorker()) {
    const h = await sha256Stream();
    return { hash: async (b) => (h.update(b), b), digest: async () => h.hex(), close() {} };
  }
  const id = ++ids;
  return {
    hash(bytes) {
      const b = own(bytes);
      return run('hash', { cipher: id, bytes: b }, [b.buffer]);
    },
    digest: () => run<string>('digest', { cipher: id }),
    close: () => void run('close', { cipher: id }).catch(() => {}),
  };
}

/** Argon2id takes most of a second of CPU; off the main thread, typing stays smooth. */
export function passphraseWrap(master: Uint8Array, passphrase: string, cost?: Argon2Cost) {
  if (!getWorker()) return wrapWithPassphrase(master, passphrase, cost);
  return run<PassphraseEnvelope>('wrap-passphrase', { master, passphrase, cost });
}
export function passphraseUnwrap(envelope: PassphraseEnvelope, passphrase: string) {
  if (!getWorker()) return unwrapWithPassphrase(envelope, passphrase);
  return run<Uint8Array>('unwrap-passphrase', { envelope, passphrase });
}
