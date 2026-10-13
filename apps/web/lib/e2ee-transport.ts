import type { Transport } from '@harbor/api-client';
import {
  e2eeTransport as sharedTransport,
  guessMime,
} from '../../../packages/api-client/src/e2ee-transport';
import { currentVault, setAccount } from './e2ee-vault';

export { guessMime };

/** This tab's encryption, applied to every request; see the shared transport. */
export const e2eeTransport = (inner: Transport): Transport =>
  sharedTransport(inner, { vault: currentVault, onAccount: setAccount });
