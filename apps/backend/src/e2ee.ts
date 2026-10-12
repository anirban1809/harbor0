import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  E2EE_CLIENTS,
  isEncryptedName,
  type Device,
  type DriveItem,
  type E2eeDevice,
  type E2eeMigration,
  type E2eeState,
  type FileVersion,
  type PassphraseEnvelope,
  type RecoveryEnvelope,
} from '@harbor/contracts';
import type { Account, StorageService } from './domain';
import { userPK } from './domain';
import { assert } from './errors';
import { Transaction, transact } from './repository';

/** The account's wrapped keys; the server can unwrap none of them. */
type KeysRecord = {
  enabledAt: string;
  passphrase: PassphraseEnvelope;
  passphraseChangedAt: string | null;
  recovery: RecoveryEnvelope;
  recoveryCreatedAt: string;
  /** SHA-256 of the key proof, hex; see `keyProof` in contracts. */
  proofHash: string;
  migration?: E2eeMigration;
};
/** An unlocked device. The secret is only half of its key; the device keeps the other half. */
type DeviceRecord = E2eeDevice & { serverSecret: string };
const KEYS = 'E2EE';
const deviceKey = (id: string) => `E2EE_DEVICE#${id}`;
// A browser unlocked for one session can't say when its tab closes, so its copy is forgotten
// after this long without use.
const SESSION_DEVICE_TTL_S = 7 * 86400;
const now = () => new Date().toISOString();
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const sameProof = (proof: string, hash: string) =>
  timingSafeEqual(Buffer.from(sha256(proof), 'hex'), Buffer.from(hash, 'hex'));
/** Versions purged per transaction, within DynamoDB's 100-item limit. */
const PURGE_BATCH = 8;

/** Whether an app may use an encrypted account: only builds that encrypt. */
export function encryptingClient(device?: Pick<Device, 'platform' | 'appVersion'>) {
  if (!device) return false;
  const min = E2EE_CLIENTS[device.platform];
  if (min === undefined) return false;
  if (min === '0') return true;
  const parts = (v: string) => v.split('.').map(Number);
  const [have, need] = [parts(device.appVersion ?? '0'), parts(min)];
  for (let i = 0; i < Math.max(have.length, need.length); i++)
    if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) > (need[i] ?? 0);
  return true;
}
export const encryptedAccount = (account?: Pick<Account, 'e2ee'>) => !!account?.e2ee?.enabledAt;
/** Refuses a plaintext name for an item an encrypted account owns. */
export function assertNameFor(account: Pick<Account, 'e2ee'>, name: string) {
  assert(
    !encryptedAccount(account) || isEncryptedName(name),
    'E2EE_REQUIRED',
    'This account uses end-to-end encryption. Update the app so it can encrypt file names.',
    409,
  );
}
export function assertNotEncrypted(account: Pick<Account, 'e2ee'>, what: string) {
  assert(
    !encryptedAccount(account),
    'E2EE_UNSUPPORTED',
    `${what} isn't available with end-to-end encryption yet.`,
    403,
  );
}

export class E2ee {
  constructor(private service: StorageService) {}
  private get repo() {
    return this.service.repo;
  }

  async state(userId: string): Promise<E2eeState> {
    const tx = new Transaction(this.repo);
    const keys = await tx.get<KeysRecord>(userPK(userId), KEYS);
    const devices = keys ? await tx.list<DeviceRecord>(userPK(userId), 'E2EE_DEVICE#') : [];
    return {
      enabled: !!keys,
      enabledAt: keys?.enabledAt ?? null,
      passphrase: keys?.passphrase ?? null,
      recovery: keys?.recovery ?? null,
      recoveryCreatedAt: keys?.recoveryCreatedAt ?? null,
      passphraseChangedAt: keys?.passphraseChangedAt ?? null,
      devices: devices
        .map(({ serverSecret: _, ...d }) => d)
        .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)),
      migration: keys?.migration ?? null,
    };
  }

  /** Turns encryption on for good. Every later upload and name must be encrypted. */
  async enroll(
    userId: string,
    input: { passphrase: PassphraseEnvelope; recovery: RecoveryEnvelope; proof: string },
  ) {
    await transact(this.repo, async (tx) => {
      const account = await this.service.account(tx, userId);
      assert(
        !encryptedAccount(account),
        'E2EE_ALREADY_ON',
        'End-to-end encryption is already on.',
        409,
      );
      const at = now();
      await tx.put(userPK(userId), KEYS, {
        enabledAt: at,
        passphrase: input.passphrase,
        passphraseChangedAt: null,
        recovery: input.recovery,
        recoveryCreatedAt: at,
        proofHash: sha256(input.proof),
      } satisfies KeysRecord);
      account.e2ee = { enabledAt: at };
      account.updatedAt = at;
      await tx.put(userPK(userId), 'PROFILE', account);
    });
    return this.state(userId);
  }

  private async keys(tx: Transaction, userId: string, proof: string) {
    const keys = await tx.get<KeysRecord>(userPK(userId), KEYS);
    assert(keys, 'E2EE_OFF', 'End-to-end encryption is off.', 409);
    assert(
      sameProof(proof, keys.proofHash),
      'E2EE_KEY_MISMATCH',
      'This device has a different encryption key. Unlock it again.',
      403,
    );
    return keys;
  }

  /** Re-wraps the same key with a new passphrase; files are untouched. */
  async setPassphrase(userId: string, input: { passphrase: PassphraseEnvelope; proof: string }) {
    await transact(this.repo, async (tx) => {
      const keys = await this.keys(tx, userId, input.proof);
      await tx.put(userPK(userId), KEYS, {
        ...keys,
        passphrase: input.passphrase,
        passphraseChangedAt: now(),
      });
    });
    return this.state(userId);
  }

  /** Replaces the recovery key; the old one stops working. */
  async setRecovery(userId: string, input: { recovery: RecoveryEnvelope; proof: string }) {
    await transact(this.repo, async (tx) => {
      const keys = await this.keys(tx, userId, input.proof);
      await tx.put(userPK(userId), KEYS, {
        ...keys,
        recovery: input.recovery,
        recoveryCreatedAt: now(),
      });
    });
    return this.state(userId);
  }

  async addDevice(
    userId: string,
    device: Device | undefined,
    input: { proof: string; serverSecret: string; remember: boolean },
  ) {
    const id = randomUUID();
    await transact(this.repo, async (tx) => {
      await this.keys(tx, userId, input.proof);
      const at = now();
      await tx.put(
        userPK(userId),
        deviceKey(id),
        {
          id,
          deviceId: device?.id ?? null,
          name: device?.name ?? 'Browser',
          platform: device?.platform ?? 'WEB',
          remember: input.remember,
          createdAt: at,
          lastUsedAt: at,
          serverSecret: input.serverSecret,
        } satisfies DeviceRecord,
        input.remember ? {} : { expiresAt: Math.floor(Date.now() / 1000) + SESSION_DEVICE_TTL_S },
      );
    });
    return { id };
  }

  /** The server half of a device's key, so the device can unlock without the passphrase. */
  async deviceSecret(userId: string, id: string) {
    return transact(this.repo, async (tx) => {
      const record = await tx.get<DeviceRecord>(userPK(userId), deviceKey(id));
      assert(
        record,
        'E2EE_DEVICE_REMOVED',
        'This device was removed. Enter your passphrase to unlock it again.',
        404,
      );
      const at = now();
      // Seen at most hourly, so unlocking stays a read on most page loads.
      if (Date.parse(record.lastUsedAt) < Date.now() - 3600_000 || !record.remember)
        await tx.put(
          userPK(userId),
          deviceKey(id),
          { ...record, lastUsedAt: at },
          record.remember
            ? {}
            : { expiresAt: Math.floor(Date.now() / 1000) + SESSION_DEVICE_TTL_S },
        );
      return { serverSecret: record.serverSecret };
    });
  }

  async removeDevice(userId: string, id: string) {
    await transact(this.repo, async (tx) => {
      if (await tx.get(userPK(userId), deviceKey(id)))
        await tx.delete(userPK(userId), deviceKey(id));
    });
    return this.state(userId);
  }

  async setMigration(
    userId: string,
    device: Device | undefined,
    input: Omit<E2eeMigration, 'deviceName' | 'updatedAt'>,
  ) {
    let finished = false;
    await transact(this.repo, async (tx) => {
      const keys = await tx.get<KeysRecord>(userPK(userId), KEYS);
      assert(keys, 'E2EE_OFF', 'End-to-end encryption is off.', 409);
      finished = input.complete && !keys.migration?.complete;
      await tx.put(userPK(userId), KEYS, {
        ...keys,
        migration: { ...input, deviceName: device?.name ?? null, updatedAt: now() },
      });
    });
    return { finished, state: await this.state(userId) };
  }

  /**
   * Deletes a re-encrypted file's unencrypted versions. Only the owner's own files whose current
   * version is encrypted qualify; versions a transfer still holds are kept until it ends.
   */
  async purgePlaintext(userId: string, itemId: string) {
    let removed = 0;
    let retained = 0;
    for (;;) {
      const batch = await transact(this.repo, async (tx) => {
        const account = await this.service.account(tx, userId);
        assert(encryptedAccount(account), 'E2EE_OFF', 'End-to-end encryption is off.', 409);
        const item = await tx.get<DriveItem>(userPK(userId), `ITEM#${itemId}`);
        assert(item && item.type === 'FILE', 'ITEM_NOT_FOUND', 'File was not found.', 404);
        assert(
          item.encrypted,
          'E2EE_NOT_ENCRYPTED',
          'Upload the encrypted copy before removing unencrypted versions.',
          409,
        );
        const versions = (await tx.list<FileVersion>(userPK(userId), `VERSION#${itemId}#`)).filter(
          (v) => !v.encrypted && v.id !== item.currentVersionId,
        );
        let freed = 0;
        let held = 0;
        let done = 0;
        for (const version of versions) {
          if (done >= PURGE_BATCH) break;
          const key = `VERSION#${itemId}#${version.id}`;
          if (version.cloudState === 'RELEASED') {
            await tx.delete(userPK(userId), key);
            done++;
            continue;
          }
          const pin = await tx.get<{ count: number }>(`PIN#${version.storageObjectId}`, userId);
          if (pin?.count) {
            held++;
            continue;
          }
          await this.service.reference(tx, version.storageObjectId, -1);
          await tx.delete(userPK(userId), key);
          freed += version.sizeBytes;
          done++;
        }
        if (freed) {
          account.storageUsedBytes -= freed;
          await this.service.storageAlert(tx, account);
          await tx.put(userPK(userId), 'PROFILE', account);
        }
        return { done, held, more: versions.length - held > done };
      });
      removed += batch.done;
      retained = batch.held;
      if (!batch.more) break;
    }
    return { removed, retained };
  }
}
