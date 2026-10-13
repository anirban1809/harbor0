import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  E2eeError,
  FileCipher,
  HEADER_SIZE,
  accountKeys,
  decryptName,
  encryptName,
  encryptedSize,
  formatRecoveryKey,
  newMasterKey,
  newRecoveryKey,
  parseRecoveryKey,
  plainSize,
  random,
  unwrapForDevice,
  unwrapWithPassphrase,
  unwrapWithRecovery,
  wrapForDevice,
  wrapWithPassphrase,
  wrapWithRecovery,
} from '../src/e2ee';
import { isEncryptedName as serverAccepts } from '@harbor/contracts';

// Tests use the smallest Argon2id cost the server accepts, to stay quick.
const cheap = { memoryKiB: 19_456, iterations: 2, parallelism: 1 } as const;

describe('end-to-end encryption keys', () => {
  it('unwraps the master key with the passphrase, the recovery key or a device copy', async () => {
    const master = newMasterKey();
    const byPassphrase = await wrapWithPassphrase(master, 'lantern-orbit-pickle-meadow', cheap);
    expect(await unwrapWithPassphrase(byPassphrase, 'lantern-orbit-pickle-meadow')).toEqual(master);
    await expect(unwrapWithPassphrase(byPassphrase, 'wrong')).rejects.toBeInstanceOf(E2eeError);

    const recovery = newRecoveryKey();
    const typed = formatRecoveryKey(recovery);
    expect(typed).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    const parsed = parseRecoveryKey(typed.toLowerCase().replace(/-/g, ' '))!;
    expect(parsed).toEqual(recovery);
    expect(await unwrapWithRecovery(await wrapWithRecovery(master, recovery), parsed)).toEqual(
      master,
    );
    expect(parseRecoveryKey('K7QF-2M9X')).toBeNull();

    const local = random(32);
    const server = random(32);
    const copy = await wrapForDevice(master, local, server);
    expect(await unwrapForDevice(copy, local, server)).toEqual(master);
    await expect(unwrapForDevice(copy, local, random(32))).rejects.toThrow();
  });

  it('encrypts names deterministically within the server’s limits', async () => {
    const keys = await accountKeys(newMasterKey());
    const a = await encryptName(keys, 'Tax 2026');
    expect(a).toBe(await encryptName(keys, 'Tax 2026'));
    expect(a).not.toBe(await encryptName(keys, 'tax 2026'));
    expect(await decryptName(keys, a)).toBe('Tax 2026');
    expect(serverAccepts(a)).toBe(true);
    const longest = await encryptName(keys, 'é'.repeat(127));
    expect(serverAccepts(longest)).toBe(true);
    expect(serverAccepts(await encryptName(keys, 'a'))).toBe(true);
    await expect(encryptName(keys, 'x'.repeat(256))).rejects.toThrow('too long');
    const other = await accountKeys(newMasterKey());
    await expect(decryptName(other, a)).rejects.toBeInstanceOf(E2eeError);
  });
});

describe('encrypted files', () => {
  const sizes = [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 2 * CHUNK_SIZE + 12345];
  it.each(sizes)('round-trips %i bytes in any ranges', async (size) => {
    const keys = await accountKeys(newMasterKey());
    const plain = new Uint8Array(size);
    for (let i = 0; i < size; i++) plain[i] = (i * 31 + 7) & 255;
    const read = async (b: number, e: number) => plain.slice(b, e);
    const cipher = await FileCipher.create(keys);
    const total = encryptedSize(size);
    expect(plainSize(total)).toBe(size);
    // Assemble the stored file from odd-sized parts, as an upload would.
    const part = 3_000_001;
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < total; at += part)
      pieces.push(await cipher.encryptedRange(size, at, Math.min(total, at + part), read));
    const stored = new Uint8Array(total);
    let at = 0;
    for (const p of pieces) {
      stored.set(p, at);
      at += p.length;
    }
    expect(at).toBe(total);
    const opened = await FileCipher.open(keys, stored.subarray(0, HEADER_SIZE));
    for (const [b, e] of [
      [0, size],
      [Math.floor(size / 3), Math.floor((2 * size) / 3)],
      [Math.max(0, size - 5), size],
    ]) {
      const r = opened.cipherRange(size, b, e);
      const out = await opened.decryptRange(size, b, e, stored.subarray(r.start, r.end));
      // Compared as buffers: element by element, megabytes take longer than the test's limit.
      expect(Buffer.from(out).equals(plain.subarray(b, e))).toBe(true);
    }
  });

  it('detects a changed or truncated file', async () => {
    const keys = await accountKeys(newMasterKey());
    const size = CHUNK_SIZE + 10;
    const plain = new Uint8Array(size);
    const cipher = await FileCipher.create(keys);
    const stored = await cipher.encryptedRange(size, 0, encryptedSize(size), async (b, e) =>
      plain.slice(b, e),
    );
    const opened = await FileCipher.open(keys, stored);
    const tampered = stored.slice();
    tampered[HEADER_SIZE + 5] ^= 1;
    const r = opened.cipherRange(size, 0, size);
    await expect(
      opened.decryptRange(size, 0, size, tampered.subarray(r.start, r.end)),
    ).rejects.toThrow('damaged');
    // Reading only the first chunk as if it were the whole file fails: it isn't the last one.
    await expect(
      opened.decryptRange(CHUNK_SIZE, 0, CHUNK_SIZE, stored.subarray(HEADER_SIZE)),
    ).rejects.toThrow('damaged');
    await expect(FileCipher.open(await accountKeys(newMasterKey()), stored)).rejects.toThrow();
  });
});
