import { useSyncExternalStore } from 'react';
import type { Transport } from '@harbor/api-client';
import type { E2eeState } from '@harbor/contracts';
import {
  accountKeys,
  b64url,
  fromB64url,
  newMasterKey,
  random,
  unwrapForDevice,
  unwrapWithRecovery,
  wrapForDevice,
  wrapWithRecovery,
  type AccountKeys,
  type DeviceEnvelope,
} from '../../../packages/api-client/src/e2ee';
import { passphraseUnwrap, passphraseWrap } from './e2ee-worker';

/**
 * This tab's end-to-end encryption state: whether the signed-in account is encrypted and, once
 * unlocked, its keys. The keys live in memory only. A browser that unlocks keeps a wrapped copy
 * of the key (localStorage when remembered, sessionStorage for this tab only) that opens only
 * with a second half the server holds, so removing the browser in Settings locks it for good.
 */
export type Vault = {
  userId?: string;
  /** The account is encrypted. */
  enabled: boolean;
  /** Encryption is being turned off: stored files are decrypted and new ones stay unencrypted. */
  decrypting?: boolean;
  keys?: AccountKeys;
  /** This browser's server record, while unlocked. */
  deviceRecordId?: string;
  remember?: boolean;
  /** Still trying this browser's saved copy, before asking for the passphrase. */
  restoring: boolean;
};
type SavedCopy = { recordId: string; local: string; envelope: DeviceEnvelope };

let vault: Vault = { enabled: false, restoring: false };
const listeners = new Set<() => void>();
function set(change: Partial<Vault>) {
  vault = { ...vault, ...change };
  for (const listener of listeners) listener();
}
export const currentVault = () => vault;
export function useVault() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => vault,
    () => vault,
  );
}

const copyKey = (userId: string) => `harbor0-e2ee:${userId}`;
function readCopy(userId: string): { copy: SavedCopy; remember: boolean } | null {
  for (const [store, remember] of [
    [sessionStorage, false],
    [localStorage, true],
  ] as const) {
    try {
      const raw = store.getItem(copyKey(userId));
      if (raw) return { copy: JSON.parse(raw) as SavedCopy, remember };
    } catch {
      // Storage can be blocked; the passphrase still works.
    }
  }
  return null;
}
function forgetCopy(userId: string) {
  for (const store of [sessionStorage, localStorage])
    try {
      store.removeItem(copyKey(userId));
    } catch {
      // Nothing saved.
    }
}

/** Called with each /v1/users/me answer; a different account starts locked. */
export function setAccount(userId: string, enabled: boolean, decrypting = false) {
  if (vault.userId === userId && vault.enabled === enabled && !!vault.decrypting === decrypting)
    return;
  if (vault.userId === userId && vault.enabled && !enabled) {
    // Turned off: this browser's copy opens nothing any more.
    forgetCopy(userId);
    return set({
      enabled,
      decrypting: false,
      keys: undefined,
      deviceRecordId: undefined,
      restoring: false,
    });
  }
  if (vault.userId !== userId)
    set({
      userId,
      enabled,
      decrypting,
      keys: undefined,
      deviceRecordId: undefined,
      restoring: enabled && !!readCopy(userId),
    });
  else set({ enabled, decrypting, restoring: enabled && !vault.keys && !!readCopy(userId) });
}

/** Opens this browser's saved copy, if it has one the server still recognises. */
export async function restore(request: Transport) {
  const userId = vault.userId;
  if (!userId || vault.keys) return;
  const saved = readCopy(userId);
  if (!saved) return set({ restoring: false });
  try {
    const { serverSecret } = await request(`/v1/e2ee/devices/${saved.copy.recordId}/secret`, {
      method: 'POST',
    });
    const master = await unwrapForDevice(
      saved.copy.envelope,
      fromB64url(saved.copy.local),
      fromB64url(serverSecret),
    );
    set({
      keys: await accountKeys(master),
      deviceRecordId: saved.copy.recordId,
      remember: saved.remember,
      restoring: false,
    });
  } catch (e) {
    // Removed in Settings, or damaged: the passphrase unlocks it again.
    if ((e as { status?: number }).status === 404 || (e as Error).name === 'E2eeError')
      forgetCopy(userId);
    set({ restoring: false });
  }
}

async function keepCopy(request: Transport, keys: AccountKeys, remember: boolean) {
  const userId = vault.userId!;
  const local = random(32);
  const server = random(32);
  const envelope = await wrapForDevice(keys.master, local, server);
  const { id } = await request('/v1/e2ee/devices', {
    method: 'POST',
    body: { proof: keys.proof, serverSecret: b64url(server), remember },
  });
  forgetCopy(userId);
  try {
    (remember ? localStorage : sessionStorage).setItem(
      copyKey(userId),
      JSON.stringify({ recordId: id, local: b64url(local), envelope } satisfies SavedCopy),
    );
  } catch {
    // Without storage this tab stays unlocked until it reloads.
  }
  set({ keys, deviceRecordId: id, remember, restoring: false });
}

export async function unlockWithPassphrase(
  request: Transport,
  state: E2eeState,
  passphrase: string,
  remember: boolean,
) {
  const master = await passphraseUnwrap(state.passphrase!, passphrase);
  await keepCopy(request, await accountKeys(master), remember);
}

/** Unlocks with the recovery key and sets a new passphrase, as after a forgotten one. */
export async function unlockWithRecovery(
  request: Transport,
  state: E2eeState,
  recovery: Uint8Array,
  passphrase: string,
  remember: boolean,
) {
  const master = await unwrapWithRecovery(state.recovery!, recovery);
  const keys = await accountKeys(master);
  await request('/v1/e2ee/passphrase', {
    method: 'PUT',
    body: { passphrase: await passphraseWrap(master, passphrase), proof: keys.proof },
  });
  await keepCopy(request, keys, remember);
}

/** Turns encryption on with a new key and unlocks this browser, remembered or for this tab. */
export async function enroll(
  request: Transport,
  passphrase: string,
  recovery: Uint8Array,
  remember: boolean,
) {
  const master = newMasterKey();
  const keys = await accountKeys(master);
  await request('/v1/e2ee/enroll', {
    method: 'POST',
    body: {
      passphrase: await passphraseWrap(master, passphrase),
      recovery: await wrapWithRecovery(master, recovery),
      proof: keys.proof,
    },
  });
  set({ enabled: true });
  await keepCopy(request, keys, remember);
}

/** Keeps this browser unlocked after the tab closes: a remembered copy replaces this tab's. */
export async function rememberBrowser(request: Transport) {
  const keys = requireKeys();
  const previous = vault.deviceRecordId;
  await keepCopy(request, keys, true);
  if (previous) await request(`/v1/e2ee/devices/${previous}`, { method: 'DELETE' }).catch(() => {});
}

export async function changePassphrase(request: Transport, passphrase: string) {
  const keys = requireKeys();
  return request('/v1/e2ee/passphrase', {
    method: 'PUT',
    body: { passphrase: await passphraseWrap(keys.master, passphrase), proof: keys.proof },
  });
}
export async function replaceRecovery(request: Transport, recovery: Uint8Array) {
  const keys = requireKeys();
  return request('/v1/e2ee/recovery', {
    method: 'PUT',
    body: { recovery: await wrapWithRecovery(keys.master, recovery), proof: keys.proof },
  });
}

/** Forgets the key in this browser; it needs the passphrase again. */
export async function lock(request?: Transport) {
  const { userId, deviceRecordId } = vault;
  if (userId) forgetCopy(userId);
  set({ keys: undefined, deviceRecordId: undefined, restoring: false });
  if (request && deviceRecordId)
    await request(`/v1/e2ee/devices/${deviceRecordId}`, { method: 'DELETE' }).catch(() => {});
}

export function requireKeys() {
  if (!vault.keys)
    throw Object.assign(new Error('Unlock your files to continue.'), { code: 'E2EE_LOCKED' });
  return vault.keys;
}

/** Starts turning encryption off, once the passphrase has shown this person holds the key. */
export async function startTurningOff(request: Transport, state: E2eeState, passphrase: string) {
  const keys = requireKeys();
  const master = await passphraseUnwrap(state.passphrase!, passphrase);
  if (b64url(master) !== b64url(keys.master))
    throw Object.assign(new Error('That passphrase isn’t right.'), { code: 'WRONG_KEY' });
  const result = await request('/v1/e2ee/disable', { method: 'POST', body: { proof: keys.proof } });
  set({ decrypting: true });
  return result;
}
