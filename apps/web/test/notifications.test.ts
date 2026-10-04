import { describe, expect, it } from 'vitest';
import { describeNotification, newestFirst, type ServerNotification } from '../lib/notifications';

const n = (type: string, data: ServerNotification['data'] = {}): ServerNotification => ({
  id: type,
  type,
  data,
  readAt: null,
  createdAt: '2026-10-01T00:00:00Z',
});

describe('notifications', () => {
  it('names who did what and links to where it happened', () => {
    expect(
      describeNotification(n('TRANSFER_RECEIVED', { actorName: 'Rae', itemName: 'Q3.pdf' })),
    ).toEqual({
      title: 'Rae sent you “Q3.pdf”',
      href: '/shared',
    });
    expect(describeNotification(n('TRANSFER_DECLINED', { actorName: 'Rae' }))).toEqual({
      title: 'Rae declined your transfer',
      href: '/shared?tab=sent',
    });
    expect(
      describeNotification(n('TRANSFER_CANCELLED', { actorName: 'Sam', itemName: 'a.zip' })).title,
    ).toBe('Sam cancelled the transfer of “a.zip”');
    expect(
      describeNotification(n('SHARE_RECEIVED', { actorName: 'Sam', itemName: 'Plans' })),
    ).toEqual({
      title: 'Sam shared “Plans” with you',
      href: '/shared',
    });
    expect(
      describeNotification(n('SHARE_REVOKED', { actorName: 'Sam', itemName: 'Plans' })).title,
    ).toBe('Sam removed your access to “Plans”');
    expect(
      describeNotification(
        n('SHARED_UPLOAD_BLOCKED_BY_STORAGE', { actorName: 'Kim', itemName: 'Team' }),
      ),
    ).toEqual({
      title: 'Kim couldn’t upload to “Team” because your storage is full',
      href: '/storage',
    });
  });
  it('still reads well without names or for unknown types', () => {
    expect(describeNotification(n('TRANSFER_RECEIVED')).title).toBe('Someone sent you files');
    expect(describeNotification({ ...n('SHARE_RECEIVED'), data: undefined }).title).toBe(
      'Someone shared an item with you',
    );
    expect(describeNotification(n('FOLDER_RENAMED', { itemName: 'Plans' }))).toEqual({
      title: 'Folder renamed: Plans',
    });
  });
  it('lists the newest first', () => {
    const items = [
      { id: 'a', createdAt: '2026-10-01T00:00:00Z' },
      { id: 'b', createdAt: '2026-10-03T00:00:00Z' },
      { id: 'c', createdAt: '2026-10-02T00:00:00Z' },
    ];
    expect(newestFirst(items).map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });
});
