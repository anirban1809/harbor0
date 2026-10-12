/**
 * End-to-end encryption, the parts every app shares. Uses WebCrypto (browsers, Node 20+) and
 * hash-wasm for Argon2id and streaming SHA-256.
 *
 * Keys: one random 32-byte master key per account. It is stored only wrapped (AES-256-GCM) by
 * a key derived from the passphrase (Argon2id), from the recovery key (HKDF) and from each
 * unlocked device's secret (HKDF over a device half and a server half). Subkeys come from the
 * master key with HKDF: one wraps file keys, one encrypts names, one proves possession.
 *
 * Files (format H0E1): an 80-byte header, then the content in 4 MiB chunks, each AES-256-GCM
 * with its own nonce (file prefix ‖ chunk index) and the header plus a last-chunk flag as
 * associated data, so chunks can't be reordered, swapped between files or cut off. Every file
 * version has its own random content key, wrapped in the header. Encrypting is deterministic
 * for a given header, so an interrupted upload resumes with the same bytes.
 *
 * Names: `h0e1.` + base64url(iv ‖ ciphertext). The IV is an HMAC of the name, so the same
 * name always encrypts the same way and the server can still keep names unique in a folder.
 * The server learns which items share a name, and nothing else about it.
 */
import { argon2id, createSHA256 } from 'hash-wasm';
import type { PassphraseEnvelope, RecoveryEnvelope } from '@harbor/contracts';

const subtle = () => globalThis.crypto.subtle;
const text = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const MASTER_AAD = text.encode('harbor0/e2ee/v1/master');
const NAME_AAD = text.encode('harbor0/e2ee/v1/name');
export const NAME_PREFIX = 'h0e1.';
/** Longest name, in UTF-8 bytes, that fits the server's limit once encrypted. */
export const MAX_NAME_BYTES = 255;
export const CHUNK_SIZE = 4 * 1024 * 1024;
export const HEADER_SIZE = 80;
const TAG = 16;
const MAGIC = [0x48, 0x30, 0x45, 0x31]; // "H0E1"
/** Argon2id cost for new passphrases: OWASP's 64 MiB, 3 passes. */
export type Argon2Cost = { memoryKiB: number; iterations: number; parallelism: number };
export const ARGON2: Argon2Cost = { memoryKiB: 65_536, iterations: 3, parallelism: 1 };

export class E2eeError extends Error {
  constructor(
    public code: 'WRONG_KEY' | 'CORRUPT' | 'NAME_TOO_LONG' | 'LOCKED',
    message: string,
  ) {
    super(message);
    this.name = 'E2eeError';
  }
}

export const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export function b64url(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
// WebCrypto wants ArrayBuffer-backed views. Every buffer here is one, so this only tells
// TypeScript so; copying each 4 MiB chunk would double the work.
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

async function hkdf(secret: Uint8Array, info: string, length = 32, salt = new Uint8Array()) {
  const base = await subtle().importKey('raw', buf(secret), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle().deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: text.encode(info) },
      base,
      length * 8,
    ),
  );
}
const aesKey = (raw: Uint8Array) =>
  subtle().importKey('raw', buf(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
async function seal(key: CryptoKey, iv: Uint8Array, data: Uint8Array, aad: Uint8Array) {
  return new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) },
      key,
      buf(data),
    ),
  );
}
async function open(key: CryptoKey, iv: Uint8Array, data: Uint8Array, aad: Uint8Array) {
  try {
    return new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) },
        key,
        buf(data),
      ),
    );
  } catch {
    throw new E2eeError('WRONG_KEY', 'The key doesn’t match.');
  }
}

async function wrapMaster(kek: Uint8Array, master: Uint8Array) {
  const iv = random(12);
  return {
    iv: b64url(iv),
    ciphertext: b64url(await seal(await aesKey(kek), iv, master, MASTER_AAD)),
  };
}
async function unwrapMaster(kek: Uint8Array, e: { iv: string; ciphertext: string }) {
  const master = await open(
    await aesKey(kek),
    fromB64url(e.iv),
    fromB64url(e.ciphertext),
    MASTER_AAD,
  );
  if (master.length !== 32) throw new E2eeError('CORRUPT', 'The stored key is damaged.');
  return master;
}

async function passphraseKek(passphrase: string, salt: Uint8Array, p: Argon2Cost) {
  return argon2id({
    password: passphrase.normalize('NFKC'),
    salt,
    parallelism: p.parallelism,
    iterations: p.iterations,
    memorySize: p.memoryKiB,
    hashLength: 32,
    outputType: 'binary',
  });
}
export async function wrapWithPassphrase(
  master: Uint8Array,
  passphrase: string,
  cost: Argon2Cost = ARGON2,
): Promise<PassphraseEnvelope> {
  const salt = random(16);
  return {
    v: 1,
    kdf: 'argon2id',
    salt: b64url(salt),
    ...cost,
    ...(await wrapMaster(await passphraseKek(passphrase, salt, cost), master)),
  };
}
export async function unwrapWithPassphrase(e: PassphraseEnvelope, passphrase: string) {
  const kek = await passphraseKek(passphrase, fromB64url(e.salt), e);
  return unwrapMaster(kek, e);
}

// Recovery keys: 20 random bytes as 32 Crockford base32 characters, shown in 8 groups of 4.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function formatRecoveryKey(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}
/** Reads a typed recovery key, forgiving case, spaces, dashes and look-alike letters. */
export function parseRecoveryKey(typed: string) {
  const chars = typed
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
  if (!/^[0-9A-HJKMNP-TV-Z]{32}$/.test(chars)) return null;
  const out = new Uint8Array(20);
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const c of chars) {
    value = (value << 5) | CROCKFORD.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out[at++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}
export const newRecoveryKey = () => random(20);
export async function wrapWithRecovery(
  master: Uint8Array,
  recovery: Uint8Array,
): Promise<RecoveryEnvelope> {
  const salt = random(16);
  const kek = await hkdf(recovery, 'harbor0/e2ee/v1/recovery', 32, salt);
  return { v: 1, kdf: 'hkdf', salt: b64url(salt), ...(await wrapMaster(kek, master)) };
}
export async function unwrapWithRecovery(e: RecoveryEnvelope, recovery: Uint8Array) {
  return unwrapMaster(await hkdf(recovery, 'harbor0/e2ee/v1/recovery', 32, fromB64url(e.salt)), e);
}

/** A device's copy: the key wrapped by both halves of the device secret. */
export type DeviceEnvelope = { iv: string; ciphertext: string };
const deviceKek = (local: Uint8Array, server: Uint8Array) =>
  hkdf(concat(local, server), 'harbor0/e2ee/v1/device');
export async function wrapForDevice(master: Uint8Array, local: Uint8Array, server: Uint8Array) {
  return wrapMaster(await deviceKek(local, server), master);
}
export async function unwrapForDevice(e: DeviceEnvelope, local: Uint8Array, server: Uint8Array) {
  return unwrapMaster(await deviceKek(local, server), e);
}

/** The keys an unlocked device works with, derived once from the master key. */
export type AccountKeys = {
  master: Uint8Array;
  fileWrap: CryptoKey;
  nameEnc: CryptoKey;
  nameMac: CryptoKey;
  /** Sent to the server to show this device holds the key. */
  proof: string;
};
export async function accountKeys(master: Uint8Array): Promise<AccountKeys> {
  const [fileWrap, names, proof] = await Promise.all([
    hkdf(master, 'harbor0/e2ee/v1/file-keys'),
    hkdf(master, 'harbor0/e2ee/v1/names', 64),
    hkdf(master, 'harbor0/e2ee/v1/proof'),
  ]);
  return {
    master,
    fileWrap: await aesKey(fileWrap),
    nameEnc: await aesKey(names.subarray(0, 32)),
    nameMac: await subtle().importKey(
      'raw',
      buf(names.subarray(32)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
    proof: b64url(proof),
  };
}
export const newMasterKey = () => random(32);

export const isEncryptedName = (name: string) => /^h0e1\.[A-Za-z0-9_-]+$/.test(name);
export async function encryptName(keys: AccountKeys, name: string) {
  const plain = text.encode(name.normalize('NFC'));
  if (plain.length > MAX_NAME_BYTES)
    throw new E2eeError('NAME_TOO_LONG', 'This name is too long for an encrypted account.');
  const iv = new Uint8Array(await subtle().sign('HMAC', keys.nameMac, buf(plain))).subarray(0, 12);
  return NAME_PREFIX + b64url(concat(iv, await seal(keys.nameEnc, iv, plain, NAME_AAD)));
}
export async function decryptName(keys: AccountKeys, token: string) {
  const bytes = fromB64url(token.slice(NAME_PREFIX.length));
  if (bytes.length < 12 + TAG) throw new E2eeError('CORRUPT', 'The name is damaged.');
  return utf8.decode(await open(keys.nameEnc, bytes.subarray(0, 12), bytes.subarray(12), NAME_AAD));
}

/** Stored size of a file of `plain` bytes. */
export const encryptedSize = (plain: number) =>
  HEADER_SIZE + plain + TAG * Math.max(1, Math.ceil(plain / CHUNK_SIZE));
/** Original size of a stored encrypted file. */
export function plainSize(stored: number) {
  const body = stored - HEADER_SIZE;
  if (body < TAG) return 0;
  return body - TAG * Math.ceil(body / (CHUNK_SIZE + TAG));
}
const chunkCount = (plain: number) => Math.max(1, Math.ceil(plain / CHUNK_SIZE));

/** One file version's key, ready to encrypt or decrypt its chunks. */
export class FileCipher {
  private constructor(
    readonly header: Uint8Array,
    private key: CryptoKey,
    private prefix: Uint8Array,
    readonly chunkSize: number,
  ) {}
  /** A new random key for a new version. */
  static async create(keys: Pick<AccountKeys, 'fileWrap'>) {
    const content = random(32);
    const head = new Uint8Array(HEADER_SIZE);
    head.set(MAGIC, 0);
    head[4] = 1;
    new DataView(head.buffer).setUint32(8, CHUNK_SIZE);
    head.set(random(8), 12);
    const wrapIv = random(12);
    head.set(wrapIv, 20);
    const aad = head.subarray(0, 20);
    head.set(await seal(keys.fileWrap, wrapIv, content, aad), 32);
    return new FileCipher(head, await aesKey(content), head.slice(12, 20), CHUNK_SIZE);
  }
  /** Reads the key from a stored file's header. */
  static async open(keys: Pick<AccountKeys, 'fileWrap'>, header: Uint8Array) {
    if (header.length < HEADER_SIZE || MAGIC.some((b, i) => header[i] !== b) || header[4] !== 1)
      throw new E2eeError('CORRUPT', 'This file isn’t encrypted the way harbor0 expects.');
    const head = header.slice(0, HEADER_SIZE);
    const chunk = new DataView(head.buffer).getUint32(8);
    if (chunk < 4096 || chunk > 64 * 1024 * 1024)
      throw new E2eeError('CORRUPT', 'This file’s header is damaged.');
    const content = await open(
      keys.fileWrap,
      head.subarray(20, 32),
      head.subarray(32, 80),
      head.subarray(0, 20),
    );
    return new FileCipher(head, await aesKey(content), head.slice(12, 20), chunk);
  }
  private nonce(index: number) {
    const n = new Uint8Array(12);
    n.set(this.prefix, 0);
    new DataView(n.buffer).setUint32(8, index);
    return n;
  }
  private aad(last: boolean) {
    return concat(this.header.subarray(0, 20), new Uint8Array([last ? 1 : 0]));
  }
  encryptChunk(index: number, plain: Uint8Array, last: boolean) {
    return seal(this.key, this.nonce(index), plain, this.aad(last));
  }
  async decryptChunk(index: number, cipher: Uint8Array, last: boolean) {
    try {
      return await open(this.key, this.nonce(index), cipher, this.aad(last));
    } catch {
      throw new E2eeError('CORRUPT', 'Part of this file is damaged or was changed.');
    }
  }
  /** Stored byte range [start, end) of the chunks holding plaintext [begin, end). */
  cipherRange(plainTotal: number, begin: number, end: number) {
    const first = Math.floor(begin / this.chunkSize);
    const last = Math.max(first, Math.ceil(end / this.chunkSize) - 1);
    const stored = HEADER_SIZE + plainTotal + TAG * chunkCount(plainTotal);
    return {
      first,
      last,
      start: HEADER_SIZE + first * (this.chunkSize + TAG),
      end: Math.min(stored, HEADER_SIZE + (last + 1) * (this.chunkSize + TAG)),
    };
  }
  /**
   * Decrypts the chunks in a stored range read with `cipherRange`, returning plaintext
   * [begin, end). `plainTotal` tells which chunk is the last.
   */
  async decryptRange(plainTotal: number, begin: number, end: number, stored: Uint8Array) {
    const { first, last } = this.cipherRange(plainTotal, begin, end);
    const final = chunkCount(plainTotal) - 1;
    const parts: Uint8Array[] = [];
    let at = 0;
    for (let i = first; i <= last; i++) {
      const len = Math.min(this.chunkSize, plainTotal - i * this.chunkSize) + TAG;
      parts.push(await this.decryptChunk(i, stored.subarray(at, at + len), i === final));
      at += len;
    }
    const plain = concat(...parts);
    const offset = begin - first * this.chunkSize;
    return plain.subarray(offset, offset + (end - begin));
  }
  /** The plaintext [begin, end) that stored bytes [start, end) are sealed from, if any. */
  plainRangeFor(plainTotal: number, start: number, end: number): [number, number] | null {
    if (end <= HEADER_SIZE) return null;
    const span = this.chunkSize + TAG;
    const first = Math.floor((Math.max(start, HEADER_SIZE) - HEADER_SIZE) / span);
    const last = Math.floor((end - 1 - HEADER_SIZE) / span);
    return [first * this.chunkSize, Math.min(plainTotal, (last + 1) * this.chunkSize)];
  }
  /**
   * Stored bytes [start, end) of the encrypted file, reading plaintext through `read`. Only the
   * chunks the range touches are encrypted.
   */
  async encryptedRange(
    plainTotal: number,
    start: number,
    end: number,
    read: (begin: number, end: number) => Promise<Uint8Array>,
  ) {
    const out: Uint8Array[] = [];
    if (start < HEADER_SIZE) out.push(this.header.subarray(start, Math.min(end, HEADER_SIZE)));
    const range = this.plainRangeFor(plainTotal, start, end);
    if (range) {
      const span = this.chunkSize + TAG;
      const first = Math.floor((Math.max(start, HEADER_SIZE) - HEADER_SIZE) / span);
      const last = Math.floor((end - 1 - HEADER_SIZE) / span);
      const final = chunkCount(plainTotal) - 1;
      const plain = await read(range[0], range[1]);
      for (let i = first; i <= last && i <= final; i++) {
        const from = (i - first) * this.chunkSize;
        const sealed = await seal(
          this.key,
          this.nonce(i),
          plain.subarray(from, Math.min(plain.length, from + this.chunkSize)),
          this.aad(i === final),
        );
        const chunkStart = HEADER_SIZE + i * span;
        out.push(
          sealed.subarray(
            Math.max(0, start - chunkStart),
            Math.min(sealed.length, end - chunkStart),
          ),
        );
      }
    }
    return concat(...out);
  }
}

/** Streaming SHA-256, for the stored (encrypted) bytes the server checks uploads against. */
export async function sha256Stream() {
  const hash = await createSHA256();
  hash.init();
  return {
    update: (bytes: Uint8Array) => void hash.update(bytes),
    hex: () => hash.digest('hex'),
  };
}
