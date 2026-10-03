import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal';
import { DeviceKey, type Sealer } from '../src/device-key';
import { verifyDeviceProof } from '../../backend/src/device-identity';

let root: string;
let file: string;
const sealer: Sealer = {
  seal: (value) => Buffer.from(value).toString('base64'),
  open: (sealed) => Buffer.from(sealed, 'base64').toString(),
};
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'harbor-device-key-'));
  file = path.join(root, 'journal.sqlite');
});
afterEach(() => rm(root, { recursive: true, force: true }));

it('creates a sealed key, uses its fingerprint as a new identity and reuses it after restart', () => {
  let journal = new Journal(file);
  const key = DeviceKey.load(journal, sealer);
  expect(key.devicePublicId).toBe(key.fingerprint);
  expect(journal.get<string>('deviceKey')).not.toContain('PRIVATE KEY');
  journal.close();
  journal = new Journal(file);
  const again = DeviceKey.load(journal, sealer);
  expect(again.fingerprint).toBe(key.fingerprint);
  const proof = again.prove('challenge', 'alice');
  expect(verifyDeviceProof(proof, 'alice', again.devicePublicId).fingerprint).toBe(key.fingerprint);
  expect(() => verifyDeviceProof(proof, 'bob', again.devicePublicId)).toThrow();
  journal.close();
});

it('keeps an existing installation ID so the server can pin the new key to it', () => {
  const journal = new Journal(file);
  journal.set('publicId', 'existing-installation');
  const key = DeviceKey.load(journal, sealer);
  expect(key.devicePublicId).toBe('existing-installation');
  expect(
    verifyDeviceProof(key.prove('c', 'alice'), 'alice', 'existing-installation'),
  ).toMatchObject({
    fingerprint: key.fingerprint,
  });
  journal.close();
});

it('starts a new identity when the sealed key can no longer be opened', () => {
  const journal = new Journal(file);
  const original = DeviceKey.load(journal, sealer);
  const replaced = DeviceKey.load(journal, {
    ...sealer,
    open: () => {
      throw new Error('Keychain entry is gone');
    },
  });
  expect(replaced.fingerprint).not.toBe(original.fingerprint);
  expect(replaced.devicePublicId).toBe(replaced.fingerprint);
  journal.close();
});
