'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Check,
  ChevronRight,
  Clock,
  Download,
  House,
  Loader2,
  Lock,
  TriangleAlert,
  Unlink,
} from 'lucide-react';
import {
  PUBLIC_LINK_PASS_HEADER,
  type PublicFolderPage,
  type PublicItem,
  type PublicLinkView,
} from '@harbor/contracts';
import { fileIcon } from '../../../web/lib/file-icon';
import { fileKind, fileSize } from '../../../web/lib/file-metadata';
import { Alert } from '../../../web/components/ui/alert';
import { Button } from '../../../web/components/ui/button';
import { Dialog, DialogActions } from '../../../web/components/ui/dialog';
import { PasswordInput } from '../../../web/components/ui/input';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { Chrome } from '../chrome';

class LinkError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
type Call = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

const DAY_MS = 86400_000;
const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const month = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const ends = (iso: string) => {
  const days = Math.ceil((Date.parse(iso) - Date.now()) / DAY_MS);
  return days <= 0 ? 'Expires today' : days === 1 ? 'Expires tomorrow' : `Expires in ${days} days`;
};
// A password's pass lasts for this tab, so reloading doesn't ask again.
const passKey = (token: string) => `harbor-link-pass:${token}`;
const readPass = (token: string) => {
  try {
    return sessionStorage.getItem(passKey(token)) ?? '';
  } catch {
    return '';
  }
};

/**
 * The page a public link opens: `/s#<token>`. The token stays in the fragment, so it never
 * reaches CloudFront's logs or another site's Referer.
 */
export default function SharedLink() {
  const [token, setToken] = useState<string | null>();
  const [pass, setPass] = useState('');
  const [view, setView] = useState<PublicLinkView>();
  const [error, setError] = useState<LinkError>();
  // Read after hydration: the static HTML has no address to report.
  const [reportUrl, setReportUrl] = useState<string>();

  useEffect(() => {
    const read = () => {
      setReportUrl(location.href);
      const value = decodeURIComponent(location.hash.slice(1));
      setToken(value || null);
      setPass(value ? readPass(value) : '');
      setView(undefined);
      setError(undefined);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  const call = useCallback(
    async <T,>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const response = await fetch(`/api/v1/public/links/${encodeURIComponent(token!)}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(pass ? { [PUBLIC_LINK_PASS_HEADER]: pass } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        cache: 'no-store',
      });
      const data = await response.json().catch(() => null);
      if (!response.ok)
        throw new LinkError(
          data?.error?.code ?? 'UNAVAILABLE',
          data?.error?.message ?? 'harbor0 is unavailable right now. Try again in a moment.',
        );
      return data as T;
    },
    [token, pass],
  );

  useEffect(() => {
    if (!token) return;
    let current = true;
    call<PublicLinkView>('')
      .then((result) => current && setView(result))
      .catch((e: LinkError) => current && setError(e));
    return () => {
      current = false;
    };
  }, [token, call]);

  // The tab says what was shared once it's known.
  useEffect(() => {
    document.title = view?.item ? `${view.item.name} · Shared with harbor0` : 'Shared with harbor0';
  }, [view]);

  let body;
  if (token === null)
    body = (
      <Message
        icon={<Unlink />}
        title="This link is incomplete"
        text="Open the full link you were sent. It ends with # and a code; some apps cut that part off."
      />
    );
  else if (error)
    body =
      error.code === 'LINK_EXPIRED' ? (
        <Message
          icon={<Clock />}
          title="This link has expired"
          text="Links stop working after the time the person who shared it chose. Ask them for a new one."
        />
      ) : error.code === 'RATE_LIMITED' ? (
        <Message icon={<Clock />} title="Too many requests" text={error.message} />
      ) : (
        <Message
          icon={<Unlink />}
          title="This link doesn’t work"
          text="It may have been turned off, or what it shared was moved to trash. Ask the person who shared it for a new link."
        />
      );
  else if (!view) body = <LoadingCard />;
  else if (view.passwordRequired)
    body = (
      <Unlock
        view={view}
        call={call}
        onPass={(value) => {
          try {
            sessionStorage.setItem(passKey(token!), value);
          } catch {
            /* The pass then lasts until the page is closed. */
          }
          setPass(value);
        }}
      />
    );
  else if (view.item?.type === 'FOLDER')
    body = <FolderView view={view} root={view.item} call={call} />;
  else if (view.item) body = <FileView view={view} item={view.item} call={call} />;
  return <Chrome reportUrl={reportUrl}>{body}</Chrome>;
}

function Message({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <section className="share-card share-message">
      <span className="share-message-icon" aria-hidden="true">
        {icon}
      </span>
      <h1>{title}</h1>
      <p className="muted">{text}</p>
      <a className="btn share-cta" data-variant="outline" data-size="md" href="https://harbor0.com">
        What is harbor0?
      </a>
    </section>
  );
}

function LoadingCard() {
  return (
    <section className="share-card" aria-label="Loading" aria-busy="true">
      <Skeleton className="share-skeleton-tile" />
      <Skeleton style={{ width: '60%', height: 20 }} />
      <Skeleton style={{ width: '35%' }} />
      <Skeleton style={{ width: '100%', height: 40, marginTop: 8 }} />
    </section>
  );
}

/** A file or folder's tile, coloured by kind like in the harbor0 app. */
function Tile({ item, size = 'md' }: { item: PublicItem; size?: 'md' | 'lg' }) {
  const { Icon, kind } = fileIcon(item);
  return (
    <span className="file-entry-icon share-tile" data-kind={kind} data-size={size}>
      <Icon aria-hidden="true" />
    </span>
  );
}

/** Who shared the link and until when: what a visitor checks before trusting a download. */
function SharedBy({ view }: { view: PublicLinkView }) {
  const name = view.sharedBy.displayName;
  return (
    <div className="share-by">
      <span className="avatar" aria-hidden="true">
        {name.trim().charAt(0).toUpperCase() || '?'}
      </span>
      <span className="share-by-text">
        <span>
          Shared by <strong>{name}</strong>
        </span>
        <small>On harbor0 since {month(view.sharedBy.memberSince)}</small>
      </span>
      {view.expiresAt && (
        <span className="share-expiry" title={`Until ${longDate(view.expiresAt)}`}>
          <Clock aria-hidden="true" />
          {ends(view.expiresAt)}
        </span>
      )}
    </div>
  );
}

function Unlock({
  view,
  call,
  onPass,
}: {
  view: PublicLinkView;
  call: Call;
  onPass: (pass: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { pass } = await call<{ pass: string }>('/unlock', {
        method: 'POST',
        body: { password },
      });
      onPass(pass);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <section className="share-card">
      <span className="share-message-icon" aria-hidden="true">
        <Lock />
      </span>
      <h1>Enter the password</h1>
      <p className="muted">
        {view.sharedBy.displayName} protected this link with a password. They should have sent it to
        you separately.
      </p>
      <form className="share-unlock" onSubmit={submit}>
        <PasswordInput
          required
          autoFocus
          size="lg"
          aria-label="Password"
          aria-invalid={!!error}
          aria-describedby={error ? 'share-password-error' : undefined}
          placeholder="Password"
          autoComplete="off"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError('');
          }}
        />
        {error && (
          <p className="share-field-error" id="share-password-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" block disabled={busy || !password}>
          {busy && <Loader2 className="spin" aria-hidden="true" />}
          Unlock
        </Button>
      </form>
      <SharedBy view={view} />
    </section>
  );
}

/**
 * Downloads one file. Programs and installers ask first; the button says when the download has
 * started, since the browser saves it without leaving the page.
 */
function useDownload(call: Call) {
  const [busy, setBusy] = useState<string>();
  const [started, setStarted] = useState<string>();
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<{ item: PublicItem; itemId?: string }>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const start = async (item: PublicItem, itemId?: string) => {
    setConfirm(undefined);
    setBusy(item.id);
    setError('');
    try {
      const { downloadUrl } = await call<{ downloadUrl: string }>('/download', {
        method: 'POST',
        body: itemId ? { itemId } : {},
      });
      // Storage answers as an attachment, so the browser saves it and stays on this page.
      window.location.assign(downloadUrl);
      setStarted(item.id);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStarted(undefined), 4000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const download = (item: PublicItem, itemId?: string) =>
    item.executable ? setConfirm({ item, itemId }) : void start(item, itemId);

  const dialog = (
    <Dialog
      open={!!confirm}
      onOpenChange={(open) => !open && setConfirm(undefined)}
      title="Download a program?"
      description={
        confirm &&
        `“${confirm.item.name}” is a program or installer. Programs can harm your computer. Only open it if you know and trust the person who shared it.`
      }
    >
      <DialogActions>
        <Button variant="outline" onClick={() => setConfirm(undefined)}>
          Cancel
        </Button>
        <Button onClick={() => confirm && void start(confirm.item, confirm.itemId)}>
          Download anyway
        </Button>
      </DialogActions>
    </Dialog>
  );
  return { busy, started, error, download, dialog };
}

function DownloadLabel({
  item,
  busy,
  started,
  compact,
}: {
  item: PublicItem;
  busy?: string;
  started?: string;
  compact?: boolean;
}) {
  const Icon = busy === item.id ? Loader2 : started === item.id ? Check : Download;
  const label = busy === item.id ? 'Preparing…' : started === item.id ? 'Downloading' : 'Download';
  return (
    <>
      <Icon className={busy === item.id ? 'spin' : undefined} aria-hidden="true" />
      <span className={compact ? 'share-download-label' : undefined}>{label}</span>
    </>
  );
}

function FileView({ view, item, call }: { view: PublicLinkView; item: PublicItem; call: Call }) {
  const { busy, started, error, download, dialog } = useDownload(call);
  return (
    <section className="share-card">
      <Tile item={item} size="lg" />
      <h1 className="share-name">{item.name}</h1>
      <p className="muted share-meta">
        {fileKind(item)} · {fileSize(item.sizeBytes)}
      </p>
      {item.executable && (
        <Alert tone="warning">
          This is a program or installer. Only open it if you trust the person who shared it.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <Button size="lg" block disabled={!!busy} onClick={() => download(item)}>
        <DownloadLabel item={item} busy={busy} started={started} />
      </Button>
      {started === item.id && (
        <p className="muted share-hint" role="status">
          Your browser is saving the file. Check your downloads.
        </p>
      )}
      <SharedBy view={view} />
      {dialog}
    </section>
  );
}

function FolderView({ view, root, call }: { view: PublicLinkView; root: PublicItem; call: Call }) {
  const [folderId, setFolderId] = useState<string>();
  const [page, setPage] = useState<PublicFolderPage>();
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const { busy, started, error: downloadError, download, dialog } = useDownload(call);

  useEffect(() => {
    let current = true;
    setPage(undefined);
    setError('');
    call<PublicFolderPage>(`/items${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''}`)
      .then((result) => current && setPage(result))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [call, folderId]);

  async function loadMore() {
    if (!page?.nextCursor) return;
    setMore(true);
    try {
      const query = new URLSearchParams({
        ...(folderId ? { folderId } : {}),
        cursor: page.nextCursor,
      });
      const next = await call<PublicFolderPage>(`/items?${query}`);
      setPage({ ...next, items: [...page.items, ...next.items] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMore(false);
    }
  }

  const count = page
    ? `${page.items.length}${page.nextCursor ? '+' : ''} ${page.items.length === 1 && !page.nextCursor ? 'item' : 'items'}`
    : '';
  return (
    <section className="share-card share-folder">
      <div className="share-folder-head">
        <Tile item={root} size="lg" />
        <div className="share-folder-title">
          <h1 className="share-name">{root.name}</h1>
          <p className="muted share-meta">
            Folder{count && ` · ${count}${page && page.path.length > 1 ? ' here' : ''}`}
          </p>
        </div>
      </div>
      <SharedBy view={view} />
      {page && page.path.length > 1 && (
        <nav className="share-crumbs" aria-label="Folder">
          {page.path.map((crumb, i, path) => (
            <span key={crumb.id} className="share-crumb">
              {i > 0 && <ChevronRight aria-hidden="true" className="share-crumb-sep" />}
              {i < path.length - 1 ? (
                <button onClick={() => setFolderId(i === 0 ? undefined : crumb.id)}>
                  {i === 0 && <House aria-hidden="true" />}
                  {crumb.name}
                </button>
              ) : (
                <span aria-current="page">
                  {i === 0 && <House aria-hidden="true" />}
                  {crumb.name}
                </span>
              )}
            </span>
          ))}
        </nav>
      )}
      {(error || downloadError) && <Alert tone="error">{error || downloadError}</Alert>}
      {!page ? (
        !error && (
          <div className="share-list" aria-label="Loading" aria-busy="true">
            {[0, 1, 2].map((n) => (
              <div className="share-row" key={n}>
                <Skeleton className="share-skeleton-icon" />
                <Skeleton style={{ flex: 1, maxWidth: 220 }} />
              </div>
            ))}
          </div>
        )
      ) : page.items.length === 0 ? (
        <p className="muted share-empty">This folder is empty.</p>
      ) : (
        <ul className="share-list">
          {page.items.map((item) => (
            <li key={item.id}>
              {item.type === 'FOLDER' ? (
                <button className="share-row share-row-folder" onClick={() => setFolderId(item.id)}>
                  <Tile item={item} />
                  <span className="share-row-text">
                    <strong>{item.name}</strong>
                    <small>Folder</small>
                  </span>
                  <ChevronRight aria-hidden="true" className="share-row-end" />
                </button>
              ) : (
                <div className="share-row">
                  <Tile item={item} />
                  <span className="share-row-text">
                    <strong>
                      {item.name}
                      {item.executable && (
                        <TriangleAlert
                          aria-label="Program or installer"
                          className="share-row-warning"
                        />
                      )}
                    </strong>
                    <small>
                      {fileKind(item)} · {fileSize(item.sizeBytes)}
                    </small>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    aria-label={`Download ${item.name}`}
                    onClick={() => download(item, item.id)}
                  >
                    <DownloadLabel item={item} busy={busy} started={started} compact />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {page?.nextCursor && (
        <Button variant="outline" disabled={more} onClick={() => void loadMore()}>
          {more && <Loader2 className="spin" aria-hidden="true" />}
          Show more
        </Button>
      )}
      {dialog}
    </section>
  );
}
