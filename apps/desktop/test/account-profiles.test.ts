import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountProfiles } from '../src/account-profiles';
import { Journal, type Root } from '../src/journal';

let directory: string;
let profiles: AccountProfiles;
const root: Root = {
  id: 'root',
  localPath: '/tmp/alice-files',
  remoteId: 'cloud-alice',
  mode: 'sync',
  paused: true,
  excluded: ['private'],
};
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'harbor-accounts-'));
  const legacy = new Journal(path.join(directory, 'harbor.sqlite'));
  legacy.set('accountId', 'alice');
  legacy.set('publicId', 'original-device');
  legacy.set('paused', true);
  legacy.root(root);
  legacy.enqueue(root.id, 'pending.txt', 'upsert');
  legacy.set('syncCursor', 37);
  legacy.close();
  profiles = new AccountProfiles(directory, 'https://api.example');
});
afterEach(() => {
  profiles.close();
  rmSync(directory, { recursive: true, force: true });
});
it('preserves the original account and restores its roots, queue, settings and device identity', () => {
  const alice = profiles.select('alice');
  const bob = profiles.select('bob');
  expect(bob.roots()).toEqual([]);
  expect(bob.jobs()).toEqual([]);
  expect(bob.get('paused')).toBeUndefined();
  expect(bob.get('syncCursor')).toBeUndefined();
  expect(bob.devicePublicId()).not.toBe(alice.devicePublicId());
  bob.set('paused', false);
  expect(profiles.select('alice')).toBe(alice);
  expect(alice.roots()).toEqual([root]);
  expect(alice.jobs()).toHaveLength(1);
  expect(alice.get('paused')).toBe(true);
  expect(alice.get('syncCursor')).toBe(37);
  expect(alice.devicePublicId()).toBe('original-device');
});
it('restores additional accounts after restart and separates servers and unsafe account IDs', () => {
  const bob = profiles.select('../bob');
  bob.root({ ...root, id: 'bob-root', localPath: '/tmp/bob-files' });
  const deviceId = bob.devicePublicId();
  profiles.close();
  profiles = new AccountProfiles(directory, 'https://api.example');
  expect(profiles.select('../bob').devicePublicId()).toBe(deviceId);
  expect(profiles.select('../bob').roots()[0].id).toBe('bob-root');
  profiles.close();
  profiles = new AccountProfiles(directory, 'https://other.example');
  expect(profiles.select('../bob').roots()).toEqual([]);
  expect(profiles.select('alice').roots()).toEqual([]);
});
it('blocks overlapping local folders across accounts, including accounts from previous launches', () => {
  profiles.select('bob').root({ ...root, localPath: '/tmp/bob-files' });
  profiles.close();
  profiles = new AccountProfiles(directory, 'https://api.example');
  const alice = profiles.select('alice');
  for (const selected of ['/tmp/bob-files', '/tmp/bob-files/child', '/tmp'])
    expect(() => profiles.assertAvailable(selected, alice)).toThrow('another account');
  expect(() => profiles.assertAvailable('/tmp/bob-files-other', alice)).not.toThrow();
  expect(() => profiles.assertAvailable(root.localPath, alice)).not.toThrow();
});
