import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { deviceProofMessage, type DeviceProof } from '@harbor/contracts';
import { assert, DomainError } from './errors';

export const DEVICE_CHALLENGE_SECONDS = 300;

/** Fingerprint of an SPKI public key: SHA-256 of its DER bytes, base64url. */
export const keyFingerprint = (spki: Buffer) =>
  createHash('sha256').update(spki).digest('base64url');

function publicKey(encoded: string): { key: KeyObject; spki: Buffer } {
  try {
    const key = createPublicKey({
      key: Buffer.from(encoded, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    // Only P-256 is available in every client's hardware keystore.
    if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1')
      return { key, spki: key.export({ format: 'der', type: 'spki' }) };
  } catch {
    /* Reported below. */
  }
  throw new DomainError('VALIDATION_ERROR', 'Device keys must be ECDSA P-256 public keys.');
}

/** Verifies a device proof and returns the key's fingerprint. Challenge freshness is the caller's job. */
export function verifyDeviceProof(proof: DeviceProof, userId: string, devicePublicId: string) {
  const { key, spki } = publicKey(proof.publicKey);
  const message = Buffer.from(deviceProofMessage(proof.challenge, userId, devicePublicId));
  const signature = Buffer.from(proof.signature, 'base64url');
  let valid = false;
  try {
    // Native keystores sign in ASN.1 DER; Web Crypto in browsers signs as raw r‖s (64 bytes).
    valid = verify(
      'sha256',
      message,
      signature.length === 64 ? { key, dsaEncoding: 'ieee-p1363' } : key,
      signature,
    );
  } catch {
    /* Malformed signatures are invalid. */
  }
  assert(valid, 'DEVICE_PROOF_INVALID', 'This device could not prove its identity.', 401);
  return { fingerprint: keyFingerprint(spki), publicKey: spki.toString('base64url') };
}
