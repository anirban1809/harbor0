import Link from 'next/link';
import type { AuditEntry } from '../../../packages/contracts/src/admin';
import { actionLabels, bytes, date, relative } from '../lib/format';

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
