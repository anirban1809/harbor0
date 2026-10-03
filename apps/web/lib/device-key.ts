import { deviceProofMessage } from '@harbor/contracts';
import type { Transport } from '@harbor/api-client';

// Each browser keeps one P-256 key whose private half can't leave it. Its fingerprint is the
// browser's device ID, so signing in again shows up as the same device, not a new one.
const DB = 'harbor0-device';
const STORE = 'keys';
const KEY = 'device';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  return database().then((db) =>
    new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).finally(() => db.close()),
  );
}
const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

let pending: Promise<{ keys: CryptoKeyPair; publicKey: string; fingerprint: string }> | null = null;
/** This browser's key, created on first use. */
export function browserKey() {
  pending ??= (async () => {
    let keys = await transaction<CryptoKeyPair | undefined>('readonly', (store) => store.get(KEY));
    if (!keys) {
      keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
        'verify',
      ]);
      await transaction('readwrite', (store) => store.put(keys, KEY));
    }
    const spki = await crypto.subtle.exportKey('spki', keys.publicKey);
    return {
      keys,
      publicKey: base64url(spki),
      fingerprint: base64url(await crypto.subtle.digest('SHA-256', spki)),
    };
  })();
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

/** “Chrome on macOS”, so the device list says which browser this is. */
export function browserName(agent = navigator.userAgent) {
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Web browser';
  const system = /iPhone|iPad/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Mac OS X/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return system ? `${browser} on ${system}` : browser;
}

/**
 * Links this sign-in to the browser's key. The server pins the first key to prove an ID, so the
 * same browser is listed once however often it signs in. Runs once per page load and account;
 * signing out reloads the page, so each new sign-in is linked too.
 */
const registered = new Map<string, Promise<void>>();
export function registerBrowser(request: Transport, userId: string) {
  if (!registered.has(userId)) {
    const attempt = link(request);
    registered.set(userId, attempt);
    attempt.catch(() => registered.delete(userId));
  }
  return registered.get(userId)!;
}
async function link(request: Transport) {
  const { keys, publicKey, fingerprint } = await browserKey();
  const { challenge, userId: account } = await request('/v1/auth/session/challenge', {
    method: 'POST',
    body: {},
  });
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    new TextEncoder().encode(deviceProofMessage(challenge, account, fingerprint)),
  );
  await request('/v1/sync/devices/register', {
    method: 'POST',
    body: {
      name: browserName(),
      platform: 'WEB',
      devicePublicId: fingerprint,
      proof: { challenge, publicKey, signature: base64url(signature) },
    },
  });
}
