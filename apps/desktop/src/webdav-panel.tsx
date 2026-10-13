import { useEffect, useState } from 'react';
import { Check, Copy, Eye, EyeOff, FolderOpen, Power, Unplug } from 'lucide-react';
import { Alert } from '../../web/components/ui/alert';
import { Badge } from '../../web/components/ui/badge';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';

type WebdavState = Awaited<ReturnType<Window['harbor']['webdav']>>;

/** Settings → Local WebDAV server: My Drive as a network drive, served from this computer. */
export function WebdavPanel() {
  const bridge = window.harbor;
  const [state, setState] = useState<WebdavState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shown, setShown] = useState(false);
  useEffect(() => {
    void bridge.webdav().then(setState, () => {});
    return bridge.onWebdav(setState);
  }, [bridge]);
  if (!state) return null;

  async function run(task: () => Promise<WebdavState>) {
    setBusy(true);
    setError('');
    try {
      setState(await task());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const starting = state.enabled && !state.running && !state.error;
  const finder = document.documentElement.classList.contains('platform-darwin');
  const app = finder ? 'Finder' : 'File Explorer';
  return (
    <Card
      className="panel webdav-panel"
      title="Local WebDAV server"
      description={
        'Open My Drive in Finder, Explorer or any WebDAV app without syncing it. Files download when you open them. The server only accepts connections from this computer.' +
        (state.encrypted
          ? ' Your files are decrypted here, on this computer, as apps read them.'
          : '')
      }
      action={
        state.running ? (
          <Badge tone="success">Running</Badge>
        ) : state.enabled && state.error ? (
          <Badge tone="danger">Stopped</Badge>
        ) : undefined
      }
    >
      {(error || state.error) && <Alert tone="error">{error || state.error}</Alert>}
      {state.running && (
        <>
          <dl className="details">
            <dt>Address</dt>
            <dd>
              <CopyValue value={state.url} />
            </dd>
            <dt>Username</dt>
            <dd>
              <CopyValue value={state.username} />
            </dd>
            <dt>Password</dt>
            <dd>
              <CopyValue value={state.password ?? ''} hidden={!shown} />
              <Button
                variant="ghost"
                size="sm"
                aria-label={shown ? 'Hide password' : 'Show password'}
                onClick={() => setShown(!shown)}
              >
                {shown ? <EyeOff /> : <Eye />}
              </Button>
            </dd>
            {state.command && (
              <>
                <dt>From a terminal</dt>
                <dd>
                  <CopyValue value={state.command} />
                </dd>
              </>
            )}
          </dl>
          <p className="card-description">
            {state.mount !== undefined
              ? `Open in ${app} connects My Drive as a drive named harbor0. Other WebDAV apps, such as Cyberduck or rclone, use the address, username and password.`
              : 'Enter the address, username and password in your WebDAV app, such as Cyberduck or rclone.'}
            {state.mount !== undefined &&
              !finder &&
              ' File Explorer can’t open files larger than 50 MB over WebDAV; use a WebDAV app or sync the folder for those.'}
          </p>
        </>
      )}
      <div className="settings-actions">
        {state.running && state.mount !== undefined && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void run(() => bridge.openWebdavDrive())}
          >
            <FolderOpen />
            {busy ? 'Connecting…' : `Open in ${app}`}
          </Button>
        )}
        {state.running && state.mount && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => bridge.disconnectWebdavDrive())}
          >
            <Unplug />
            Disconnect
          </Button>
        )}
        <Button
          variant={state.enabled ? 'outline' : 'primary'}
          disabled={busy || starting}
          onClick={() => void run(() => bridge.setWebdav({ enabled: !state.enabled }))}
        >
          <Power />
          {busy || starting
            ? state.enabled
              ? 'Starting…'
              : 'Stopping…'
            : state.enabled
              ? 'Turn off'
              : 'Turn on'}
        </Button>
      </div>
    </Card>
  );
}

function CopyValue({ value, hidden = false }: { value: string; hidden?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <span className="webdav-value">
      <code>{hidden ? '•'.repeat(12) : value}</code>
      <button
        type="button"
        className="webdav-copy"
        aria-label="Copy"
        onClick={() => void window.harbor.copyText({ text: value }).then(() => setCopied(true))}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </span>
  );
}
