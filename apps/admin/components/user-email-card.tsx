'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminUserEmail } from '../../../packages/contracts/src/admin';
import { Alert } from '../../web/components/ui/alert';
import { Badge } from '../../web/components/ui/badge';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { Select } from '../../web/components/ui/select';
import { useCan } from './shell';
import { api } from '../lib/api';
import { date } from '../lib/format';

/** What email the account gets: product updates, any bounce or complaint, and its groups. */
export function UserEmailCard({ userId, email }: { userId: string; email: AdminUserEmail }) {
  const queries = useQueryClient();
  const canEdit = useCan('campaigns');
  const [adding, setAdding] = useState('');
  const [error, setError] = useState('');
  const groups = useQuery({ queryKey: ['email-groups'], queryFn: api.groups, enabled: canEdit });
  const available = groups.data?.items.filter((g) => !email.groups.some((m) => m.id === g.id)) ?? [];
  const change = async (work: () => Promise<unknown>) => {
    setError('');
    try {
      await work();
      setAdding('');
      void queries.invalidateQueries({ queryKey: ['user', userId] });
      void queries.invalidateQueries({ queryKey: ['email-groups'] });
      void queries.invalidateQueries({ queryKey: ['audit'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title="Email" description="Campaign email this account gets. Account notices are always sent.">
      <dl className="admin-facts">
        <dt>Product updates</dt>
        <dd>
          {email.productUpdates ? (
            <Badge tone="success">On</Badge>
          ) : (
            <Badge>Unsubscribed</Badge>
          )}
        </dd>
        {email.suppressed && (
          <>
            <dt>Delivery</dt>
            <dd>
              <Badge tone="danger">
                {email.suppressed.source === 'BOUNCE' ? 'Address bounced' : 'Marked as spam'}
              </Badge>{' '}
              <span className="admin-muted">
                {date(email.suppressed.at)}; campaigns skip this address.
              </span>
            </dd>
          </>
        )}
        <dt>Groups</dt>
        <dd>{!email.groups.length && <span className="admin-muted">None</span>}</dd>
      </dl>
      {email.groups.length > 0 && (
        <ul className="admin-flag-users">
          {email.groups.map((g) => (
            <li key={g.id}>
              <Link href={`/email-groups?id=${encodeURIComponent(g.id)}`}>{g.name}</Link>
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void change(() => api.removeGroupMembers(g.id, [userId]))}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && available.length > 0 && (
        <div className="admin-flag-add">
          <Select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Group">
            <option value="">Add to a group…</option>
            {available.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            disabled={!adding}
            onClick={() => void change(() => api.addGroupMembers(adding, { userIds: [userId] }))}
          >
            Add
          </Button>
        </div>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </Card>
  );
}
