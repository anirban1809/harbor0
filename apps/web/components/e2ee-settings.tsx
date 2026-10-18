'use client';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Download,
  FolderOpen,
  Globe,
  KeyRound,
  Laptop,
  Loader2,
  Lock,
  MonitorSmartphone,
  Printer,
  Smartphone,
  Unlock,
} from 'lucide-react';
import type { ApiClient } from '@harbor/api-client';
import type { E2eeDevice, E2eeState } from '@harbor/contracts';
import { formatRecoveryKey, newRecoveryKey } from '../../../packages/api-client/src/e2ee';
import { useFeatureFlag } from '../lib/feature-flags';
import {
  changePassphrase,
  enroll,
  lock,
  rememberBrowser,
  replaceRecovery,
  startTurningOff,
  useVault,
} from '../lib/e2ee-vault';
import { useMigrationProgress } from '../lib/e2ee-migration';
import { passphraseStrength, suggestPassphrase } from '../lib/e2ee-passphrase';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogActions } from './ui/dialog';
import { Field } from './ui/field';
import { Input, PasswordInput } from './ui/input';
import { Progress } from './ui/progress';

export const e2eeQuery = (api: ApiClient) => ({
  queryKey: ['e2ee'],
  queryFn: async () => (await api.request('/v1/e2ee')).e2ee as E2eeState,
});
const day = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const count = (n: number) => n.toLocaleString();
const gb = (n: number) => `${(n / 1e9).toFixed(n < 1e10 ? 1 : 0)} GB`;

/** Settings → End-to-end encryption: turn it on, then manage the passphrase, key and devices. */
export function E2eeSettings({
  api,
  encrypted,
  fileCount,
  usedBytes,
}: {
  api: ApiClient;
  encrypted: boolean;
  /** Files and bytes the account stores, for what turning it on involves. */
  fileCount?: number;
  usedBytes: number;
}) {
  const allowed = useFeatureFlag('e2ee');
  const [wizard, setWizard] = useState(false);
  if (!encrypted && !allowed) return null;
  if (encrypted) return <E2eeOn api={api} />;
  return (
    <Card
      className="panel"
      title={
        <>
          End-to-end encryption <Badge>Off</Badge>
        </>
      }
      description="Your devices encrypt files and file names before they’re uploaded. Only your devices hold the key, so harbor0 can’t read your files."
      action={<Button onClick={() => setWizard(true)}>Turn on…</Button>}
    >
      <ul className="two-factor-methods">
        <Row icon={MonitorSmartphone} title="Works on the web first">
          The web app encrypts today. Desktop and mobile apps pause syncing on encrypted accounts
          until they’re updated to encrypt too.
        </Row>
        <Row icon={FolderOpen} title="Existing files are included">
          {fileCount !== undefined
            ? `Your ${count(fileCount)} files are re-encrypted in the background by this browser.`
            : 'Your files are re-encrypted in the background by this browser.'}
        </Row>
        <Row icon={Lock} title="Your keys, your responsibility">
          Lose your passphrase and recovery key and nobody can recover your files. You can turn it
          off later; your files are decrypted first.
        </Row>
      </ul>
      {wizard && (
        <E2eeSetup
          api={api}
          fileCount={fileCount}
          usedBytes={usedBytes}
          onClose={() => setWizard(false)}
        />
      )}
    </Card>
  );
}

function Row({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: typeof Lock;
  title: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li>
      <span className="two-factor-icon">
        <Icon aria-hidden="true" />
      </span>
      <div>
        <strong>{title}</strong>
        {children && <div className="muted e2ee-row-text">{children}</div>}
      </div>
      {action}
    </li>
  );
}

function E2eeOn({ api }: { api: ApiClient }) {
  const state = useQuery(e2eeQuery(api));
  const queries = useQueryClient();
  const vault = useVault();
  const live = useMigrationProgress();
  const [dialog, setDialog] = useState<'passphrase' | 'recovery' | 'off'>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string>();
  if (state.isPending) return <Card className="panel" title="End-to-end encryption" />;
  if (state.isError || !state.data)
    return (
      <Card className="panel" title="End-to-end encryption">
        <Alert tone="error">{(state.error as Error)?.message}</Alert>
      </Card>
    );
  const s = state.data;
  const decrypting = !!s.decryptingSince;
  const m =
    (live?.direction === (decrypting ? 'decrypt' : 'encrypt') ? live : null) ??
    (decrypting ? s.decryption : s.migration);
  const percent = m && m.totalFiles ? Math.floor((m.doneFiles / m.totalFiles) * 100) : 100;
  async function remember(device: E2eeDevice) {
    setBusy(device.id);
    setError('');
    try {
      await rememberBrowser(api.request);
      await queries.invalidateQueries({ queryKey: ['e2ee'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }
  async function remove(device: E2eeDevice) {
    setBusy(device.id);
    setError('');
    try {
      if (device.id === vault.deviceRecordId) await lock(api.request);
      else {
        const next = await api.request(`/v1/e2ee/devices/${device.id}`, { method: 'DELETE' });
        queries.setQueryData(['e2ee'], next.e2ee);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <>
      <Card
        className="panel"
        title={
          <>
            End-to-end encryption{' '}
            {decrypting ? (
              <Badge tone="warning">
                <Unlock aria-hidden="true" />
                Turning off
              </Badge>
            ) : (
              <Badge tone="success">
                <Lock aria-hidden="true" />
                On
              </Badge>
            )}
          </>
        }
        description={
          decrypting
            ? `Turning off since ${day(s.decryptingSince!)}. This browser is decrypting your files; keep it open. New uploads are stored unencrypted.`
            : `On since ${day(s.enabledAt!)}. Only your devices can read your files and file names.`
        }
      >
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        <ul className="two-factor-methods">
          <Row icon={FolderOpen} title={decrypting ? 'Decrypting your files' : 'Existing files'}>
            {!m ? (
              'Checking your files…'
            ) : m.complete ? (
              decrypting ? (
                'All your files are decrypted.'
              ) : (
                'All your files are encrypted.'
              )
            ) : (
              <>
                {count(m.doneFiles)} of {count(m.totalFiles)}{' '}
                {decrypting ? 'decrypted' : 'encrypted'}
                {live?.running
                  ? ' · running in this browser'
                  : (decrypting ? s.decryption : s.migration)?.deviceName
                    ? ` · last ran on ${(decrypting ? s.decryption : s.migration)!.deviceName}`
                    : ''}
                {!!m.skippedFiles &&
                  ` · ${count(m.skippedFiles)} in backups or only on synced devices wait for those apps`}
                <Progress className="e2ee-progress" value={percent} max={100} aria-hidden="true" />
                {/* Why the last pass stopped short, such as files the server says are left. */}
                {live === m && !live.running && live.error && (
                  <Alert tone="error">{live.error} Trying again shortly.</Alert>
                )}
              </>
            )}
          </Row>
          <Row
            icon={Lock}
            title="Encryption passphrase"
            action={
              <Button variant="outline" size="sm" onClick={() => setDialog('passphrase')}>
                Change
              </Button>
            }
          >
            {s.passphraseChangedAt ? `Changed ${day(s.passphraseChangedAt)}. ` : ''}
            Changing it doesn’t re-encrypt your files.
          </Row>
          <Row
            icon={KeyRound}
            title="Recovery key"
            action={
              <Button variant="outline" size="sm" onClick={() => setDialog('recovery')}>
                Create new key
              </Button>
            }
          >
            Created {day(s.recoveryCreatedAt!)}. A new key replaces the old one.
          </Row>
          {!decrypting && (
            <Row
              icon={Unlock}
              title="Turn off end-to-end encryption"
              action={
                <Button variant="danger" size="sm" onClick={() => setDialog('off')}>
                  Turn off…
                </Button>
              }
            >
              This browser decrypts every file, then your keys are deleted.
            </Row>
          )}
        </ul>
      </Card>
      <Card
        className="panel"
        title="Unlocked devices"
        description="These keep a copy of your key. Removed devices need your passphrase again."
      >
        <ul className="two-factor-methods">
          {s.devices.length === 0 && (
            <li>
              <p className="muted">No devices keep a copy of your key.</p>
            </li>
          )}
          {s.devices.map((d) => {
            const here = d.id === vault.deviceRecordId;
            const Icon =
              d.platform === 'WEB'
                ? Globe
                : d.platform === 'IOS' || d.platform === 'ANDROID'
                  ? Smartphone
                  : Laptop;
            return (
              <Row
                key={d.id}
                icon={Icon}
                title={
                  <>
                    {d.name}
                    {here && <Badge tone="accent">This browser</Badge>}
                  </>
                }
                action={
                  <>
                    {here && !d.remember && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === d.id}
                        onClick={() => void remember(d)}
                      >
                        Remember
                      </Button>
                    )}
                    <Button
                      variant={here ? 'outline' : 'danger'}
                      size="sm"
                      disabled={busy === d.id}
                      onClick={() => void remove(d)}
                    >
                      {busy === d.id && <Loader2 className="spin" aria-hidden="true" />}
                      {here ? 'Lock now' : 'Remove'}
                    </Button>
                  </>
                }
              >
                {d.remember
                  ? `Remembered · last used ${day(d.lastUsedAt)}`
                  : 'This session only · locks when the tab closes'}
              </Row>
            );
          })}
        </ul>
      </Card>
      {dialog === 'passphrase' && (
        <ChangePassphrase
          api={api}
          onClose={() => setDialog(undefined)}
          onDone={(next) => {
            queries.setQueryData(['e2ee'], next);
            setDialog(undefined);
            setNotice('Your passphrase is changed. Use the new one on new devices.');
          }}
        />
      )}
      {dialog === 'off' && (
        <TurnOff
          api={api}
          state={s}
          onClose={() => setDialog(undefined)}
          onDone={(next) => {
            queries.setQueryData(['e2ee'], next);
            void queries.invalidateQueries({ queryKey: ['me'] });
            setDialog(undefined);
            setNotice('Decrypting your files. Keep this page open until it finishes.');
          }}
        />
      )}
      {dialog === 'recovery' && (
        <NewRecoveryKey
          api={api}
          onClose={() => setDialog(undefined)}
          onDone={(next) => {
            queries.setQueryData(['e2ee'], next);
            setDialog(undefined);
            setNotice('Your new recovery key is saved. The old one no longer works.');
          }}
        />
      )}
    </>
  );
}

/** Passphrase and confirmation, with a strength hint and a suggestion. */
function PassphraseFields({
  value,
  confirm,
  onChange,
  onConfirm,
  label = 'Passphrase',
}: {
  value: string;
  confirm: string;
  onChange: (v: string) => void;
  onConfirm: (v: string) => void;
  label?: string;
}) {
  const strength = passphraseStrength(value);
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="e2ee-passphrase">
          {label}
        </label>
        <PasswordInput
          id="e2ee-passphrase"
          autoComplete="new-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
          required
        />
        <div className="e2ee-meter" data-level={strength.level} aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="e2ee-meter-row">
          <span className="field-hint">{value ? strength.label : 'At least 12 characters'}</span>
          <Button
            variant="link"
            type="button"
            onClick={() => {
              const words = suggestPassphrase();
              onChange(words);
              onConfirm(words);
            }}
          >
            Suggest a passphrase
          </Button>
        </div>
      </div>
      <Field label={`Confirm ${label.toLowerCase()}`}>
        <PasswordInput
          aria-label={`Confirm ${label.toLowerCase()}`}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => onConfirm(e.target.value)}
          required
        />
      </Field>
    </>
  );
}
const passphraseProblem = (value: string, confirm: string) =>
  !passphraseStrength(value).ok
    ? 'Use at least 12 characters.'
    : value !== confirm
      ? 'The passphrases don’t match.'
      : '';

function Steps({ step }: { step: number }) {
  return (
    <div className="e2ee-steps">
      <div className="e2ee-steps-bar" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} data-on={n <= step || undefined} />
        ))}
      </div>
      <span className="muted">Step {step} of 4</span>
    </div>
  );
}

/** The recovery key in groups, with ways to keep it. */
function RecoveryKeyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const file = () => {
    const blob = new Blob(
      [
        `harbor0 recovery key\n\n${value}\n\nKeep this somewhere safe and away from this computer. With your sign-in, it unlocks your encrypted files if you forget your passphrase.\n`,
      ],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'harbor0-recovery-key.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const print = () => {
    const w = window.open('', '_blank', 'noopener=no,width=600,height=400');
    if (!w) return;
    w.document.title = 'harbor0 recovery key';
    const pre = w.document.createElement('pre');
    pre.style.font = '20px ui-monospace, monospace';
    pre.textContent = `harbor0 recovery key\n\n${value.split('-').slice(0, 4).join('-')}\n${value.split('-').slice(4).join('-')}`;
    w.document.body.append(pre);
    w.print();
    w.close();
  };
  return (
    <div className="e2ee-keybox">
      <div className="e2ee-key" aria-label="Recovery key">
        {value.split('-').map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      <div className="e2ee-key-actions">
        <Button variant="outline" size="sm" type="button" onClick={file}>
          <Download aria-hidden="true" />
          Download
        </Button>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          <Copy aria-hidden="true" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="outline" size="sm" type="button" onClick={print}>
          <Printer aria-hidden="true" />
          Print
        </Button>
      </div>
    </div>
  );
}

/** Asks for one group of the key back, so a key that wasn't saved is caught now. */
function RecoveryCheck({
  value,
  group,
  typed,
  onType,
}: {
  value: string;
  group: number;
  typed: string;
  onType: (v: string) => void;
}) {
  const groups = value.split('-');
  const ok = typed.trim().toUpperCase() === groups[group];
  return (
    <div className="field">
      <label className="field-label" htmlFor="e2ee-group">
        Group {group + 1}
      </label>
      <div className="e2ee-groups">
        {groups.map((g, i) =>
          i === group ? (
            <Input
              key={i}
              id="e2ee-group"
              className="e2ee-group-input"
              value={typed}
              maxLength={4}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onType(e.target.value)}
              autoFocus
            />
          ) : (
            <span key={i} aria-hidden="true">
              ••••
            </span>
          ),
        )}
      </div>
      {typed.length === 4 && (
        <span className={ok ? 'e2ee-ok' : 'field-hint e2ee-bad'}>
          {ok ? 'Matches' : 'That doesn’t match. Check the key you saved.'}
        </span>
      )}
    </div>
  );
}

/**
 * Turning encryption on: what changes, a passphrase, the recovery key, then a check that the
 * key was saved. New accounts start at the passphrase, having chosen it at sign-up.
 */
export function E2eeSetup({
  api,
  fileCount,
  usedBytes,
  startAt = 1,
  onClose,
  onDone,
}: {
  api: ApiClient;
  fileCount?: number;
  usedBytes: number;
  startAt?: 1 | 2;
  onClose: () => void;
  onDone?: () => void;
}) {
  const queries = useQueryClient();
  const [step, setStep] = useState<number>(startAt);
  const [understood, setUnderstood] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const recovery = useMemo(() => newRecoveryKey(), []);
  const recoveryText = useMemo(() => formatRecoveryKey(recovery), [recovery]);
  const [saved, setSaved] = useState(false);
  const group = useMemo(() => 2 + Math.floor(Math.random() * 6), []);
  const [typed, setTyped] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toUpperCase() === recoveryText.split('-')[group];

  async function finish(e: FormEvent) {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError('');
    try {
      await enroll(api.request, passphrase, recovery, remember);
      await queries.invalidateQueries({ queryKey: ['me'] });
      await queries.invalidateQueries({ queryKey: ['e2ee'] });
      onDone?.();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  const titles: Record<number, [string, string]> = {
    1: ['Before you turn on end-to-end encryption', 'Read this first.'],
    2: [
      'Create an encryption passphrase',
      'You’ll enter this when you sign in on a new device or browser. Make it different from your sign-in password.',
    ],
    3: [
      'Save your recovery key',
      'If you forget your passphrase, this key is the only way back into your files. It’s shown once.',
    ],
    4: [
      'Check your recovery key',
      `To make sure you saved it, enter group ${group + 1} of your recovery key.`,
    ],
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={titles[step][0]}
      description={titles[step][1]}
      className="e2ee-dialog"
    >
      <Steps step={step} />
      {step === 1 && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (understood) setStep(2);
          }}
        >
          <Alert tone="warning">
            <strong>Keep your keys safe.</strong> If you lose both your passphrase and your recovery
            key, nobody can get your files back, including harbor0.
          </Alert>
          <div>
            <div className="e2ee-section-label">What changes</div>
            <ul className="e2ee-list">
              <li>Search, previews and downloads run in your browser.</li>
              <li>
                Downloading folders as a ZIP, sending files, sharing folders, shared sync, rclone
                and cloud WebDAV aren’t available for now.
              </li>
              <li>Folders you’ve shared with others are paused for them.</li>
              <li>
                Desktop and mobile apps pause syncing and backups until they’re updated to encrypt.
                Nothing is uploaded unencrypted meanwhile.
              </li>
            </ul>
          </div>
          <Alert>
            <strong>Your existing files:</strong> this browser re-encrypts{' '}
            {fileCount !== undefined
              ? `${count(fileCount)} files (${gb(usedBytes)})`
              : 'your files'}{' '}
            in the background, then the unencrypted copies are deleted. Earlier versions of these
            files are deleted too. Backups stay as they are until the desktop app can encrypt.
            Turning it off later decrypts everything the same way.
          </Alert>
          <Field label="I understand harbor0 can’t recover my files without my keys" inline>
            <Checkbox checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          </Field>
          <DialogActions>
            <Button variant="outline" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!understood}>
              Continue
            </Button>
          </DialogActions>
        </form>
      )}
      {step === 2 && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            const problem = passphraseProblem(passphrase, confirm);
            setError(problem);
            if (!problem) setStep(3);
          }}
        >
          <PassphraseFields
            value={passphrase}
            confirm={confirm}
            onChange={setPassphrase}
            onConfirm={setConfirm}
          />
          <Alert>
            Your passphrase never leaves this browser, so we can’t reset it by email. Save it in
            your password manager.
          </Alert>
          {error && <Alert tone="error">{error}</Alert>}
          <DialogActions>
            <Button
              variant="outline"
              type="button"
              onClick={() => (startAt === 2 ? onClose() : setStep(1))}
            >
              Back
            </Button>
            <Button type="submit">Continue</Button>
          </DialogActions>
        </form>
      )}
      {step === 3 && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (saved) setStep(4);
          }}
        >
          <RecoveryKeyBox value={recoveryText} />
          <ul className="e2ee-list">
            <li>
              Keep it somewhere other than this computer, such as your password manager or on paper.
            </li>
            <li>Anyone with this key and your sign-in can read your files.</li>
          </ul>
          <Field label="I’ve saved my recovery key" inline>
            <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          </Field>
          <DialogActions>
            <Button variant="outline" type="button" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button type="submit" disabled={!saved}>
              Continue
            </Button>
          </DialogActions>
        </form>
      )}
      {step === 4 && (
        <form className="form" onSubmit={finish}>
          <RecoveryCheck value={recoveryText} group={group} typed={typed} onType={setTyped} />
          <div className="e2ee-next">
            <div className="e2ee-section-label">What happens next</div>
            <ol className="e2ee-list">
              <li>New uploads from this browser are encrypted straight away.</li>
              <li>
                This browser re-encrypts your existing files in the background. Keep the tab open to
                finish sooner.
              </li>
              <li>Once a file is encrypted, its unencrypted copy is deleted from our servers.</li>
              <li>Other browsers ask for your passphrase once.</li>
            </ol>
          </div>
          <Field
            label="Remember this browser"
            hint="Stay unlocked until you sign out. Leave this off on shared computers."
            inline
          >
            <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          </Field>
          {error && <Alert tone="error">{error}</Alert>}
          <DialogActions>
            <Button variant="outline" type="button" disabled={busy} onClick={() => setStep(3)}>
              Back
            </Button>
            <Button type="submit" disabled={!matches || busy}>
              {busy && <Loader2 className="spin" aria-hidden="true" />}
              {busy ? 'Turning on…' : 'Turn on encryption'}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}

function ChangePassphrase({
  api,
  onClose,
  onDone,
}: {
  api: ApiClient;
  onClose: () => void;
  onDone: (state: E2eeState) => void;
}) {
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title="Change your encryption passphrase"
      description="Your files stay as they are. Devices that are already unlocked stay unlocked."
      className="e2ee-dialog"
    >
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const problem = passphraseProblem(value, confirm);
          setError(problem);
          if (problem) return;
          setBusy(true);
          try {
            onDone((await changePassphrase(api.request, value)).e2ee);
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <PassphraseFields
          label="New passphrase"
          value={value}
          confirm={confirm}
          onChange={setValue}
          onConfirm={setConfirm}
        />
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="outline" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="spin" aria-hidden="true" />}
            Change passphrase
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function NewRecoveryKey({
  api,
  onClose,
  onDone,
}: {
  api: ApiClient;
  onClose: () => void;
  onDone: (state: E2eeState) => void;
}) {
  const recovery = useMemo(() => newRecoveryKey(), []);
  const text = useMemo(() => formatRecoveryKey(recovery), [recovery]);
  const group = useMemo(() => Math.floor(Math.random() * 8), []);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toUpperCase() === text.split('-')[group];
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title="Create a new recovery key"
      description="Save this key, then enter one group of it. Your old recovery key stops working."
      className="e2ee-dialog"
    >
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!matches) return;
          setBusy(true);
          try {
            onDone((await replaceRecovery(api.request, recovery)).e2ee);
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <RecoveryKeyBox value={text} />
        <RecoveryCheck value={text} group={group} typed={typed} onType={setTyped} />
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="outline" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!matches || busy}>
            {busy && <Loader2 className="spin" aria-hidden="true" />}
            Replace recovery key
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Turning encryption off: what happens, and the passphrase to confirm it's the owner. */
function TurnOff({
  api,
  state,
  onClose,
  onDone,
}: {
  api: ApiClient;
  state: E2eeState;
  onClose: () => void;
  onDone: (state: E2eeState) => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title="Turn off end-to-end encryption?"
      description="Your files go back to standard protection: encrypted on our servers, readable by harbor0."
      className="e2ee-dialog"
    >
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!understood) return;
          setBusy(true);
          setError('');
          try {
            onDone((await startTurningOff(api.request, state, passphrase)).e2ee);
          } catch (err) {
            setError(
              (err as { code?: string }).code === 'WRONG_KEY'
                ? 'That passphrase isn’t right. Check it and try again.'
                : (err as Error).message,
            );
            setBusy(false);
          }
        }}
      >
        <div>
          <div className="e2ee-section-label">What happens</div>
          <ol className="e2ee-list">
            <li>
              This browser downloads, decrypts and uploads again every file, including those in
              Trash. Keep it open until it finishes.
            </li>
            <li>Earlier encrypted versions of your files are deleted.</li>
            <li>New uploads are stored unencrypted from now on.</li>
            <li>
              When everything is decrypted, your passphrase, recovery key and unlocked devices stop
              working and are deleted. Sharing, ZIP downloads and rclone come back.
            </li>
          </ol>
        </div>
        <Field label="Encryption passphrase">
          <PasswordInput
            aria-label="Encryption passphrase"
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
            required
          />
        </Field>
        <Field label="I understand harbor0 will be able to read my files again" inline>
          <Checkbox checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="outline" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" disabled={!understood || !passphrase || busy}>
            {busy && <Loader2 className="spin" aria-hidden="true" />}
            Turn off and decrypt
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
