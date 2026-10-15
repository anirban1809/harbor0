'use client';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, Globe, KeyRound, Link2, Loader2, Lock } from 'lucide-react';
import type { Transport } from '@harbor/api-client';
import { PUBLIC_LINK_DEFAULT_EXPIRY_DAYS, type PublicLink } from '@harbor/contracts';
import { fileDate } from '../lib/file-metadata';
import { fileIcon } from '../lib/file-icon';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog } from './ui/dialog';
import { Field } from './ui/field';
import { PasswordInput } from './ui/input';
import { Select } from './ui/select';
import { Skeleton } from './ui/skeleton';

type Allowance = {
  blockedReason: string | null;
  neverExpires: boolean;
  active: number;
  limit: number;
};
type Item = { id: string; name: string; type: 'FILE' | 'FOLDER'; mimeType?: string | null };
type Changes = { expiresInDays?: number | null; password?: string | null };
const expiries = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
];
const DAY_MS = 86400_000;

/** “Expires in 6 days · Oct 22, 2026”: how long a link has left. */
export function linkEnds(expiresAt: string | null) {
  if (!expiresAt) return 'Never expires';
  const days = Math.ceil((Date.parse(expiresAt) - Date.now()) / DAY_MS);
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return `Expires ${when} · ${fileDate(expiresAt).date}`;
}
/** The address without its scheme, for showing; copying always takes the full URL. */
export const shownLink = (url: string) => url.replace(/^https?:\/\//, '');

/** Copies text and says so for a couple of seconds; false when the browser refused. */
export function useCopy() {
  const [copied, setCopied] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false;
    }
    setCopied(id);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(undefined), 2000);
    return true;
  };
  return { copied, copy };
}

/**
 * Shares one item with a public link: anyone who has the link can view and download the file,
 * or the files in the folder, on harbor0content.online without an account. Opens on the link
 * when there is one, with its settings changeable in place.
 */
export function PublicLinkDialog({
  request,
  item,
  onClose,
  onChanged,
}: {
  request: Transport;
  item: Item;
  onClose: () => void;
  /** After a link is made or turned off, so lists can show which items are public. */
  onChanged?: () => void;
}) {
  const [allowance, setAllowance] = useState<Allowance>();
  const [links, setLinks] = useState<PublicLink[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { Icon, kind } = fileIcon(item);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([
      request('/v1/links/allowance', { signal }),
      request(`/v1/links?driveItemId=${encodeURIComponent(item.id)}`, { signal }),
    ])
      .then(([allowed, listed]) => {
        setAllowance(allowed);
        setLinks(listed.items);
      })
      .catch((e: Error) => {
        if (!signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [request, item.id]);

  /** Runs a change, showing its error in the dialog; undefined when it failed. */
  async function run<T>(work: () => Promise<T>) {
    setBusy(true);
    setError('');
    try {
      return await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const [link, ...others] = links ?? [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      className="public-link-dialog"
      title="Share with a link"
    >
      <div className="plink">
        <div className="plink-item">
          <span className="file-entry-icon" data-kind={kind}>
            <Icon aria-hidden="true" />
          </span>
          <span className="plink-item-text">
            <strong>{item.name}</strong>
            <small>
              {item.type === 'FOLDER'
                ? 'Anyone with the link can browse this folder and download its files.'
                : 'Anyone with the link can download this file.'}{' '}
              No account needed.
            </small>
          </span>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        {!allowance || !links ? (
          !error && (
            <div className="plink-loading" aria-label="Loading">
              <Skeleton style={{ height: 40 }} />
              <Skeleton style={{ height: 16, width: '60%' }} />
            </div>
          )
        ) : link ? (
          <LinkPanel
            key={link.id}
            link={link}
            others={others}
            allowance={allowance}
            busy={busy}
            onUpdate={(changes) =>
              run(async () => {
                const { link: changed } = await request(`/v1/links/${link.id}`, {
                  method: 'PATCH',
                  body: changes,
                });
                setLinks((current) => current?.map((l) => (l.id === changed.id ? changed : l)));
                return true;
              })
            }
            onRevoke={(target) =>
              run(async () => {
                await request(`/v1/links/${target.id}`, { method: 'DELETE' });
                setLinks((current) => current?.filter((l) => l.id !== target.id));
                setAllowance((current) => current && { ...current, active: current.active - 1 });
                onChanged?.();
              })
            }
            onClose={onClose}
          />
        ) : allowance.blockedReason ? (
          <>
            <Notice title="Public links aren’t available yet" text={allowance.blockedReason} />
            <Footer onClose={onClose} />
          </>
        ) : allowance.active >= allowance.limit ? (
          <>
            <Notice
              title="You’ve reached your link limit"
              text={`You can have ${allowance.limit} public links at once. Turn one off in Shared → Links to make another.`}
            />
            <Footer onClose={onClose} />
          </>
        ) : (
          <CreatePanel
            item={item}
            allowance={allowance}
            busy={busy}
            onClose={onClose}
            onCreate={(body) =>
              run(async () => {
                const { link: created } = await request('/v1/links', {
                  method: 'POST',
                  body: { driveItemId: item.id, ...body },
                });
                setLinks((current) => [created, ...(current ?? [])]);
                setAllowance((current) => current && { ...current, active: current.active + 1 });
                onChanged?.();
              })
            }
          />
        )}
      </div>
    </Dialog>
  );
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="plink-notice">
      <Lock aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function Footer({ onClose, children }: { onClose: () => void; children?: ReactNode }) {
  return (
    <div className="plink-footer">
      <div className="plink-footer-start">{children}</div>
      <Button variant="outline" onClick={onClose}>
        Done
      </Button>
    </div>
  );
}

function ExpirySelect({
  value,
  neverExpires,
  onChange,
  placeholder,
  disabled,
  label,
}: {
  value: string;
  neverExpires: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {expiries.map((option) => (
        <option key={option.value} value={option.value}>
          {placeholder ? `${option.label} from now` : option.label}
        </option>
      ))}
      {neverExpires && <option value="never">Never</option>}
    </Select>
  );
}

function CreatePanel({
  item,
  allowance,
  busy,
  onCreate,
  onClose,
}: {
  item: Item;
  allowance: Allowance;
  busy: boolean;
  onCreate: (body: { expiresInDays: number | null; password: string | null }) => Promise<unknown>;
  onClose: () => void;
}) {
  const [expiry, setExpiry] = useState(String(PUBLIC_LINK_DEFAULT_EXPIRY_DAYS));
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onCreate({
      expiresInDays: expiry === 'never' ? null : Number(expiry),
      password: protect ? password : null,
    });
  }
  return (
    <form className="plink-create" onSubmit={submit}>
      <div className="plink-settings">
        <div className="plink-setting">
          <span className="plink-setting-text">
            <strong>Expires after</strong>
            <small>The link stops working then. You can change this later.</small>
          </span>
          <ExpirySelect
            label="Link expires after"
            value={expiry}
            neverExpires={allowance.neverExpires}
            onChange={setExpiry}
          />
        </div>
        <div className="plink-setting plink-setting-stack">
          <Field label="Require a password" inline>
            <Checkbox checked={protect} onChange={(e) => setProtect(e.target.checked)} />
          </Field>
          {protect && (
            <PasswordInput
              required
              autoFocus
              minLength={4}
              maxLength={128}
              autoComplete="new-password"
              aria-label="Password"
              placeholder="At least 4 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </div>
      </div>
      <div className="plink-footer">
        <p className="plink-fineprint">
          Opens on harbor0content.online. Moving the {item.type === 'FOLDER' ? 'folder' : 'file'} to
          trash turns the link off.
        </p>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || (protect && password.length < 4)}>
          {busy ? <Loader2 className="spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />}
          Create link
        </Button>
      </div>
    </form>
  );
}

function LinkPanel({
  link,
  others,
  allowance,
  busy,
  onUpdate,
  onRevoke,
  onClose,
}: {
  link: PublicLink;
  others: PublicLink[];
  allowance: Allowance;
  busy: boolean;
  onUpdate: (changes: Changes) => Promise<boolean | undefined>;
  onRevoke: (link: PublicLink) => Promise<void>;
  onClose: () => void;
}) {
  const { copied, copy } = useCopy();
  const [copyFailed, setCopyFailed] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const fresh = useRef(Date.now() - Date.parse(link.createdAt) < 10_000);

  /** Copies the link; when the browser refuses, selects it, and says so only if asked to copy. */
  const copyLink = (target: PublicLink, quiet = false) =>
    copy(target.id, target.url).then((ok) => {
      if (!quiet) setCopyFailed(!ok);
      if (!ok) input.current?.select();
      return ok;
    });
  // A link just made is copied at once, so sharing it is one paste away.
  useEffect(() => {
    if (fresh.current) void copyLink(link, true);
    // Only for the link the panel opened on.
  }, []);

  async function change(changes: Changes, message: string) {
    setSaved('');
    if (await onUpdate(changes)) setSaved(message);
  }
  async function savePassword(event: FormEvent) {
    event.preventDefault();
    await change({ password }, 'Password saved. Anyone who opened the link before needs it now.');
    setEditingPassword(false);
    setPassword('');
  }

  return (
    <>
      {fresh.current && (
        <p className="plink-created" role="status">
          <Check aria-hidden="true" />
          {copied === link.id ? 'Link created and copied' : 'Link created'}
        </p>
      )}
      <div className="plink-url">
        <Globe aria-hidden="true" className="plink-url-icon" />
        <input
          ref={input}
          readOnly
          aria-label="Public link"
          value={shownLink(link.url)}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button onClick={() => void copyLink(link)}>
          {copied === link.id ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied === link.id ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <div className="plink-status">
        <Badge tone="success">
          <span className="plink-dot" aria-hidden="true" />
          Public
        </Badge>
        <span>{linkEnds(link.expiresAt)}</span>
        {link.hasPassword && (
          <span className="plink-status-lock">
            <Lock aria-hidden="true" /> Password
          </span>
        )}
      </div>
      {copyFailed && (
        <Alert tone="warning">
          Your browser didn’t allow copying. The link is selected, so copy it yourself.
        </Alert>
      )}
      {saved && <Alert tone="success">{saved}</Alert>}

      <div className="plink-settings">
        <div className="plink-setting">
          <span className="plink-setting-text">
            <strong>Expiry</strong>
            <small>{link.expiresAt ? `Until ${fileDate(link.expiresAt).date}` : 'Never'}</small>
          </span>
          <ExpirySelect
            label="Change when the link expires"
            placeholder="Change…"
            value=""
            disabled={busy}
            neverExpires={allowance.neverExpires}
            onChange={(value) =>
              void change(
                { expiresInDays: value === 'never' ? null : Number(value) },
                'Expiry updated.',
              )
            }
          />
        </div>
        <div className="plink-setting plink-setting-stack">
          <div className="plink-setting-row">
            <span className="plink-setting-text">
              <strong>Password</strong>
              <small>
                {link.hasPassword
                  ? 'Visitors enter it before they see anything.'
                  : 'Off. Anyone with the link can open it.'}
              </small>
            </span>
            {!editingPassword && (
              <span className="plink-setting-actions">
                {link.hasPassword && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void change({ password: null }, 'Password removed.')}
                  >
                    Remove
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setSaved('');
                    setEditingPassword(true);
                  }}
                >
                  <KeyRound aria-hidden="true" />
                  {link.hasPassword ? 'Change' : 'Add'}
                </Button>
              </span>
            )}
          </div>
          {editingPassword && (
            <form className="plink-password" onSubmit={savePassword}>
              <PasswordInput
                required
                autoFocus
                minLength={4}
                maxLength={128}
                autoComplete="new-password"
                aria-label="New password"
                placeholder="At least 4 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingPassword(false);
                  setPassword('');
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || password.length < 4}>
                Save
              </Button>
            </form>
          )}
        </div>
      </div>

      {others.length > 0 && (
        <details className="plink-others">
          <summary>
            {others.length} more {others.length === 1 ? 'link' : 'links'} to this item
          </summary>
          <ul>
            {others.map((other) => (
              <li key={other.id}>
                <span className="plink-others-text">
                  <code>{shownLink(other.url)}</code>
                  <small>
                    {linkEnds(other.expiresAt)}
                    {other.hasPassword && ' · Password'}
                  </small>
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy this link"
                  onClick={() => void copy(other.id, other.url)}
                >
                  {copied === other.id ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void onRevoke(other)}
                >
                  Turn off
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Footer onClose={onClose}>
        {confirming ? (
          <span className="plink-confirm">
            <span>Stop this link for everyone?</span>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void onRevoke(link)}>
              Turn off
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button variant="ghost" className="plink-revoke" onClick={() => setConfirming(true)}>
            Turn off link
          </Button>
        )}
      </Footer>
    </>
  );
}
