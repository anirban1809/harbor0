import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { Journal } from './journal';

/** Preserve the original database in place; additional accounts get independent journals. */
export class AccountProfiles {
  private journals = new Map<string, Journal>();
  private directory: string;
  readonly legacy: Journal;

  constructor(
    directory: string,
    private server: string,
  ) {
    this.directory = path.join(directory, 'accounts');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.legacy = new Journal(path.join(directory, 'harbor.sqlite'));
    if (server && this.legacy.get('accountId') && !this.legacy.get('server'))
      this.legacy.set('server', server);
  }

  private open(filename: string) {
    let journal = this.journals.get(filename);
    if (!journal) {
      journal = new Journal(path.join(this.directory, filename));
      this.journals.set(filename, journal);
    }
    return journal;
  }

  select(accountId: string) {
    const legacyAccount = this.legacy.get<string>('accountId');
    const legacyServer = this.legacy.get<string>('server');
    const original = legacyAccount === accountId && (!legacyServer || legacyServer === this.server);
    const key = createHash('sha256')
      .update(JSON.stringify([this.server, accountId]))
      .digest('hex');
    const journal = original ? this.legacy : this.open(`${key}.sqlite`);
    journal.set('accountId', accountId);
    journal.set('server', this.server);
    return journal;
  }

  assertAvailable(localPath: string, active: Journal) {
    // Include accounts from earlier launches, not just those opened in this process.
    for (const filename of readdirSync(this.directory))
      if (/^[a-f0-9]{64}\.sqlite$/.test(filename)) this.open(filename);
    const normalize = (value: string) => {
      let resolved = path.resolve(value);
      let ancestor = resolved;
      const missing: string[] = [];
      for (;;) {
        try {
          resolved = path.join(realpathSync.native(ancestor), ...missing);
          break;
        } catch {
          // Resolve existing ancestors even when a saved folder is missing/offline.
          const parent = path.dirname(ancestor);
          if (parent === ancestor) break;
          missing.unshift(path.basename(ancestor));
          ancestor = parent;
        }
      }
      return process.platform === 'linux' ? resolved : resolved.toLowerCase();
    };
    const contains = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      );
    };
    const selected = normalize(localPath);
    for (const journal of [this.legacy, ...this.journals.values()]) {
      if (journal === active) continue;
      for (const root of journal.roots()) {
        const other = normalize(root.localPath);
        if (contains(selected, other) || contains(other, selected))
          throw new Error(
            'This local folder is linked to another account. Choose a separate folder, or sign in to that account and remove its folder connection first.',
          );
      }
    }
  }

  close() {
    this.legacy.close();
    for (const journal of this.journals.values()) journal.close();
  }
}
