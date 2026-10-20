import { useEffect, useState } from 'react';
import { Download, RefreshCw, RotateCw } from 'lucide-react';
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

/**
 * In the sidebar once an update has downloaded in the background: one click restarts into it.
 * Nothing shows while it downloads; the update is only offered once it's ready.
 */
export function UpdateReady({ status }: { status: UpdateStatus | undefined }) {
  const [error, setError] = useState('');
  if (!status?.latest || (status.state !== 'ready' && status.state !== 'installing')) return null;
  const restarting = status.state === 'installing';
  const label = restarting
    ? 'Restarting to update…'
    : `Restart to update to ${status.latest.version}`;
  return (
    <button
      className="update-ready"
      disabled={restarting}
      title={error || label}
      onClick={() => {
        setError('');
        void window.harbor.restartToUpdate().catch((e) => setError((e as Error).message));
      }}
    >
      <RotateCw aria-hidden="true" className={restarting ? 'spin' : undefined} />
      <span>{error ? 'Couldn’t restart. Try again' : label}</span>
    </button>
  );
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
              ? `Downloading version ${latest.version} in the background… ${storageSize(status.received ?? 0)} of ${storageSize(latest.bytes)}`
              : state === 'ready' && latest
                ? `Version ${latest.version} is downloaded. Restart harbor0 to finish updating; sync picks up where it left off.`
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
        ) : state === 'ready' ? (
          <Badge tone="accent">Ready to install</Badge>
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
          {state === 'ready' ? (
            <Button onClick={() => run(() => bridge.restartToUpdate())}>
              <RotateCw />
              Restart to update
            </Button>
          ) : latest &&
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
