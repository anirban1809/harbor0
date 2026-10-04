import { describe, expect, it } from 'vitest';
import { canWriteIn, itemAccess } from '../lib/drive-access';

describe('share permissions', () => {
  it('lets the owner do everything', () => {
    expect(itemAccess({})).toEqual({ owner: true, edit: true, manage: true, share: true });
    expect(itemAccess({}, undefined)).toMatchObject({ manage: true });
  });
  it('lets a viewer only look', () => {
    expect(itemAccess({ access: 'VIEWER' }, 'VIEWER')).toEqual({
      owner: false,
      edit: false,
      manage: false,
      share: false,
    });
    expect(canWriteIn('VIEWER')).toBe(false);
  });
  it('lets an editor change content inside the shared folder but not share it on', () => {
    expect(itemAccess({ access: 'EDITOR' }, 'EDITOR')).toEqual({
      owner: false,
      edit: true,
      manage: true,
      share: false,
    });
    expect(canWriteIn('EDITOR')).toBe(true);
    expect(canWriteIn(undefined)).toBe(true);
  });
  it('keeps the shared item itself for its owner to rename, move or trash', () => {
    expect(itemAccess({ access: 'EDITOR' })).toMatchObject({ edit: true, manage: false });
  });
});
