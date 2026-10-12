'use client';
import { useState } from 'react';
import { Lock } from 'lucide-react';
import type { ApiClient } from '@harbor/api-client';
import { useMigrationProgress } from '../lib/e2ee-migration';
import { AuthStory } from './auth-page';
import { E2eeSetup } from './e2ee-settings';
import { ThemeToggle } from './theme-toggle';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Progress } from './ui/progress';
import { Radio } from './ui/checkbox';

/** My Drive's progress card while existing files are re-encrypted. */
export function E2eeMigrationBanner({ onDetails }: { onDetails: () => void }) {
  const m = useMigrationProgress();
  if (!m || m.complete || !m.totalFiles) return null;
  const percent = Math.floor((m.doneFiles / m.totalFiles) * 100);
  const decrypting = m.direction === 'decrypt';
  return (
    <section className="e2ee-migration" aria-label="Encryption progress">
      <div className="e2ee-migration-head">
        <strong>
          <Lock aria-hidden="true" />
          {decrypting
            ? 'Decrypting your files to turn off encryption'
            : 'Encrypting your existing files'}
        </strong>
        <span className="muted">
          {m.doneFiles.toLocaleString()} of {m.totalFiles.toLocaleString()} files · {percent}%
        </span>
      </div>
      <Progress value={percent} max={100} />
      <div className="e2ee-migration-foot">
        <span className="muted">
          {m.running
            ? m.current
              ? `${decrypting ? 'Decrypting' : 'Encrypting'} ${m.current} · keep this tab open to finish sooner`
              : 'Checking your files…'
            : m.error
              ? `Paused: ${m.error} It tries again shortly.`
              : 'Paused'}
        </span>
        <Button variant="link" onClick={onDetails}>
          Details
        </Button>
      </div>
    </section>
  );
}

const offeredKey = (userId: string) => `harbor0-protection-offered:${userId}`;
/** Whether a new account should still be asked how to protect its files. */
export function shouldOfferProtection(user: { id: string; createdAt: string; e2ee?: unknown }) {
  if (user.e2ee || Date.now() - Date.parse(user.createdAt) > 86400_000) return false;
  try {
    return !localStorage.getItem(offeredKey(user.id));
  } catch {
    return false;
  }
}

/** The last step of signing up when encryption is offered: standard or end-to-end encrypted. */
export function ProtectionChoice({
  api,
  userId,
  onDone,
}: {
  api: ApiClient;
  userId: string;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'standard' | 'e2ee'>('standard');
  const [setup, setSetup] = useState(false);
  const finish = () => {
    try {
      localStorage.setItem(offeredKey(userId), new Date().toISOString());
    } catch {
      // Asked again next time.
    }
    onDone();
  };
  return (
    <main className="auth-page">
      <div className="auth-theme">
        <ThemeToggle />
      </div>
      <AuthStory />
      <section className="auth-form">
        <div>
          <p className="muted e2ee-step-label">Last step</p>
          <h2>Protect your files</h2>
          <p className="muted">
            Choose how harbor0 keeps your files private. You can turn on end-to-end encryption later
            in Settings.
          </p>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (mode === 'e2ee') setSetup(true);
              else finish();
            }}
          >
            <fieldset className="e2ee-options">
              <legend className="sr-only">Protection</legend>
              <label className="e2ee-option" data-selected={mode === 'standard' || undefined}>
                <Radio
                  name="protection"
                  aria-label="Standard"
                  checked={mode === 'standard'}
                  onChange={() => setMode('standard')}
                />
                <span>
                  <strong>Standard</strong>
                  <span className="muted">
                    Files are encrypted on our servers, and we can help if you lose access.
                  </span>
                  <ul>
                    <li>Reset your password by email</li>
                    <li>Sharing, previews on every app, WebDAV and rclone</li>
                  </ul>
                </span>
              </label>
              <label className="e2ee-option" data-selected={mode === 'e2ee' || undefined}>
                <Radio
                  name="protection"
                  aria-label="End-to-end encrypted"
                  checked={mode === 'e2ee'}
                  onChange={() => setMode('e2ee')}
                />
                <span>
                  <strong>
                    End-to-end encrypted <Badge tone="accent">Most private</Badge>
                  </strong>
                  <span className="muted">
                    Only your devices can read your files. Not even harbor0 can.
                  </span>
                  <ul>
                    <li>You set a passphrase and save a recovery key</li>
                    <li>Lose both and your files can’t be recovered</li>
                    <li>Works on the web for now; desktop and mobile apps follow</li>
                    <li>Can be turned off later; your files are decrypted first</li>
                  </ul>
                </span>
              </label>
            </fieldset>
            <Button type="submit" size="lg" block>
              Continue
            </Button>
          </form>
          <Alert>Not sure? Choose Standard.</Alert>
        </div>
      </section>
      {setup && (
        <E2eeSetup
          api={api}
          usedBytes={0}
          fileCount={0}
          startAt={2}
          onClose={() => setSetup(false)}
          onDone={finish}
        />
      )}
    </main>
  );
}
