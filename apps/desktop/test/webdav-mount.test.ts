import { describe, expect, it } from 'vitest';
import { macMountPoint, windowsDrive } from '../src/webdav-mount';

describe('WebDAV drives in Finder and File Explorer', () => {
  it('finds where Finder mounted the server', () => {
    const listing = [
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      'http://127.0.0.1:6810/ on /Volumes/127.0.0.1 (webdav, nodev, noexec, nosuid, mounted by a)',
      'http://127.0.0.1:6810/harbor0/ on /Users/a/Library/Application Support/Harbor/WebDAV/harbor0 (webdav, nodev, noexec, nosuid, mounted by a)',
    ].join('\n');
    expect(macMountPoint(listing, 'http://127.0.0.1:6810/harbor0/')).toBe(
      '/Users/a/Library/Application Support/Harbor/WebDAV/harbor0',
    );
    expect(macMountPoint(listing, 'http://127.0.0.1:6811/harbor0/')).toBeUndefined();
  });

  it('finds the drive letter File Explorer mapped to the server', () => {
    const listing = [
      'New connections will not be remembered.',
      '',
      'Status       Local     Remote                    Network',
      '-------------------------------------------------------------------------------',
      'OK           H:        \\\\nas\\photos             Microsoft Windows Network',
      '             Z:        \\\\127.0.0.1@6810\\s3cr3t\\harbor0',
      '                                                Web Client Network',
      'The command completed successfully.',
    ].join('\r\n');
    expect(windowsDrive(listing, 'http://127.0.0.1:6810/s3cr3t/harbor0/')).toBe('Z:');
    expect(windowsDrive(listing, 'http://127.0.0.1:6810/other/harbor0/')).toBeUndefined();
  });
});
