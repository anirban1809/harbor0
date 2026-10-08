import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Alert } from '../../web/components/ui/alert';
import { Badge } from '../../web/components/ui/badge';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { Progress } from '../../web/components/ui/progress';
import { storageSize } from './overview';
import type { UpdateStatus } from './updater';

/** The app updater's live status. */
export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus>();
  useEffect(() => {
    void window.harbor.updateStatus().then(setStatus, () => {});
    return window.harbor.onUpdate(setStatus);
  }, []);
  return status;
}

/** The app's version, with a check for updates and a one-click update and restart. */
export function UpdatePanel({ status }: { status: UpdateStatus | undefined }) {
  const bridge = window.harbor;
  const [error, setError] = useState('');
  if (!status) return null;
  const { state, latest } = status;
  const working = state === 'checking' || state === 'downloading' || state === 'installing';
  const run = (action: () => Promise<unknown>) => {
    setError('');
    void action().catch((e) => setError((e as Error).message));
  };
  const summary =
    state === 'unsupported'
      ? status.reason
      : state === 'checking'
        ? 'Checking for updates…'
        : state === 'current'
          ? 'harbor0 is up to date.'
          : state === 'available' && latest
            ? `Version ${latest.version} is available (${storageSize(latest.bytes)}). harbor0 restarts to finish updating; sync picks up where it left off.`
            : state === 'downloading' && latest
              ? `Downloading version ${latest.version}… ${storageSize(status.received ?? 0)} of ${storageSize(latest.bytes)}`
              : state === 'installing'
                ? 'Installing. harbor0 will restart in a moment.'
                : null;
  return (
    <Card
      className="panel update-panel"
      title="App updates"
      description={`You're using harbor0 ${status.current}.`}
      action={
        state === 'available' ? (
          <Badge tone="accent">Update available</Badge>
        ) : state === 'current' ? (
          <Badge tone="success">Up to date</Badge>
        ) : undefined
      }
    >
      {summary && <p className="card-description">{summary}</p>}
      {state === 'downloading' && latest && (
        <Progress
          value={status.received ?? 0}
          max={latest.bytes}
          aria-label="Update download progress"
        />
      )}
      {(error || status.error) && <Alert tone="error">{error || status.error}</Alert>}
      {state !== 'unsupported' && (
        <div className="settings-actions">
          {latest &&
          (state === 'available' ||
            state === 'downloading' ||
            state === 'installing' ||
            state === 'failed') ? (
            <Button disabled={working} onClick={() => run(() => bridge.installUpdate())}>
              <Download />
              {state === 'downloading'
                ? 'Downloading…'
                : state === 'installing'
                  ? 'Installing…'
                  : state === 'failed'
                    ? 'Try the update again'
                    : 'Update and restart'}
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={working}
              onClick={() => run(() => bridge.checkForUpdate())}
            >
              <RefreshCw />
              Check for updates
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
