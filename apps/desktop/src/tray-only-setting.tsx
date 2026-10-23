import { useEffect, useState } from 'react';
import { Alert } from '../../web/components/ui/alert';
import { Checkbox } from '../../web/components/ui/checkbox';

type TrayOnlyState = Awaited<ReturnType<Window['harbor']['trayOnly']>>;

/** Settings → Desktop settings: keep harbor0 out of the Dock or taskbar. Off by default. */
export function TrayOnlySetting() {
  const bridge = window.harbor;
  const [state, setState] = useState<TrayOnlyState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void bridge.trayOnly().then(setState, () => {});
  }, [bridge]);
  if (!state?.supported) return null;
  const mac = document.documentElement.classList.contains('platform-darwin');
  async function save(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      setState(await bridge.setTrayOnly({ enabled }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      <label className="choice">
        <Checkbox
          checked={state.enabled}
          disabled={busy}
          onChange={(event) => void save(event.target.checked)}
        />
        <span>
          <strong>{mac ? 'Show in menu bar only' : 'Show in system tray only'}</strong>
          <span className="muted">
            {mac
              ? 'Hide harbor0 from the Dock. Open it from its icon in the menu bar.'
              : 'Hide harbor0 from the taskbar. Open it from its icon in the system tray.'}
          </span>
        </span>
      </label>
    </>
  );
}
