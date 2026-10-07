import Link from 'next/link';
import type { AuditEntry } from '../../../packages/contracts/src/admin';
import { actionLabels, bytes, date, flagModeLabels, relative } from '../lib/format';

function detail(entry: AuditEntry) {
  const d = entry.details as Record<string, unknown>;
  if (entry.action === 'QUOTA_CHANGED')
    return `${bytes(d.previousBytes as number)} → ${bytes(d.quotaBytes as number)}`;
  if (entry.action === 'DEVICE_SIGNED_OUT') return String(d.deviceName ?? '');
  if (entry.action === 'SIGNED_OUT_EVERYWHERE')
    return `${d.sessions} active session${d.sessions === 1 ? '' : 's'} ended`;
  if (entry.action === 'ACCOUNT_DELETED' && d.purgeAt)
    return `Files purged after ${date(d.purgeAt as string)}`;
  if (entry.action === 'ACCOUNT_PURGED')
    return `${bytes(d.usedBytes as number)}; was due ${date(d.previousPurgeAt as string)}`;
  if (entry.action === 'BETA_WAVE')
    return `${d.cap} seats, ${d.invited} invited from the waitlist`;
  if (entry.action === 'FLAG_CHANGED') {
    const before = d.before as { mode: keyof typeof flagModeLabels; percent: number };
    const after = d.after as typeof before;
    const parts = [String(d.key)];
    if (before.mode !== after.mode)
      parts.push(`${flagModeLabels[before.mode]} → ${flagModeLabels[after.mode]}`);
    if (before.percent !== after.percent) parts.push(`${before.percent}% → ${after.percent}%`);
    const added = d.added as string[];
    const removed = d.removed as string[];
    if (added.length) parts.push(`added ${added.join(', ')}`);
    if (removed.length) parts.push(`removed ${removed.join(', ')}`);
    return parts.join(' · ');
  }
  if (entry.action === 'FLAG_USER_ADDED' || entry.action === 'FLAG_USER_REMOVED')
    return String(d.key);
  return null;
}

/** Audit entries, newest first. `showUser` links each entry to its account. */
export function AuditList({ items, showUser }: { items: AuditEntry[]; showUser?: boolean }) {
  if (!items.length) return <p className="admin-empty">Nothing recorded yet.</p>;
  return (
    <ol className="admin-audit">
      {items.map((entry) => {
        const extra = detail(entry);
        return (
          <li key={entry.id} data-action={entry.action}>
            <div className="admin-audit-line">
              <strong>{actionLabels[entry.action] ?? entry.action}</strong>
              {showUser && entry.userId && (
                <>
                  {' · '}
                  <Link href={`/user?id=${encodeURIComponent(entry.userId)}`}>
                    {entry.userEmail ?? entry.userId}
                  </Link>
                </>
              )}
              <time dateTime={entry.at} title={date(entry.at)}>
                {relative(entry.at)}
              </time>
            </div>
            {entry.action === 'NOTE' ? (
              <p className="admin-note">{String(entry.details.text ?? '')}</p>
            ) : (
              (extra || entry.reason) && (
                <p className="admin-audit-meta">
                  {extra}
                  {extra && entry.reason && ' — '}
                  {entry.reason && <q>{entry.reason}</q>}
                </p>
              )
            )}
            <p className="admin-audit-actor">by {entry.actor.email}</p>
          </li>
        );
      })}
    </ol>
  );
}
