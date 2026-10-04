import { RefreshCw } from 'lucide-react';
import { Alert } from '../../web/components/ui/alert';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { Skeleton } from '../../web/components/ui/skeleton';
import type { StorageTotals } from '../../../packages/contracts/src/admin';
import { bytes, date, relative } from '../lib/format';
import { StorageMeter } from './storage-meter';

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="admin-stat">
      <span className="admin-stat-label">{label}</span>
      <span className="admin-stat-value">{value}</span>
      {hint && <span className="admin-stat-hint">{hint}</span>}
    </div>
  );
}

/** Storage used and allocated across every account, with how fresh the figures are. */
export function StorageTotalsCard({
  totals,
  estimatedUsers,
  pending,
  refreshing,
  onRefresh,
}: {
  totals: StorageTotals | null;
  estimatedUsers: number | null;
  pending: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const percent =
    totals && totals.allocatedBytes > 0
      ? `${((totals.usedBytes / totals.allocatedBytes) * 100).toFixed(totals.usedBytes / totals.allocatedBytes < 0.01 ? 2 : 1)}% of allocated storage is in use`
      : undefined;
  return (
    <Card
      title="Storage across all accounts"
      description={
        totals ? (
          <span title={date(totals.computedAt)}>Updated {relative(totals.computedAt)}</span>
        ) : (
          'Totals are recalculated at most every 15 minutes.'
        )
      }
      action={
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={pending || refreshing}>
          <RefreshCw aria-hidden="true" className={refreshing ? 'admin-spin' : undefined} />
          Refresh
        </Button>
      }
    >
      {pending || !totals ? (
        <Skeleton className="admin-skeleton-block" />
      ) : (
        <>
          <div className="admin-stats">
            <Stat
              label="Storage used"
              value={bytes(totals.usedBytes)}
              hint="Files, versions, backups and trash"
            />
            <Stat
              label="Storage allocated"
              value={bytes(totals.allocatedBytes)}
              hint="Sum of every account's limit"
            />
            <Stat
              label="Accounts"
              value={totals.accounts.toLocaleString()}
              hint={
                estimatedUsers != null && estimatedUsers > totals.accounts
                  ? `${(estimatedUsers - totals.accounts).toLocaleString()} more signed up but not verified`
                  : 'With a drive'
              }
            />
            <Stat
              label="Awaiting deletion"
              value={bytes(totals.pendingDeletionBytes)}
              hint={`Emptied trash and ${totals.deletedAccounts.toLocaleString()} deleted account${totals.deletedAccounts === 1 ? '' : 's'}`}
            />
          </div>
          <StorageMeter used={totals.usedBytes} quota={totals.allocatedBytes} />
          {percent && <p className="admin-muted admin-totals-note">{percent}.</p>}
          {totals.orphans.accounts > 0 && (
            <Alert tone="warning" role="none" className="admin-totals-note">
              Not counted: {totals.orphans.accounts.toLocaleString()} account record
              {totals.orphans.accounts === 1 ? '' : 's'} whose sign-in no longer exists (
              {bytes(totals.orphans.usedBytes)} stored, {bytes(totals.orphans.allocatedBytes)}{' '}
              allocated). They were removed from Cognito without deleting the account, e.g. by an
              old validation script.
            </Alert>
          )}
          {(totals.reservedBytes > 0 || totals.trashBytes > 0) && (
            <p className="admin-muted admin-totals-note">
              Includes {bytes(totals.trashBytes)} in trash; {bytes(totals.reservedBytes)} more is
              reserved by uploads in progress.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
