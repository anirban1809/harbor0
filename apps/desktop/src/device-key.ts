import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { deviceProofMessage, type DeviceProof } from '@harbor/contracts';
import type { Journal } from './journal';

/** Encrypts the private key at rest (Electron safeStorage in the app). */
export type Sealer = { seal(value: string): string; open(sealed: string): string };

/**
 * Each account journal holds its own ECDSA P-256 key, so installations are
 * not linkable across accounts. New journals use the key's fingerprint as
 * their devicePublicId; older ones keep their ID and the server pins the key
 * to it on the first signed registration.
 */
export class DeviceKey {
  private constructor(
    private journal: Journal,
    private key: KeyObject,
    readonly publicKey: string,
    readonly fingerprint: string,
  ) {}

  static load(journal: Journal, sealer: Sealer) {
    const sealed = journal.get<string>('deviceKey');
    if (sealed) {
      try {
        return DeviceKey.from(journal, createPrivateKey(sealer.open(sealed)));
      } catch {
        // A lost keychain entry cannot prove the old identity, so start a new one.
        journal.set('publicId', null);
      }
    }
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = DeviceKey.from(journal, privateKey);
    journal.set(
      'deviceKey',
      sealer.seal(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()),
    );
    if (!journal.get('publicId')) journal.set('publicId', key.fingerprint);
    return key;
  }

  private static from(journal: Journal, privateKey: KeyObject) {
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const fingerprint = createHash('sha256').update(spki).digest('base64url');
    return new DeviceKey(journal, privateKey, spki.toString('base64url'), fingerprint);
  }

  get devicePublicId() {
    return this.journal.devicePublicId();
  }

  prove(challenge: string, userId: string): DeviceProof {
    const message = deviceProofMessage(challenge, userId, this.devicePublicId);
    return {
      publicKey: this.publicKey,
      challenge,
      signature: sign('sha256', Buffer.from(message), this.key).toString('base64url'),
    };
  }
}
