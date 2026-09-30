import type { StorageUsage } from '@harbor/contracts';
import { Badge } from '../../web/components/ui/badge';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { Progress } from '../../web/components/ui/progress';

const count = (value: number) => value.toLocaleString();
export function storageSize(bytes: number) {
  if (bytes < 1000) return `${count(bytes)} B`;
  const unit = Math.min(4, Math.floor(Math.log10(bytes) / 3));
  return `${(bytes / 1000 ** unit).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
export function StoragePanel({
  storage,
  error,
  retry,
}: {
  storage: StorageUsage | null;
  error: boolean;
  retry: () => void;
}) {
  const percent =
    storage && storage.quotaBytes > 0 ? (storage.usedBytes / storage.quotaBytes) * 100 : 0;
  const percentLabel =
    percent > 0 && percent < 0.01
      ? '<0.01'
      : percent.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <Card
      className="panel capacity storage-overview"
      aria-label="Storage usage"
      title="Your storage"
      description="Shared across all your devices"
      action={storage && <Badge className="usage-percent">{percentLabel}% used</Badge>}
    >
      {!storage ? (
        <div className="storage-placeholder" role="status">
          {error ? (
            <>
              Storage usage is unavailable.{' '}
              <Button variant="outline" onClick={retry}>
                Retry storage
              </Button>
            </>
          ) : (
            'Loading storage usage…'
          )}
        </div>
      ) : (
        <>
          <p className="storage-amount">
            <strong>{storageSize(storage.usedBytes)}</strong>
            <span>of {storageSize(storage.quotaBytes)} used</span>
          </p>
          <Progress
            max={100}
            value={Math.min(100, percent)}
            aria-label="Storage used"
            aria-valuetext={`${percentLabel}% used`}
          />
          <div className="storage-details">
            <span>
              {count(storage.usedBytes)} of {count(storage.quotaBytes)} bytes
            </span>
            <strong>{storageSize(storage.availableBytes)} available</strong>
          </div>
          {storage.reservedBytes > 0 && (
            <p className="muted storage-reserved">
              {storageSize(storage.reservedBytes)} reserved for uploads in progress
            </p>
          )}
          {error && (
            <p className="muted storage-reserved" role="status">
              Showing the last available usage.{' '}
              <Button variant="link" onClick={retry}>
                Refresh usage
              </Button>
            </p>
          )}
        </>
      )}
    </Card>
  );
}
