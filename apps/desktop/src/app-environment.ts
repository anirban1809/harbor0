import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  desktopConfiguration,
  loadDesktopEnvironment,
  loadBundledDesktopConfiguration,
} from './config';

/**
 * Names the app, picks its data folder and loads its connection settings. The window app and
 * `harbor0 webdav` both run this first, so they share credentials and settings.
 */
export function prepareAppEnvironment() {
  // Keep existing credentials and sync state when the display name changes.
  const legacyDataPath = app.isPackaged
    ? path.join(app.getPath('appData'), 'Harbor')
    : app.getPath('userData');
  const userDataPath = existsSync(legacyDataPath) ? legacyDataPath : app.getPath('userData');
  app.setName('harbor0');
  app.setPath('userData', userDataPath);
  // Development launches load public connection settings beside package.json.
  // Packaged applications load public release settings, with shell overrides.
  if (!app.isPackaged) loadDesktopEnvironment(path.resolve(__dirname, '..'), process.env);
  else loadBundledDesktopConfiguration(__dirname, process.env);
  return desktopConfiguration(process.env, app.isPackaged);
}
