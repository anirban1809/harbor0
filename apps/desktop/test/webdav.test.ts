import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WEBDAV_PORT,
  MissingWebdavKey,
  ensureWebdavKey,
  parseWebdavArgs,
  type WebdavKey,
} from '../src/webdav';

const apiUrl = 'https://api.example.test';
const savedKey: WebdavKey = {
  apiUrl,
  userId: 'user-1',
  email: 'a@example.test',
  tokenId: 'device-1',
  token: 'h0_pat_old',
};
const owner = (id: string | null) =>
  vi.fn(async () => (id ? { id, email: 'a@example.test', allowed: true, encrypted: false } : null));

describe('local WebDAV server', () => {
  it('parses the harbor0 webdav command line', () => {
    expect(parseWebdavArgs([])).toEqual({
      help: false,
      port: DEFAULT_WEBDAV_PORT,
      readOnly: false,
    });
    expect(parseWebdavArgs(['--port=7001', '--read-only'])).toEqual({
      help: false,
      port: 7001,
      readOnly: true,
    });
    expect(parseWebdavArgs(['-h'])).toEqual({ help: true });
    expect(() => parseWebdavArgs(['--port', '80'])).toThrow(/1024 to 65535/);
    expect(() => parseWebdavArgs(['--bogus'])).toThrow(/Unknown option/);
  });

  it('reuses a saved key that still works for the signed-in account', async () => {
    const mint = vi.fn();
    const key = await ensureWebdavKey({
      apiUrl,
      userId: 'user-1',
      load: async () => savedKey,
      save: async () => {},
      mint,
      owner: owner('user-1'),
    });
    expect(key.token).toBe('h0_pat_old');
    expect(mint).not.toHaveBeenCalled();
  });

  it('replaces a revoked key', async () => {
    const save = vi.fn(async () => {});
    const check = vi.fn(async (_url: string, token: string) =>
      token === 'h0_pat_new'
        ? { id: 'user-1', email: 'a@example.test', allowed: true, encrypted: false }
        : null,
    );
    const key = await ensureWebdavKey({
      apiUrl,
      userId: 'user-1',
      load: async () => savedKey,
      save,
      mint: async () => ({ token: 'h0_pat_new', tokenId: 'device-2' }),
      owner: check,
    });
    expect(key).toMatchObject({ token: 'h0_pat_new', tokenId: 'device-2' });
    expect(save).toHaveBeenCalledWith(key);
  });

  it('makes a new key when the app signed in to another account', async () => {
    const key = await ensureWebdavKey({
      apiUrl,
      userId: 'user-2',
      load: async () => savedKey,
      save: async () => {},
      mint: async () => ({ token: 'h0_pat_new', tokenId: 'device-2' }),
      owner: owner('user-2'),
    });
    expect(key).toMatchObject({ userId: 'user-2', token: 'h0_pat_new' });
  });

  it('asks for a new key when there is none and it cannot make one', async () => {
    await expect(
      ensureWebdavKey({ apiUrl, load: async () => undefined, save: async () => {} }),
    ).rejects.toBeInstanceOf(MissingWebdavKey);
  });
});
