/**
 * End-to-end encryption off the page's main thread: AES-GCM over file chunks (WebCrypto, which
 * uses the CPU's AES instructions), the streaming SHA-256 of what is uploaded and Argon2id for
 * passphrases (both WebAssembly, from hash-wasm). Buffers are transferred, not copied.
 * The page talks to it through lib/e2ee-worker.ts.
 */
import {
  FileCipher,
  sha256Stream,
  unwrapWithPassphrase,
  wrapWithPassphrase,
} from '../../../packages/api-client/src/e2ee';

type Hash = Awaited<ReturnType<typeof sha256Stream>>;
const ciphers = new Map<number, FileCipher>();
const hashes = new Map<number, Hash>();
const cipher = (id: number) => {
  const c = ciphers.get(id);
  if (!c) throw new Error('The file key is no longer open.');
  return c;
};

// One job at a time per cipher and hash keeps chunk order and the running hash consistent.
let queue: Promise<unknown> = Promise.resolve();
self.onmessage = (event: MessageEvent) => {
  const { call, op, ...a } = event.data;
  queue = queue.then(async () => {
    try {
      const transfer: Transferable[] = [];
      let result: unknown;
      switch (op) {
        case 'create': {
          const c = await FileCipher.create({ fileWrap: a.fileWrap });
          ciphers.set(a.cipher, c);
          result = c.header.slice();
          break;
        }
        case 'open':
          ciphers.set(a.cipher, await FileCipher.open({ fileWrap: a.fileWrap }, a.header));
          break;
        case 'close':
          ciphers.delete(a.cipher);
          hashes.delete(a.cipher);
          break;
        case 'encrypt': {
          const plain: Uint8Array | null = a.plain;
          const bytes = await cipher(a.cipher).encryptedRange(
            a.plainTotal,
            a.start,
            a.end,
            async (b, e) => plain!.subarray(b - a.plainBegin, e - a.plainBegin),
          );
          if (a.hash) await hashed(a.cipher, bytes);
          result = bytes;
          transfer.push(bytes.buffer);
          break;
        }
        case 'decrypt': {
          const bytes = await cipher(a.cipher).decryptRange(a.plainTotal, a.begin, a.end, a.stored);
          // decryptRange returns a view of a larger buffer; send only what was asked for.
          const out = bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
          result = out;
          transfer.push(out.buffer);
          break;
        }
        case 'hash': {
          await hashed(a.cipher, a.bytes);
          result = a.bytes;
          transfer.push(a.bytes.buffer);
          break;
        }
        case 'digest':
          result = (await hashFor(a.cipher)).hex();
          hashes.delete(a.cipher);
          break;
        case 'wrap-passphrase':
          result = await wrapWithPassphrase(a.master, a.passphrase, a.cost);
          break;
        case 'unwrap-passphrase':
          result = await unwrapWithPassphrase(a.envelope, a.passphrase);
          break;
        default:
          throw new Error(`Unknown operation ${op}`);
      }
      self.postMessage({ call, result }, { transfer });
    } catch (e) {
      const error = e as Error & { code?: string };
      self.postMessage({
        call,
        error: { message: error.message, code: error.code, name: error.name },
      });
    }
  });
};

async function hashFor(id: number) {
  let h = hashes.get(id);
  if (!h) hashes.set(id, (h = await sha256Stream()));
  return h;
}
async function hashed(id: number, bytes: Uint8Array) {
  (await hashFor(id)).update(bytes);
}
