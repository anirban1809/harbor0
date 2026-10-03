import { Badge } from '../../web/components/ui/badge';
import type { AccountStatus } from '../../../packages/contracts/src/admin';

const statusText: Partial<Record<AccountStatus, [string, 'warning' | 'neutral' | 'danger']>> = {
  UNCONFIRMED: ['Unverified', 'warning'],
  RESET_REQUIRED: ['Password reset pending', 'warning'],
  FORCE_CHANGE_PASSWORD: ['Must change password', 'warning'],
};

export function StatusBadges({
  status,
  enabled,
  suspended,
  deleted,
}: {
  status: AccountStatus;
  enabled: boolean;
  suspended: boolean;
  deleted: boolean;
}) {
  if (deleted) return <Badge tone="danger">Deleted</Badge>;
  // A profile without a sign-in account: removed from Cognito without deleting the account.
  if (status === 'UNKNOWN' && !enabled && !suspended)
    return <Badge tone="warning">No sign-in</Badge>;
  const badges = [];
  if (suspended)
    badges.push(
      <Badge key="s" tone="danger">
        Suspended
      </Badge>,
    );
  else if (!enabled)
    badges.push(
      <Badge key="d" tone="danger">
        Sign-in disabled
      </Badge>,
    );
  const s = statusText[status];
  if (s)
    badges.push(
      <Badge key="st" tone={s[1]}>
        {s[0]}
      </Badge>,
    );
  if (!badges.length)
    badges.push(
      <Badge key="a" tone="success">
        Active
      </Badge>,
    );
  return <span className="admin-badges">{badges}</span>;
}
