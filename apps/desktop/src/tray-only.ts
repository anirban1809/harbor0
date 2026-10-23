import { readFile, writeFile } from 'node:fs/promises';

/**
 * "Show in menu bar only" (macOS) / "Show in system tray only" (Windows): the app leaves the Dock
 * or taskbar and opens from its tray icon. Linux trays vary too much to rely on, so it's not
 * offered there.
 */
export const trayOnlySupported = (platform: NodeJS.Platform) =>
  platform === 'darwin' || platform === 'win32';

export async function readTrayOnly(file: string): Promise<boolean> {
  try {
    return JSON.parse(await readFile(file, 'utf8')).trayOnly === true;
  } catch {
    return false;
  }
}
export const writeTrayOnly = (file: string, trayOnly: boolean) =>
  writeFile(file, JSON.stringify({ trayOnly }) + '\n', { mode: 0o600 });

/** The parts of Electron's app and window this changes, so it can be tested without Electron. */
export type TrayOnlyTarget = {
  platform: NodeJS.Platform;
  dock?: { hide(): void; show(): Promise<void> | void };
  window?: { setSkipTaskbar(skip: boolean): void; isDestroyed(): boolean };
};

/** Hides or shows the Dock icon (macOS) or the window's taskbar button (Windows). */
export async function applyTrayOnly(target: TrayOnlyTarget, trayOnly: boolean) {
  const on = trayOnly && trayOnlySupported(target.platform);
  if (target.platform === 'darwin') {
    if (on) target.dock?.hide();
    else await target.dock?.show();
  } else if (target.platform === 'win32' && target.window && !target.window.isDestroyed()) {
    target.window.setSkipTaskbar(on);
  }
}
