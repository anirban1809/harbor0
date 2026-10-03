import { bytes } from '../lib/format';

/** Used storage against the limit; turns amber at 90% and red when over. */
export function StorageMeter({
  used,
  quota,
  compact,
}: {
  used: number | null;
  quota: number | null;
  compact?: boolean;
}) {
  if (used == null || quota == null) return <span className="admin-muted">Not set up</span>;
  const ratio = quota > 0 ? used / quota : used > 0 ? Infinity : 0;
  const tone = ratio > 1 ? 'danger' : ratio >= 0.9 ? 'warning' : 'accent';
  return (
    <div className="admin-meter" data-compact={compact || undefined}>
      <div
        className="admin-meter-track"
        role="meter"
        aria-label="Storage used"
        aria-valuemin={0}
        aria-valuemax={quota}
        aria-valuenow={Math.min(used, quota)}
      >
        <div
          className="admin-meter-fill"
          data-tone={tone}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
      <span className="admin-meter-label">
        {bytes(used)} <span className="admin-muted">of {bytes(quota)}</span>
      </span>
    </div>
  );
}
