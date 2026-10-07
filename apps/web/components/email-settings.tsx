'use client';
import { Card } from './ui/card';
import { Checkbox } from './ui/checkbox';

/** Optional email the account can turn off. Security and account notices are always sent. */
export function EmailSettings({
  productUpdates,
  busy,
  save,
}: {
  productUpdates: boolean;
  busy: boolean;
  save: (productUpdates: boolean) => void;
}) {
  return (
    <Card
      className="panel"
      title="Email"
      description="Emails about your account's security, storage and billing are always sent."
    >
      <label className="choice">
        <Checkbox
          checked={productUpdates}
          disabled={busy}
          onChange={(event) => save(event.target.checked)}
        />
        <span>
          <strong>Product updates</strong>
          <span className="muted">New features and changes to harbor0, a few times a year.</span>
        </span>
      </label>
    </Card>
  );
}
