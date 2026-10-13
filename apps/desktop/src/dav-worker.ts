import { parentPort } from 'node:worker_threads';
import { ApiClient, ApiError, createTransport } from '@harbor/api-client';
import { e2eeTransport, type E2eeVaultView } from '../../../packages/api-client/src/e2ee-transport';
import { DriveDav } from './drive-dav';
import { apiDrive } from './drive-dav-api';
import { retrying } from './retry';
import { transferKeys } from './transfers';
import type { DavHostMessage, DavWorkerConfig, DavWorkerMessage } from './dav-host';

/**
 * The local WebDAV server, on a thread of its own. Finder and File Explorer read the drive
 * through the system, and the app's main thread sometimes waits on the system (opening a
 * folder, a file dialog); with the server on that thread, each would wait for the other
 * forever. Here it makes its own API requests, with an access token and the account's keys
 * from the main thread.
 */
const port = parentPort!;
const send = (message: DavWorkerMessage) => port.postMessage(message);

let vault: E2eeVaultView = { enabled: false };
transferKeys.upload = () => (vault.enabled && !vault.decrypting ? vault.keys : undefined);
transferKeys.read = () => (vault.enabled ? vault.keys : undefined);

// The access token comes from the main thread, which renews the session. It is reused for a
// few minutes, so the drive keeps working while the main thread is busy.
const TOKEN_REUSE_MS = 4 * 60_000;
let token: { value: string; at: number } | undefined;
let asked = 0;
const waiting = new Map<number, { resolve: (token: string) => void; reject: (e: Error) => void }>();
function askToken(refresh: boolean) {
  const id = ++asked;
  return new Promise<string>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    send({ type: 'token', id, refresh });
  }).then((value) => {
    token = { value, at: Date.now() };
    return value;
  });
}

let dav: DriveDav | undefined;
async function start(config: DavWorkerConfig) {
  const transport = retrying(
    createTransport(
      config.apiUrl,
      async () => (token && Date.now() - token.at < TOKEN_REUSE_MS ? token.value : askToken(false)),
      async () => void (await askToken(true)),
    ),
  );
  // Names are decrypted on the way back and encrypted on the way out, as in the main thread;
  // the main thread follows the account's encryption and sends the vault when it changes.
  const api = new ApiClient(
    e2eeTransport(transport, { vault: () => vault, onAccount: () => {}, strict: true }),
  );
  dav = new DriveDav({
    ...config,
    drive: apiDrive(api),
    onError: (error) => send({ type: 'error', message: describe(error) }),
  });
  await dav.start();
}
const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

port.on('message', (message: DavHostMessage) => {
  switch (message.type) {
    case 'start':
      vault = message.vault;
      start(message.config).then(
        () => send({ type: 'started' }),
        (error) => send({ type: 'failed', message: (error as Error).message }),
      );
      break;
    case 'vault':
      vault = message.vault;
      dav?.forget();
      break;
    case 'token': {
      const request = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.token) request?.resolve(message.token);
      // The drive answers 503 and asks for a new sign-in, rather than rejecting the password.
      else request?.reject(new ApiError('SESSION_ENDED', message.error ?? 'Signed out.', 401));
      break;
    }
    case 'forget':
      // A change elsewhere, or this server's own upload coming back: read again behind.
      dav?.refresh();
      break;
    case 'stop':
      // Empty files still waiting for content are uploaded before the thread ends.
      void (dav?.stop() ?? Promise.resolve()).finally(() => send({ type: 'stopped' }));
      break;
  }
});
