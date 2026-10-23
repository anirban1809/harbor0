import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTrayOnly, readTrayOnly, trayOnlySupported, writeTrayOnly } from '../src/tray-only';

describe('tray-only setting', () => {
  it('is off until saved, and survives a restart', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harbor-tray-only-'));
    const file = path.join(dir, 'window.json');
    try {
      expect(await readTrayOnly(file)).toBe(false);
      await writeTrayOnly(file, true);
      expect(await readTrayOnly(file)).toBe(true);
      await writeTrayOnly(file, false);
      expect(await readTrayOnly(file)).toBe(false);
      for (const content of ['not json', '{"trayOnly":"yes"}', 'null']) {
        writeFileSync(file, content);
        expect(await readTrayOnly(file)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('is offered on macOS and Windows only', () => {
    expect(trayOnlySupported('darwin')).toBe(true);
    expect(trayOnlySupported('win32')).toBe(true);
    expect(trayOnlySupported('linux')).toBe(false);
  });
  it('hides and shows the Dock icon on macOS', async () => {
    const dock = { hide: vi.fn(), show: vi.fn(async () => {}) };
    const window = { setSkipTaskbar: vi.fn(), isDestroyed: () => false };
    await applyTrayOnly({ platform: 'darwin', dock, window }, true);
    expect(dock.hide).toHaveBeenCalledOnce();
    await applyTrayOnly({ platform: 'darwin', dock, window }, false);
    expect(dock.show).toHaveBeenCalledOnce();
    expect(window.setSkipTaskbar).not.toHaveBeenCalled();
  });
  it('drops the taskbar button on Windows and leaves Linux alone', async () => {
    const window = { setSkipTaskbar: vi.fn(), isDestroyed: () => false };
    await applyTrayOnly({ platform: 'win32', window }, true);
    await applyTrayOnly({ platform: 'win32', window }, false);
    expect(window.setSkipTaskbar.mock.calls).toEqual([[true], [false]]);
    await applyTrayOnly({ platform: 'linux', window }, true);
    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(2);
    const closed = { setSkipTaskbar: vi.fn(), isDestroyed: () => true };
    await applyTrayOnly({ platform: 'win32', window: closed }, true);
    expect(closed.setSkipTaskbar).not.toHaveBeenCalled();
  });
});
