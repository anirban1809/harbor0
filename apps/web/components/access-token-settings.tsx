'use client';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Loader2, Terminal } from 'lucide-react';
import type { ApiClient } from '@harbor/api-client';
import type { AccessToken, AccessTokenScope } from '@harbor/contracts';
import { useFeatureFlag } from '../lib/feature-flags';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Dialog, DialogActions } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { Segmented } from './ui/segmented';
import { Select } from './ui/select';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const expiries = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];
const setupCommand = (token: string) => `rclone config create harbor0 harbor0 token=${token}`;

/**
 * Settings card for personal access tokens, which let rclone and similar tools use My Drive
 * without signing in. Each token is also a device, so it can be revoked here or on Devices.
 */
export function AccessTokenSettings({ api }: { api: ApiClient }) {
  const enabled = useFeatureFlag('rclone');
  const queries = useQueryClient();
  const tokens = useQuery<AccessToken[]>({
    queryKey: ['access-tokens'],
    queryFn: async () => (await api.request('/v1/tokens')).items,
    enabled,
  });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string>();
  const [revoking, setRevoking] = useState<AccessToken>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!enabled) return null;

  async function revoke(token: AccessToken) {
    setBusy(true);
    setError('');
    try {
      await api.request(`/v1/tokens/${token.id}`, { method: 'DELETE' });
      queries.setQueryData<AccessToken[]>(['access-tokens'], (items) =>
        items?.filter((item) => item.id !== token.id),
      );
      void queries.invalidateQueries({ queryKey: ['devices'] });
      setRevoking(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      className="panel"
      title="Use with rclone"
      description="rclone copies, syncs and mounts files from the command line, on Linux, NAS boxes and servers. Give it an access token so it can use My Drive without your password."
      action={
        <Button size="sm" onClick={() => setCreating(true)}>
          <KeyRound aria-hidden="true" />
          Create token
        </Button>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      {tokens.isPending ? (
        <Loader2 className="spin" aria-label="Loading" />
      ) : tokens.isError ? (
        <Alert tone="error">{(tokens.error as Error).message}</Alert>
      ) : tokens.data.length ? (
        <ul className="two-factor-methods token-list">
          {tokens.data.map((token) => (
            <li key={token.id}>
              <span className="two-factor-icon">
                <Terminal aria-hidden="true" />
              </span>
              <div>
                <strong>
                  {token.name}
                  {token.scope === 'READ' && <Badge>Read-only</Badge>}
                </strong>
                <p className="muted">
                  {token.lastUsedAt ? `Last used ${day(token.lastUsedAt)}` : 'Not used yet'} ·{' '}
                  {token.expiresAt ? `Expires ${day(token.expiresAt)}` : 'Never expires'}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setRevoking(token)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          No access tokens yet. Create one, then follow the{' '}
          <a href="https://rclone.org/install/" target="_blank" rel="noreferrer">
            rclone install guide
          </a>
          .
        </p>
      )}
      {creating && (
        <CreateTokenDialog
          api={api}
          onClose={() => setCreating(false)}
          onCreated={(token, item) => {
            queries.setQueryData<AccessToken[]>(['access-tokens'], (items) => [
              item,
              ...(items ?? []),
            ]);
            void queries.invalidateQueries({ queryKey: ['devices'] });
            setCreating(false);
            setCreated(token);
          }}
        />
      )}
      {created && <TokenCreatedDialog token={created} onClose={() => setCreated(undefined)} />}
      <Dialog
        open={!!revoking}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoking(undefined);
        }}
        title={`Revoke “${revoking?.name}”?`}
        description="Anything using this token stops working at once. This can’t be undone."
      >
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => setRevoking(undefined)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => revoking && void revoke(revoking)}
          >
            {busy ? 'Revoking…' : 'Revoke'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

function CreateTokenDialog({
  api,
  onClose,
  onCreated,
}: {
  api: ApiClient;
  onClose: () => void;
  onCreated: (token: string, item: AccessToken) => void;
}) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<AccessTokenScope>('FULL');
  const [expiry, setExpiry] = useState('365');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.request('/v1/tokens', {
        method: 'POST',
        body: {
          name: name.trim(),
          scope,
          expiresInDays: expiry === 'never' ? null : Number(expiry),
        },
      });
      onCreated(result.token, result.item);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Create an access token"
      description="The token can use your files in My Drive, but not your account settings, sharing or devices."
    >
      <form className="form" onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Name">
          <Input
            required
            autoFocus
            maxLength={60}
            placeholder="e.g. Home NAS"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Access">
          <Segmented
            label="Access"
            value={scope}
            onValueChange={setScope}
            options={[
              { value: 'FULL', label: 'Read and write' },
              { value: 'READ', label: 'Read-only' },
            ]}
          />
        </Field>
        <Field label="Expires">
          <Select block value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {expiries.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <DialogActions>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy && <Loader2 className="spin" aria-hidden="true" />}
            {busy ? 'Creating…' : 'Create token'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function TokenCreatedDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const [copied, setCopied] = useState<'token' | 'command'>();
  const copy = async (what: 'token' | 'command') => {
    await navigator.clipboard.writeText(what === 'token' ? token : setupCommand(token));
    setCopied(what);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Copy your token now"
      description="This is the only time harbor0 shows it. If you lose it, revoke it and create another."
    >
      <div className="form">
        <Field label="Token">
          <div className="token-secret">
            <code>{token}</code>
            <Button variant="outline" size="sm" onClick={() => void copy('token')}>
              {copied === 'token' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied === 'token' ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </Field>
        <Field label="Set up rclone with it">
          <div className="token-secret">
            <code>{setupCommand(token)}</code>
            <Button variant="outline" size="sm" onClick={() => void copy('command')}>
              {copied === 'command' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied === 'command' ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </Field>
        <p className="muted">
          Then try <code>rclone lsd harbor0:</code> to list the folders in My Drive.
        </p>
        <DialogActions>
          <Button onClick={onClose}>Done</Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
