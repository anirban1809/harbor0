import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { E2eeVaultView } from '../../../packages/api-client/src/e2ee-transport';
import type { DriveDavOptions } from './drive-dav';

/** What the WebDAV thread needs to start; the drive itself it builds there. */
export type DavWorkerConfig = Omit<DriveDavOptions, 'drive' | 'onError'> & { apiUrl: string };
export type DavHostMessage =
  | { type: 'start'; config: DavWorkerConfig; vault: E2eeVaultView }
  | { type: 'vault'; vault: E2eeVaultView }
  | { type: 'token'; id: number; token?: string; error?: string }
  | { type: 'forget' }
  | { type: 'stop' };
export type DavWorkerMessage =
  | { type: 'started' }
  | { type: 'failed'; message: string }
  | { type: 'token'; id: number; refresh: boolean }
  | { type: 'error'; message: string }
  | { type: 'stopped' };

const STOP_TIMEOUT_MS = 15_000;

/**
 * The local WebDAV server, run on its own thread (dav-worker.ts) so that nothing the main
 * thread waits on can stop it answering Finder or File Explorer.
 */
export class DavHost {
  private worker?: Worker;
  private started = false;
  constructor(
    private hooks: {
      /** An access token for the account; a fresh one when `refresh` is set. */
      token: (refresh: boolean) => Promise<string>;
      vault: () => E2eeVaultView;
      onError: (message: string) => void;
      /** The thread ended without stop() being called. */
      onExit: (reason: string) => void;
      /** The bundled worker; dav-worker.cjs beside the main bundle. */
      script?: string;
    },
  ) {}

  get running() {
    return !!this.worker && this.started;
  }

  async start(config: DavWorkerConfig) {
    await this.stop();
    const worker = new Worker(this.hooks.script ?? path.join(__dirname, 'dav-worker.cjs'));
    this.worker = worker;
    const post = (message: DavHostMessage) => worker.postMessage(message);
    await new Promise<void>((resolve, reject) => {
      worker.on('message', (message: DavWorkerMessage) => {
        switch (message.type) {
          case 'started':
            this.started = true;
            return resolve();
          case 'failed':
            return reject(new Error(message.message));
          case 'token':
            this.hooks.token(message.refresh).then(
              (token) => post({ type: 'token', id: message.id, token }),
              (error) => post({ type: 'token', id: message.id, error: (error as Error).message }),
            );
            return;
          case 'error':
            return this.hooks.onError(message.message);
        }
      });
      worker.once('error', (error) => reject(error));
      worker.once('exit', (code) => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        const wasRunning = this.started;
        this.started = false;
        if (wasRunning) this.hooks.onExit(`The WebDAV server stopped (exit code ${code}).`);
        reject(new Error(`The WebDAV server couldn't start (exit code ${code}).`));
      });
      post({ type: 'start', config, vault: this.hooks.vault() });
    }).catch(async (error) => {
      await this.stop();
      throw error;
    });
  }

  /** The account's encryption changed, or it was locked or unlocked. */
  updateVault() {
    this.worker?.postMessage({ type: 'vault', vault: this.hooks.vault() } satisfies DavHostMessage);
  }

  /** Something changed elsewhere: listings are read again. */
  forget() {
    this.worker?.postMessage({ type: 'forget' } satisfies DavHostMessage);
  }

  async stop() {
    const worker = this.worker;
    this.worker = undefined;
    this.started = false;
    if (!worker) return;
    const stopped = new Promise<void>((resolve) => {
      worker.on('message', (message: DavWorkerMessage) => {
        if (message.type === 'stopped') resolve();
      });
      worker.once('exit', () => resolve());
    });
    worker.postMessage({ type: 'stop' } satisfies DavHostMessage);
    const timer = setTimeout(() => void worker.terminate(), STOP_TIMEOUT_MS);
    await stopped;
    clearTimeout(timer);
    await worker.terminate();
  }

  /** For quitting, which can't wait. */
  kill() {
    void this.worker?.terminate();
    this.worker = undefined;
    this.started = false;
  }
}
