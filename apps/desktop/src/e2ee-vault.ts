import { ApiError, type Transport } from '@harbor/api-client';
import type { E2eeState } from '@harbor/contracts';
import {
  accountKeys,
  b64url,
  fromB64url,
  random,
  unwrapForDevice,
  unwrapWithPassphrase,
  unwrapWithRecovery,
  wrapForDevice,
  wrapWithPassphrase,
  type AccountKeys,
  type DeviceEnvelope,
} from '../../../packages/api-client/src/e2ee';
import type { E2eeVaultView } from '../../../packages/api-client/src/e2ee-transport';

/** This computer's copy of the account key: it opens only with the half the server keeps. */
type SavedCopy = { userId: string; recordId: string; local: string; envelope: DeviceEnvelope };
export type VaultStore = {
  load(): SavedCopy | undefined;
  save(copy: SavedCopy): void;
  clear(): void;
};

/**
 * The signed-in account's end-to-end encryption on this computer. The keys live in memory only;
 * the saved copy is sealed by the OS keychain and also needs the server's half, so removing this
 * computer from the web app's encryption settings locks it for good.
 */
export class DesktopVault {
  private view: E2eeVaultView = { enabled: false };
  private deviceRecordId?: string;
  constructor(
    private store: () => VaultStore | undefined,
    private changed: () => void,
  ) {}
  current = () => this.view;
  /** Uploads must be encrypted: the account is encrypted, unlocked here and not turning off. */
  uploadKeys = () => (this.view.enabled && !this.view.decrypting ? this.view.keys : undefined);
  /** Stored encrypted files can be read. */
  readKeys = () => (this.view.enabled ? this.view.keys : undefined);
  /** This computer's record among the account's unlocked devices, while unlocked. */
  get deviceRecord() {
    return this.view.keys ? this.deviceRecordId : undefined;
  }
  get locked() {
    return this.view.enabled && !this.view.keys;
  }
  private set(change: Partial<E2eeVaultView>) {
    const before = this.view;
    this.view = { ...this.view, ...change };
    if (
      before.enabled !== this.view.enabled ||
      before.decrypting !== this.view.decrypting ||
      before.keys !== this.view.keys
    )
      this.changed();
  }

  /** Called with each /v1/users/me answer; a different account starts locked. */
  setAccount = (userId: string, enabled: boolean, decrypting: boolean) => {
    if (this.view.userId !== userId)
      return this.set({ userId, enabled, decrypting, keys: undefined });
    if (this.view.enabled && !enabled) {
      // Turned off: the saved copy opens nothing any more.
      this.store()?.clear();
      this.deviceRecordId = undefined;
      return this.set({ enabled, decrypting: false, keys: undefined });
    }
    this.set({ enabled, decrypting });
  };
  /** Signed out: forget the keys, keeping the saved copy for the next sign-in. */
  reset() {
    this.deviceRecordId = undefined;
    this.set({ userId: undefined, enabled: false, decrypting: false, keys: undefined });
  }

  /** Opens this computer's saved copy, if the server still recognises it. */
  async restore(request: Transport) {
    const userId = this.view.userId;
    const saved = this.store()?.load();
    if (!userId || this.view.keys || !saved || saved.userId !== userId) return false;
    try {
      const { serverSecret } = await request(`/v1/e2ee/devices/${saved.recordId}/secret`, {
        method: 'POST',
      });
      const master = await unwrapForDevice(
        saved.envelope,
        fromB64url(saved.local),
        fromB64url(serverSecret),
      );
      this.deviceRecordId = saved.recordId;
      this.set({ keys: await accountKeys(master) });
      return true;
    } catch (e) {
      // Removed from the web app, or damaged: the passphrase unlocks it again.
      if ((e instanceof ApiError && e.status === 404) || (e as Error).name === 'E2eeError')
        this.store()?.clear();
      return false;
    }
  }

  private async keep(request: Transport, keys: AccountKeys) {
    const local = random(32);
    const server = random(32);
    const envelope = await wrapForDevice(keys.master, local, server);
    const { id } = await request('/v1/e2ee/devices', {
      method: 'POST',
      body: { proof: keys.proof, serverSecret: b64url(server), remember: true },
    });
    this.store()?.save({ userId: this.view.userId!, recordId: id, local: b64url(local), envelope });
    this.deviceRecordId = id;
    this.set({ keys });
  }
  async unlockWithPassphrase(request: Transport, passphrase: string) {
    const state = (await request('/v1/e2ee')).e2ee as E2eeState;
    if (!state.passphrase) throw new Error('Encryption is off for this account.');
    const master = await unwrapWithPassphrase(state.passphrase, passphrase);
    await this.keep(request, await accountKeys(master));
  }
  /** Unlocks with the recovery key and sets a new passphrase, as after a forgotten one. */
  async unlockWithRecovery(request: Transport, recovery: Uint8Array, passphrase: string) {
    const state = (await request('/v1/e2ee')).e2ee as E2eeState;
    if (!state.recovery) throw new Error('Encryption is off for this account.');
    const master = await unwrapWithRecovery(state.recovery, recovery);
    const keys = await accountKeys(master);
    await request('/v1/e2ee/passphrase', {
      method: 'PUT',
      body: { passphrase: await wrapWithPassphrase(master, passphrase), proof: keys.proof },
    });
    await this.keep(request, keys);
  }
  /** Forgets the key on this computer and removes its copy; it needs the passphrase again. */
  async lock(request?: Transport) {
    const record = this.deviceRecordId ?? this.store()?.load()?.recordId;
    this.store()?.clear();
    this.deviceRecordId = undefined;
    this.set({ keys: undefined });
    if (request && record)
      await request(`/v1/e2ee/devices/${record}`, { method: 'DELETE' }).catch(() => {});
  }
}
