'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  authRoutes,
  workspaceRoutes,
  type AuthMode,
  type WorkspaceSection,
  loginDestination,
  driveHref,
} from '../lib/routes';
import { loadFolderTrail } from '../lib/folder-navigation';
import { downloadFolderZip } from '../lib/folder-download';
import { ZipDownloadStatusPanel, type ZipDownloadStatus } from './zip-download-status';
import { BrandLogo } from '../components/brand-logo';
import { FilePreview } from '../components/file-preview';
import { previewKind, type PreviewLoader } from '../lib/file-preview';
import { fetchTextPreview } from '../../../packages/api-client/src/preview';
import { Input } from '../components/ui/input';
import { Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Bell,
  Check,
  ChevronRight,
  Cloud,
  File as FileIcon,
  FileImage,
  FileText,
  Folder,
  HardDrive,
  Inbox,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
  Users,
  Laptop,
  Clock,
  Pause,
  Play,
  X,
} from 'lucide-react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { ApiClient, ApiError, createTransport, operation } from '@harbor/api-client';
import type { DriveItem, Device, Transfer } from '@harbor/contracts';
import { EmptyState, FileEmptyState, LoadError } from '../components/empty-state';
import { AppearanceSettings } from '../components/appearance-settings';
import { useAccountAppearance } from '../lib/appearance';
import {
  FileCollection,
  FileCollectionSkeleton,
  FileLoadError,
} from '../components/file-collection';
import { ContentSkeleton, WorkspaceSkeleton } from '../components/loading-states';
import { ThemeToggle } from '../components/theme-toggle';
import { TransferTable, type TransferView } from './transfer-table';
import { BackupsPage } from './backups-page';
import { DriveWorkspace } from './drive-workspace';
import { AccountMenu, StorageIndicator } from './drive-account';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { BrowserUpload, type UploadProgress } from '../lib/upload';
const api = new ApiClient(createTransport('/api'));
const loadPreview: PreviewLoader = async (item, signal) => {
  const result = await api.download({ driveItemId: item.id });
  signal.throwIfAborted();
  return previewKind(item) === 'text'
    ? fetchTextPreview(result.downloadUrl, result.sizeBytes, signal)
    : { url: result.downloadUrl };
};
const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, e) => !(e instanceof ApiError && [401, 403].includes(e.status)) && count < 2,
        refetchOnWindowFocus: true,
        staleTime: 10000,
      },
    },
  });
const bytes = (n: number) =>
  n < 1000
    ? `${n} B`
    : n < 1e6
      ? `${(n / 1e3).toFixed(1)} KB`
      : n < 1e9
        ? `${(n / 1e6).toFixed(1)} MB`
        : `${(n / 1e9).toFixed(1)} GB`;
const date = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const navigation = [
  { name: 'My Drive', icon: HardDrive },
  { name: 'Received', icon: Inbox },
  { name: 'Sent', icon: Send },
  { name: 'Shared', icon: Users },
  { name: 'Favorites', icon: Star },
  { name: 'Trash', icon: Trash2 },
  { name: 'Backups', icon: Archive },
  { name: 'Devices', icon: Laptop },
  { name: 'Storage', icon: Cloud },
  { name: 'Settings', icon: Settings },
];
function FileGlyph({ item }: { item: Pick<DriveItem, 'type' | 'mimeType'> }) {
  const Icon =
    item.type === 'FOLDER'
      ? Folder
      : item.mimeType?.startsWith('image/')
        ? FileImage
        : item.mimeType?.includes('pdf') || item.mimeType?.startsWith('text/')
          ? FileText
          : FileIcon;
  return (
    <span
      className={`file-glyph ${item.type === 'FOLDER' ? 'folder' : item.mimeType?.startsWith('image/') ? 'image' : 'document'}`}
    >
      <Icon size={22} />
    </span>
  );
}
function Auth({ mode, onDone }: { mode: AuthMode; onDone: () => void }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = loginDestination(searchParams.get('next'));
  const authHref = (mode: AuthMode) => `${authRoutes[mode]}?next=${encodeURIComponent(next)}`;
  const setMode = (mode: AuthMode) => router.push(authHref(mode));
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(''), [mode]);
  const titles = {
    login: 'Sign in',
    signup: 'Create an account',
    confirm: 'Verify your email',
    forgot: 'Reset your password',
    reset: 'Set a new password',
  };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (mode === 'login') {
        await api.request('/v1/auth/login', {
          method: 'POST',
          body: { ...values, deviceName: 'Web browser', platform: 'WEB' },
        });
        onDone();
      } else {
        await api.request(`/v1/auth/${mode}`, { method: 'POST', body: values });
        setMode(mode === 'signup' ? 'confirm' : mode === 'forgot' ? 'reset' : 'login');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-theme">
        <ThemeToggle />
      </div>
      <section className="auth-story">
        <div className="brand">
          <BrandLogo />
        </div>
        <div>
          <h1>File storage and sync</h1>
          <p>Store, sync, and share files. 100 GB free.</p>
        </div>
        <div className="auth-foot">
          <ShieldCheck size={18} />
          Files are private unless you share them.
        </div>
      </section>
      <section className="auth-form">
        <div>
          <h2>{titles[mode]}</h2>
          <p className="muted">
            {mode === 'login'
              ? 'Enter your email and password.'
              : mode === 'signup'
                ? 'Create an account with 100 GB of storage.'
                : mode === 'confirm'
                  ? 'Enter the verification code sent to your email.'
                  : 'Use your account email to continue.'}
          </p>
          <form onSubmit={submit}>
            <label>
              Email
              <Input
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            {mode === 'signup' && (
              <>
                <label>
                  Display name
                  <Input name="displayName" autoComplete="name" required maxLength={100} />
                </label>
                <label>
                  Username
                  <div className="input-prefix">
                    <span>@</span>
                    <Input
                      name="username"
                      aria-label="Username"
                      autoComplete="username"
                      required
                      pattern="[a-z0-9_.]{3,32}"
                    />
                  </div>
                  <small>People can send files directly to your @username.</small>
                </label>
              </>
            )}
            {['login', 'signup', 'reset'].includes(mode) && (
              <label>
                Password
                <Input
                  name="password"
                  aria-label="Password"
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={mode === 'login' ? 1 : 12}
                />
                {mode !== 'login' && (
                  <small>
                    At least 12 characters, including upper/lowercase, a number, and a symbol.
                  </small>
                )}
              </label>
            )}
            {['confirm', 'reset'].includes(mode) && (
              <label>
                Verification code
                <Input name="code" autoComplete="one-time-code" required />
              </label>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Button disabled={busy} type="submit" className="full">
              {busy
                ? 'Please wait…'
                : {
                    login: 'Sign in',
                    signup: 'Create your account',
                    confirm: 'Verify email',
                    forgot: 'Send reset code',
                    reset: 'Reset password',
                  }[mode]}
              <ArrowUpRight size={17} />
            </Button>
          </form>
          <div className="auth-links">
            <Link href={authHref(mode === 'signup' ? 'login' : 'signup')}>
              {mode === 'signup'
                ? 'Already have an account? Sign in'
                : 'New here? Create an account'}
            </Link>
            <Link href={authHref('forgot')}>Forgot password?</Link>
            {mode === 'confirm' && (
              <button
                onClick={() =>
                  void api
                    .request('/v1/auth/resend', { method: 'POST', body: { email } })
                    .catch((e) => setError(e.message))
                }
              >
                Resend code
              </button>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
function Workspace() {
  const cache = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const section =
    (Object.keys(workspaceRoutes) as WorkspaceSection[]).find(
      (name) => workspaceRoutes[name] === pathname,
    ) ?? 'My Drive';
  const authMode = (Object.keys(authRoutes) as AuthMode[]).find(
    (mode) => authRoutes[mode] === pathname,
  );
  const next = loginDestination(searchParams.get('next'));
  const parentId = pathname === '/drive' ? searchParams.get('folder') || null : null;
  const [query, setQuery] = useState('');
  const [grid, setGrid] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [modal, setModal] = useState<{ mode: string; item?: DriveItem } | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState<ZipDownloadStatus | null>(null);
  const zipJob = useRef<AbortController | null>(null);
  useEffect(() => () => zipJob.current?.abort(), []);
  const [cursor, setCursor] = useState<string>();
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const [online, setOnline] = useState(true);
  const jobs = useRef(
    new Map<string, { upload: BrowserUpload; file: File; parent: string | null }>(),
  );
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me() });
  const user = me.data?.user;
  const needsLogin = me.error instanceof ApiError && [401, 403].includes(me.error.status);
  useAccountAppearance(needsLogin ? undefined : user?.id, api.request);
  useEffect(() => {
    if (user && (pathname === '/' || authMode)) router.replace(authMode ? next : '/drive');
    else if (needsLogin && !authMode) {
      const destination =
        pathname === '/drive' ? driveHref(parentId) : pathname === '/' ? '/drive' : pathname;
      router.replace(`/login?next=${encodeURIComponent(destination)}`);
    }
  }, [user, needsLogin, pathname, parentId, authMode, next, router]);
  useEffect(() => {
    setQuery('');
    setSelected([]);
    setCursor(undefined);
    setError('');
    setModal(null);
  }, [pathname, parentId]);
  const folderTrail = useQuery({
    queryKey: ['folder-trail', parentId],
    enabled: !!user && !!parentId,
    queryFn: ({ signal }) => loadFolderTrail(api, parentId!, signal),
  });
  const trail = parentId ? (folderTrail.data ?? [{ id: parentId, name: 'Folder' }]) : [];
  const fileSection = ['My Drive', 'Favorites', 'Trash'].includes(section) || !!query;
  const listing = useQuery<{ items: DriveItem[]; nextCursor: string | null }>({
    queryKey: ['files', section, parentId, query, cursor],
    enabled: !!user && fileSection && section !== 'My Drive',
    queryFn: () => {
      if (section === 'My Drive' && !query) return api.list(parentId, cursor);
      const params = new URLSearchParams({
        ...(query ? { q: query } : {}),
        ...(section === 'Favorites' ? { favorite: 'true' } : {}),
        ...(section === 'Trash' ? { trash: 'true' } : {}),
        ...(cursor ? { cursor } : {}),
      });
      return api.request('/v1/search?' + params);
    },
  });
  const transfers = useQuery<{ items: TransferView[]; nextCursor: string | null }>({
    queryKey: ['transfers', section, cursor],
    enabled: !!user && ['Received', 'Sent'].includes(section),
    queryFn: () =>
      api.request(
        `/v1/transfers/${section.toLowerCase()}${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
      ),
    refetchInterval: 15000,
  });
  const shares = useQuery<{ items: any[] }>({
    queryKey: ['shares'],
    enabled: !!user && section === 'Shared',
    queryFn: async () => {
      const [received, sent] = await Promise.all([
        api.request('/v1/shares/received'),
        api.request('/v1/shares/sent'),
      ]);
      return { items: [...received.items, ...sent.items] };
    },
  });
  const devices = useQuery<{ items: Device[] }>({
    queryKey: ['devices'],
    enabled: !!user && section === 'Devices',
    queryFn: () => api.request('/v1/devices'),
  });
  const notices = useQuery<{ items: any[] }>({
    queryKey: ['notifications'],
    enabled: !!user && section === 'Notifications',
    queryFn: () => api.request('/v1/notifications'),
  });
  const versions = useQuery<{ items: any[] }>({
    queryKey: ['versions', modal?.item?.id],
    enabled: modal?.mode === 'versions',
    queryFn: () => api.request(`/v1/drive/items/${modal!.item!.id}/versions`),
  });
  const files = listing.data?.items ?? [];
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        search.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'u') {
        e.preventDefault();
        input.current?.click();
      }
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'Escape') setSelected([]);
      if (e.key === 'F2' && selected.length === 1) {
        const item = files.find((f) => f.id === selected[0]);
        if (item) setModal({ mode: 'rename', item });
      }
      if (e.key === 'Delete' && selected.length === 1) {
        const item = files.find((f) => f.id === selected[0]);
        if (item) setModal({ mode: 'trash', item });
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [selected, files]);
  const refresh = async () => {
    await Promise.all(
      ['files', 'folder-trail', 'me', 'transfers', 'shares', 'devices', 'notifications'].map((k) =>
        cache.invalidateQueries({ queryKey: [k] }),
      ),
    );
  };
  async function act(fn: () => Promise<unknown>, message?: string) {
    setError('');
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (message) setToast(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function resetPage() {
    setQuery('');
    setSelected([]);
    setCursor(undefined);
    setError('');
    setModal(null);
  }
  function navigate(name: WorkspaceSection) {
    resetPage();
    router.push(workspaceRoutes[name]);
  }
  function open(item: DriveItem) {
    if (item.type === 'FOLDER') {
      resetPage();
      router.push(driveHref(item.id));
    } else setModal({ mode: 'preview', item });
  }
  async function download(data: {
    driveItemId?: string;
    versionId?: string;
    transferId?: string;
    entryId?: string;
  }) {
    await act(async () => {
      const r = await api.download(data);
      const a = document.createElement('a');
      a.href = r.downloadUrl;
      a.rel = 'noreferrer';
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
    });
  }
  async function downloadFolder(item: DriveItem) {
    if (zipJob.current) return;
    const controller = new AbortController();
    zipJob.current = controller;
    setError('');
    setZipProgress({
      name: item.name,
      phase: 'queued',
      files: 0,
      bytes: 0,
      currentFile: null,
      fileBytes: 0,
      fileSize: null,
    });
    try {
      const saved = await downloadFolderZip(api, item, controller.signal, (progress) =>
        setZipProgress({ name: item.name, ...progress }),
      );
      if (saved) setToast(`${item.name}.zip download started. Check your browser’s downloads.`);
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      zipJob.current = null;
      setZipProgress(null);
    }
  }
  async function startUpload(file: File, target = parentId) {
    if (!user) return;
    const upload = new BrowserUpload(api, user.id);
    const key = file.name;
    const record = { upload, file, parent: target };
    jobs.current.set(key, record);
    const update = (p: UploadProgress) =>
      setProgress((old) => [...old.filter((v) => v.name !== p.name), p]);
    try {
      await upload.run(file, target, update);
      await refresh();
    } catch (e) {
      update({
        name: file.name,
        size: file.size,
        loaded: 0,
        phase: (e as Error).name === 'AbortError' ? 'paused' : 'failed',
        error: (e as Error).message,
      });
    }
  }
  async function uploadFiles(files: FileList | File[] | null, folder = false) {
    if (!files) return;
    const folders = new Map<string, string>();
    for (const file of Array.from(files)) {
      let target = parentId;
      if (folder && file.webkitRelativePath) {
        const segments = file.webkitRelativePath.split('/').slice(0, -1);
        let path = '';
        for (const name of segments) {
          path += '/' + name;
          if (!folders.has(path)) {
            try {
              const { item } = await api.createFolder(name, target);
              folders.set(path, item.id);
            } catch (e) {
              setError((e as Error).message);
              return;
            }
          }
          target = folders.get(path)!;
        }
      }
      await startUpload(file, target);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const item = modal?.item;
    const result = await act(
      async () => {
        switch (modal?.mode) {
          case 'folder':
            await api.createFolder(values.name, parentId);
            break;
          case 'rename':
            await api.request(`/v1/drive/items/${item!.id}`, {
              method: 'PATCH',
              body: { ...operation(), baseRevision: item!.revision, name: values.name },
            });
            break;
          case 'move':
            await api.request(`/v1/drive/items/${item!.id}/move`, {
              method: 'POST',
              body: {
                ...operation(),
                baseRevision: item!.revision,
                parentId: values.parentId || null,
              },
            });
            break;
          case 'send':
          case 'share': {
            const recipient = {
              type:
                values.recipient.includes('@') && !values.recipient.startsWith('@')
                  ? 'EMAIL'
                  : 'USERNAME',
              value: values.recipient.replace(/^@/, ''),
            };
            await api.request(modal.mode === 'send' ? '/v1/transfers' : '/v1/shares', {
              method: 'POST',
              body: {
                ...operation(),
                recipient,
                ...(modal.mode === 'send'
                  ? {
                      items: (selected.length ? selected : [item!.id]).map((driveItemId) => ({
                        driveItemId,
                      })),
                    }
                  : { driveItemId: item!.id, permission: values.permission ?? 'VIEWER' }),
              },
            });
            break;
          }
          case 'trash':
            await api.request(`/v1/drive/items/${item!.id}`, {
              method: 'DELETE',
              body: { ...operation(), baseRevision: item!.revision },
            });
            break;
          case 'empty-trash':
            await api.emptyTrash();
            setCursor(undefined);
            break;
          case 'permanent':
            await api.request(`/v1/drive/items/${item!.id}/permanent`, {
              method: 'DELETE',
              body: { ...operation(), baseRevision: item!.revision },
            });
            break;
        }
      },
      modal?.mode === 'send'
        ? 'Sent. Your recipient will see it after signing in.'
        : 'Changes saved.',
    );
    if (result) {
      setModal(null);
      setSelected([]);
    }
  }
  async function toggleFavorite(item: DriveItem) {
    await act(() =>
      api.request(`/v1/drive/items/${item.id}/favorite`, {
        method: item.favorite ? 'DELETE' : 'PUT',
        body: { ...operation(), baseRevision: item.revision },
      }),
    );
  }
  async function transferAction(t: Transfer, action: string) {
    await act(
      () =>
        api.request(`/v1/transfers/${t.id}/${action}`, {
          method: 'POST',
          body: { ...operation(), ...(action === 'save' ? { targetParentId: null } : {}) },
        }),
      action === 'save'
        ? 'Saving to My Drive. Large folders finish in the background.'
        : 'Transfer updated.',
    );
  }
  if (me.isPending) return <WorkspaceSkeleton />;
  if (!user) {
    if (me.isError && !needsLogin)
      return (
        <main className="loading-screen">
          <Cloud size={36} />
          <h2>We couldn’t reach your drive.</h2>
          <p>{me.error.message}</p>
          <Button onClick={() => void me.refetch()}>Try again</Button>
        </main>
      );
    if (!authMode) return <WorkspaceSkeleton />;
    return (
      <Auth
        mode={authMode}
        onDone={() => {
          cache.clear();
          void me.refetch();
        }}
      />
    );
  }
  if (authMode || pathname === '/') return <WorkspaceSkeleton />;
  const usage = me.data!.storage;
  const pageError =
    error ||
    (listing.error as Error)?.message ||
    (transfers.error as Error)?.message ||
    (shares.error as Error)?.message ||
    (devices.error as Error)?.message;
  return (
    <div className="app-shell">
      <a className="skip-to-content" href="#workspace-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="brand" href="/drive" onNavigate={resetPage} aria-label="harbor0 home">
          <BrandLogo />
        </Link>
        <Button
          onClick={() => input.current?.click()}
          className="upload-button"
          aria-label="Upload files"
        >
          <Plus size={18} />
          <span className="upload-label">Upload files</span>
        </Button>
        <nav aria-label="Main navigation">
          {navigation.map(({ name, icon: Icon }) => (
            <Link
              href={workspaceRoutes[name as WorkspaceSection]}
              onNavigate={resetPage}
              key={name}
              aria-label={name}
              title={name}
              className={`nav-item ${section === name ? 'active' : ''} ${name === 'Devices' ? 'nav-separated' : ''}`}
              aria-current={section === name ? 'page' : undefined}
            >
              <Icon size={18} />
              <span>{name}</span>
              {section === name && <span className="nav-indicator" />}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <StorageIndicator storage={usage} onManage={() => navigate('Storage')} />
          <AccountMenu
            footer
            user={user}
            storage={usage}
            onNavigate={navigate}
            onSignOut={() =>
              void act(async () => {
                await api.request('/v1/auth/logout', { method: 'POST', body: {} });
                cache.clear();
                window.location.reload();
              })
            }
          />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="search-box">
            <Search size={18} />
            <Input
              ref={search}
              className="border-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
              aria-label="Search files"
              placeholder="Search your files"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(undefined);
              }}
            />
            <kbd>⌘ K</kbd>
          </div>
          <div className="topbar-right">
            <ThemeToggle />
            <span
              className="private-badge"
              aria-label="Private workspace"
              title="Private workspace"
            >
              <ShieldCheck size={15} />
              Private workspace
            </span>
            <Link href="/notifications" aria-label="Notifications" className="icon-button">
              <Bell size={19} />
            </Link>
            <AccountMenu
              user={user}
              storage={usage}
              onNavigate={navigate}
              onSignOut={() =>
                void act(async () => {
                  await api.request('/v1/auth/logout', { method: 'POST', body: {} });
                  cache.clear();
                  window.location.reload();
                })
              }
            />
          </div>
        </header>
        <main
          id="workspace-content"
          tabIndex={-1}
          className={`workspace ${section === 'My Drive' ? 'drive-page' : ''}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void uploadFiles(e.dataTransfer.files);
          }}
        >
          {!online && (
            <div className="notice">
              You’re offline. Changes will sync when your connection returns.
            </div>
          )}
          {pageError && (
            <div className="error banner" role="alert">
              {pageError}
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {zipProgress && (
            <ZipDownloadStatusPanel
              progress={zipProgress}
              onCancel={() => zipJob.current?.abort()}
            />
          )}
          {section !== 'My Drive' && (
            <div className="page-heading">
              <div>
                <h1>{query ? 'Search results' : section}</h1>
                {query && <p className="muted">Files matching “{query}”</p>}
              </div>
              {fileSection && section !== 'Trash' && (
                <div className="heading-actions">
                  <Button variant="outline" onClick={() => setModal({ mode: 'folder' })}>
                    <Plus size={16} />
                    New folder
                  </Button>
                  <Button onClick={() => input.current?.click()}>
                    <ArrowUpFromLine size={16} />
                    Upload files
                  </Button>
                </div>
              )}
            </div>
          )}
          {section === 'My Drive' && (
            <DriveWorkspace
              request={api.request}
              parentId={parentId}
              trail={trail}
              query={query}
              onClearSearch={() => setQuery('')}
              userId={user.id}
              storage={usage}
              refreshKey={me.dataUpdatedAt}
              breadcrumbs={
                <>
                  <Link href="/drive" onNavigate={resetPage}>
                    My Drive
                  </Link>
                  {trail.map((t) => (
                    <span key={t.id}>
                      <ChevronRight size={14} />
                      <Link
                        href={driveHref(t.id)}
                        onNavigate={resetPage}
                        aria-current={t.id === parentId ? 'location' : undefined}
                      >
                        {t.name}
                      </Link>
                    </span>
                  ))}
                  {parentId && folderTrail.isError && (
                    <button onClick={() => void folderTrail.refetch()}>Retry folder path</button>
                  )}
                </>
              }
              onOpen={open}
              onSyncRemoved={() => navigate('My Drive')}
              onUpload={() => input.current?.click()}
              onUploadFolder={() => folderInput.current?.click()}
              onDropFiles={(files) => uploadFiles(files)}
              onDownload={async (item, versionId) => {
                if (item.type === 'FOLDER') await downloadFolder(item);
                else await download({ driveItemId: item.id, ...(versionId ? { versionId } : {}) });
              }}
              onChanged={() => void refresh()}
              onManageStorage={() => navigate('Storage')}
            />
          )}
          {fileSection && section !== 'My Drive' && (
            <>
              <div className="file-toolbar">
                <div className="breadcrumbs">
                  <Link href={workspaceRoutes[section]} onNavigate={resetPage}>
                    {' '}
                    {section}
                  </Link>
                  {trail.map((t) => (
                    <span key={t.id}>
                      <ChevronRight size={14} />
                      <Link
                        href={driveHref(t.id)}
                        onNavigate={resetPage}
                        aria-current={t.id === parentId ? 'location' : undefined}
                      >
                        {t.name}
                      </Link>
                    </span>
                  ))}
                  {parentId && folderTrail.isError && (
                    <button onClick={() => void folderTrail.refetch()}>Retry folder path</button>
                  )}
                  <span className="count">
                    {listing.isPending
                      ? 'Loading…'
                      : listing.isError && !files.length
                        ? 'Unavailable'
                        : `${files.length} items${cursor || listing.data?.nextCursor ? ' on this page' : ''}`}
                  </span>
                </div>
                {section === 'Trash' && (
                  <Button
                    variant="destructive"
                    disabled={
                      busy ||
                      listing.isPending ||
                      listing.isError ||
                      (!files.length && !cursor && !listing.data?.nextCursor && !query)
                    }
                    onClick={() => setModal({ mode: 'empty-trash' })}
                  >
                    <Trash2 size={16} />
                    Empty Trash
                  </Button>
                )}
                <div className="view-switch">
                  <button
                    aria-label="List view"
                    aria-pressed={!grid}
                    onClick={() => setGrid(false)}
                  >
                    <List size={17} />
                  </button>
                  <button aria-label="Grid view" aria-pressed={grid} onClick={() => setGrid(true)}>
                    <LayoutGrid size={17} />
                  </button>
                </div>
              </div>
              {selected.length > 0 && (
                <div className="selection-bar">
                  <span>{selected.length} selected</span>
                  <Button
                    size="sm"
                    onClick={() =>
                      setModal({ mode: 'send', item: files.find((f) => f.id === selected[0]) })
                    }
                  >
                    <Send size={14} />
                    Send
                  </Button>
                  <button onClick={() => setSelected([])}>Clear</button>
                </div>
              )}
              {listing.isPending ? (
                <FileCollectionSkeleton grid={grid} />
              ) : listing.isError && !files.length ? (
                <FileLoadError onRetry={() => void listing.refetch()} />
              ) : files.length === 0 ? (
                <FileEmptyState
                  section={section}
                  search={!!query}
                  inFolder={!!parentId}
                  busy={busy}
                  onUpload={() => input.current?.click()}
                  onCreateFolder={() => setModal({ mode: 'folder' })}
                  onBrowse={() => navigate('My Drive')}
                  onClearSearch={() => {
                    setQuery('');
                    setCursor(undefined);
                    setSelected([]);
                  }}
                />
              ) : (
                <FileCollection
                  items={files}
                  userId={user.id}
                  grid={grid}
                  trash={section === 'Trash'}
                  selected={selected}
                  onSelectionChange={setSelected}
                  onOpen={open}
                  refreshing={listing.isFetching}
                  renderActions={(item) => (
                    <Menu.Root>
                      <Menu.Trigger className="icon-button" aria-label={`Actions for ${item.name}`}>
                        <MoreHorizontal size={19} />
                      </Menu.Trigger>
                      <Menu.Portal>
                        <Menu.Content className="dropdown" align="end" sideOffset={5}>
                          {section === 'Trash' ? (
                            <>
                              <Menu.Item
                                onSelect={() =>
                                  void act(() =>
                                    api.request(`/v1/drive/items/${item.id}/restore`, {
                                      method: 'POST',
                                      body: { ...operation(), baseRevision: item.revision },
                                    }),
                                  )
                                }
                              >
                                Restore
                              </Menu.Item>
                              <Menu.Item
                                className="danger-text"
                                onSelect={() => setModal({ mode: 'permanent', item })}
                              >
                                Delete permanently
                              </Menu.Item>
                            </>
                          ) : (
                            <>
                              {item.type === 'FILE' && (
                                <Menu.Item onSelect={() => setModal({ mode: 'preview', item })}>
                                  Preview
                                </Menu.Item>
                              )}
                              <Menu.Item
                                disabled={busy || !!zipProgress}
                                onSelect={() =>
                                  void (item.type === 'FOLDER'
                                    ? downloadFolder(item)
                                    : download({ driveItemId: item.id }))
                                }
                              >
                                {item.type === 'FOLDER' ? 'Download as ZIP' : 'Download'}
                              </Menu.Item>
                              <Menu.Item onSelect={() => setModal({ mode: 'send', item })}>
                                Send to someone
                              </Menu.Item>
                              <Menu.Item onSelect={() => setModal({ mode: 'share', item })}>
                                Share access
                              </Menu.Item>
                              <Menu.Separator />
                              <Menu.Item onSelect={() => setModal({ mode: 'details', item })}>
                                File details
                              </Menu.Item>
                              <Menu.Item onSelect={() => setModal({ mode: 'rename', item })}>
                                Rename
                              </Menu.Item>
                              <Menu.Item onSelect={() => setModal({ mode: 'move', item })}>
                                Move
                              </Menu.Item>
                              <Menu.Item onSelect={() => void toggleFavorite(item)}>
                                {item.favorite ? 'Remove favorite' : 'Add to favorites'}
                              </Menu.Item>
                              {item.type === 'FILE' && (
                                <Menu.Item onSelect={() => setModal({ mode: 'versions', item })}>
                                  Version history
                                </Menu.Item>
                              )}
                              <Menu.Separator />
                              <Menu.Item
                                className="danger-text"
                                onSelect={() => setModal({ mode: 'trash', item })}
                              >
                                Move to trash
                              </Menu.Item>
                            </>
                          )}
                        </Menu.Content>
                      </Menu.Portal>
                    </Menu.Root>
                  )}
                />
              )}

              {listing.data?.nextCursor && (
                <Button variant="outline" onClick={() => setCursor(listing.data!.nextCursor!)}>
                  Next page
                </Button>
              )}
              <div className="drive-footer">
                <ShieldCheck size={14} />
                Only you and the people you choose can access your files.
                <button onClick={() => folderInput.current?.click()}>Upload a folder</button>
              </div>
            </>
          )}
          {['Received', 'Sent'].includes(section) && (
            <div className="transfer-list">
              {transfers.isPending ? (
                <ContentSkeleton label="Loading transfers" />
              ) : transfers.isError && !transfers.data?.items.length ? (
                <LoadError onRetry={() => void transfers.refetch()} />
              ) : !transfers.data?.items.length ? (
                <EmptyState
                  icon={section === 'Received' ? <Inbox /> : <Send />}
                  title={section === 'Received' ? 'No received files' : 'No sent files'}
                  description={
                    section === 'Received'
                      ? `People can send files directly to @${user.username}.`
                      : 'Choose a file in My Drive and select Send from its menu to share it directly with someone.'
                  }
                  actions={
                    <Button variant="outline" onClick={() => navigate('My Drive')}>
                      Browse My Drive
                    </Button>
                  }
                />
              ) : (
                <TransferTable
                  transfers={transfers.data.items}
                  direction={section as 'Received' | 'Sent'}
                  busy={busy}
                  onAction={transferAction}
                  onDownload={(t, entry) => download({ transferId: t.id, entryId: entry.id })}
                  loadEntries={(id, cursor) =>
                    api.request(`/v1/transfers/${id}/items?cursor=${encodeURIComponent(cursor)}`)
                  }
                />
              )}
              {(cursor || transfers.data?.nextCursor) && (
                <div className="file-pagination">
                  {cursor && (
                    <Button variant="outline" onClick={() => setCursor(undefined)}>
                      First page
                    </Button>
                  )}
                  {transfers.data?.nextCursor && (
                    <Button
                      variant="outline"
                      onClick={() => setCursor(transfers.data!.nextCursor!)}
                    >
                      Next page
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {section === 'Shared' && (
            <div>
              {shares.isPending ? (
                <ContentSkeleton label="Loading shared files" />
              ) : shares.isError && !shares.data?.items.length ? (
                <LoadError onRetry={() => void shares.refetch()} />
              ) : !shares.data?.items.length ? (
                <EmptyState
                  icon={<Users />}
                  title="No shared files"
                  description="Share a file or folder from its menu in My Drive."
                  actions={
                    <Button variant="outline" onClick={() => navigate('My Drive')}>
                      Browse My Drive
                    </Button>
                  }
                />
              ) : (
                shares.data.items.map((s) => (
                  <article className="simple-row" key={s.id}>
                    <FileGlyph item={s.item} />
                    <button onClick={() => open(s.item)}>
                      <strong>{s.item.name}</strong>
                      <small>
                        {s.permission.toLowerCase()} access ·{' '}
                        {s.ownerUserId === user.id ? 'Shared by you' : 'Shared with you'}
                      </small>
                    </button>
                    {s.ownerUserId === user.id && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          void act(() =>
                            api.request(`/v1/shares/${s.id}`, {
                              method: 'DELETE',
                              body: operation(),
                            }),
                          )
                        }
                      >
                        Remove access
                      </Button>
                    )}
                  </article>
                ))
              )}
            </div>
          )}
          {section === 'Backups' && <BackupsPage api={api} />}
          {section === 'Devices' && (
            <div className="panel">
              <h2>Connected devices</h2>
              <p className="muted">
                Use harbor0 on all your devices. Remove access whenever you need to.
              </p>
              {devices.isPending ? (
                <ContentSkeleton label="Loading devices" />
              ) : devices.isError && !devices.data?.items.length ? (
                <LoadError compact onRetry={() => void devices.refetch()} />
              ) : !devices.data?.items.length ? (
                <EmptyState
                  compact
                  icon={<Laptop />}
                  title="No connected devices"
                  description="Sign in to the harbor0 desktop app to connect a computer. Your devices will appear here."
                  actions={
                    <Button variant="outline" onClick={() => void devices.refetch()}>
                      Refresh devices
                    </Button>
                  }
                />
              ) : null}
              {devices.data?.items.map((d) => (
                <article className="simple-row" key={d.id}>
                  <span className="device-icon">
                    <Laptop size={24} />
                  </span>
                  <div>
                    <strong>{d.name}</strong>
                    <small>
                      {d.platform} ·{' '}
                      {d.revokedAt
                        ? 'Access removed'
                        : `Last active ${date(d.lastSeenAt ?? d.createdAt)}`}
                    </small>
                  </div>
                  {!d.revokedAt && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        void act(
                          () => api.request(`/v1/devices/${d.id}`, { method: 'DELETE' }),
                          'Device access removed.',
                        )
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </article>
              ))}
            </div>
          )}
          {section === 'Storage' && (
            <div className="storage-page">
              <div className="panel capacity">
                <span className="badge">FREE PLAN</span>
                <h2>
                  {bytes(usage.usedBytes)}
                  <span> / {bytes(usage.quotaBytes)}</span>
                </h2>
                <progress value={usage.usedBytes + usage.reservedBytes} max={usage.quotaBytes} />
                <div className="storage-breakdown">
                  <span>
                    <i />
                    {bytes(usage.usedBytes)} stored
                  </span>
                  <span>
                    <i />
                    {bytes(usage.reservedBytes)} uploading
                  </span>
                  <span>{bytes(usage.availableBytes)} available</span>
                </div>
                <p className="muted">
                  Storage includes current files, version history, backups, trash, and content
                  retained for sent transfers. Permanently deleting unused files frees up space.
                </p>
              </div>
              <div className="panel">
                <Cloud size={28} />
                <h2>Plan features</h2>
                <p className="muted">
                  Backup, sync, file sharing, and transfers are included in the free plan.
                </p>
                <p className="subtle-note">Additional storage purchases are not available yet.</p>
              </div>
            </div>
          )}
          {section === 'Notifications' && (
            <div className="panel">
              {notices.isPending ? (
                <ContentSkeleton label="Loading notifications" />
              ) : notices.isError && !notices.data?.items.length ? (
                <LoadError compact onRetry={() => void notices.refetch()} />
              ) : !notices.data?.items.length ? (
                <EmptyState
                  compact
                  icon={<Bell />}
                  title="No notifications"
                  description="Updates about your files and transfers will appear here."
                  actions={
                    <Button variant="outline" onClick={() => navigate('My Drive')}>
                      Back to My Drive
                    </Button>
                  }
                />
              ) : (
                notices.data.items.map((n) => (
                  <article className="simple-row" key={n.id}>
                    <Bell size={20} />
                    <div>
                      <strong>{n.type.replaceAll('_', ' ').toLowerCase()}</strong>
                      <small>{date(n.createdAt)}</small>
                    </div>
                    <Button
                      variant="ghost"
                      disabled={!!n.readAt}
                      onClick={() =>
                        void act(() =>
                          api.request(`/v1/notifications/${n.id}/read`, { method: 'POST' }),
                        )
                      }
                    >
                      {n.readAt ? 'Read' : 'Mark read'}
                    </Button>
                  </article>
                ))
              )}
            </div>
          )}
          {section === 'Settings' && (
            <div className="settings-layout">
              <AppearanceSettings />
              <div className="panel">
                <h2>Your account</h2>
                <dl>
                  <dt>Name</dt>
                  <dd>{user.displayName}</dd>
                  <dt>Username</dt>
                  <dd>@{user.username}</dd>
                  <dt>Email</dt>
                  <dd>
                    {user.email} <span className="badge success">Verified</span>
                  </dd>
                </dl>
                <p className="muted">
                  Manage active sessions in Devices. Use “Forgot password” on the sign-in screen to
                  reset your password.
                </p>
                <ProfileForm
                  user={user}
                  save={(values) =>
                    act(
                      () =>
                        api.request('/v1/users/me', {
                          method: 'PATCH',
                          body: { ...operation(), ...values },
                        }),
                      'Profile updated.',
                    )
                  }
                />
                <Button variant="outline" onClick={() => navigate('Devices')}>
                  <Settings size={16} />
                  Manage devices
                </Button>
              </div>
            </div>
          )}
        </main>
        <footer className="app-footer">
          <span>
            <span className="status-dot" />
            {online ? 'Online' : 'Offline'}
          </span>
        </footer>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void uploadFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: '' }}
        onChange={(e) => {
          void uploadFiles(e.target.files, true);
          e.target.value = '';
        }}
      />
      {progress.length > 0 && (
        <aside className="upload-tray" aria-live="polite">
          <div className="upload-title">
            <strong>Uploads</strong>
            <button
              aria-label="Dismiss completed uploads"
              onClick={() => setProgress((v) => v.filter((p) => p.phase !== 'done'))}
            >
              <X size={17} />
            </button>
          </div>
          {progress.map((p) => (
            <div className="upload-entry" key={p.name}>
              <div>
                <strong>{p.name}</strong>
                <span>
                  {p.phase === 'done' ? (
                    <Check size={16} />
                  ) : ['uploading', 'hashing'].includes(p.phase) ? (
                    <button
                      aria-label={`Pause ${p.name}`}
                      onClick={() => jobs.current.get(p.name)?.upload.pause()}
                    >
                      <Pause size={15} />
                    </button>
                  ) : (
                    <button
                      aria-label={`Resume ${p.name}`}
                      onClick={() => {
                        const job = jobs.current.get(p.name);
                        if (job) void startUpload(job.file, job.parent);
                      }}
                    >
                      <Play size={15} />
                    </button>
                  )}
                  {p.phase !== 'done' && (
                    <button
                      aria-label={`Cancel ${p.name}`}
                      onClick={() =>
                        void act(async () => {
                          await jobs.current.get(p.name)?.upload.cancel();
                          setProgress((old) => old.filter((v) => v.name !== p.name));
                        })
                      }
                    >
                      <X size={15} />
                    </button>
                  )}
                </span>
              </div>
              <progress value={p.loaded} max={p.size || 1} />
              <small>
                {p.phase === 'done'
                  ? 'Uploaded'
                  : p.phase === 'hashing'
                    ? 'Preparing file…'
                    : (p.error ?? `${bytes(p.loaded)} of ${bytes(p.size)}`)}
              </small>
            </div>
          ))}
        </aside>
      )}
      {modal?.mode === 'preview' && modal.item && (
        <FilePreview
          item={modal.item}
          load={loadPreview}
          onClose={() => setModal(null)}
          onDownload={() => void download({ driveItemId: modal.item!.id })}
        />
      )}
      <Dialog
        open={!!modal && modal.mode !== 'preview'}
        onOpenChange={(v) => {
          if (!v) setModal(null);
        }}
        title={
          modal?.mode === 'empty-trash'
            ? 'Empty Trash?'
            : modal?.mode === 'details'
              ? 'File details'
              : modal?.mode === 'folder'
                ? 'Create a folder'
                : modal?.mode === 'versions'
                  ? 'Version history'
                  : modal?.mode === 'send'
                    ? `Send ${modal.item?.name ?? 'selected files'}`
                    : modal?.mode === 'share'
                      ? `Share ${modal.item?.name}`
                      : modal?.mode === 'permanent'
                        ? 'Delete permanently?'
                        : modal?.mode === 'trash'
                          ? 'Move to trash?'
                          : modal?.mode === 'move'
                            ? 'Move to folder'
                            : 'Rename item'
        }
        description={
          modal?.mode === 'empty-trash'
            ? 'Permanently delete all items in Trash, including items on other pages and their version history? This cannot be undone. Content needed by sent transfers remains stored until those transfers end.'
            : modal?.mode === 'send'
              ? 'Send a copy to a person. They must sign in to receive it.'
              : modal?.mode === 'share'
                ? 'Give a registered person access to the original item.'
                : modal?.mode === 'permanent'
                  ? 'This removes your file and its version history. Content needed by your sent transfers remains stored and counted until those transfers are cancelled or expire.'
                  : modal?.mode === 'trash'
                    ? 'You can restore this item from Trash.'
                    : undefined
        }
      >
        {modal?.mode === 'details' ? (
          <FileDetails
            item={modal.item!}
            onPreview={() => setModal({ mode: 'preview', item: modal.item })}
            onDownload={() => void download({ driveItemId: modal.item!.id })}
          />
        ) : modal?.mode === 'versions' ? (
          <div className="version-list">
            {versions.isPending ? (
              <ContentSkeleton label="Loading version history" />
            ) : versions.isError && !versions.data?.items.length ? (
              <LoadError compact onRetry={() => void versions.refetch()} />
            ) : !versions.data?.items.length ? (
              <EmptyState
                compact
                icon={<Clock />}
                title="No versions to show"
                description="Saved versions of this file will appear here when they’re available."
              />
            ) : null}
            {versions.data?.items.map((v) => (
              <div className="simple-row" key={v.id}>
                <div>
                  <strong>Version {v.versionNumber}</strong>
                  <small>
                    {date(v.createdAt)} · {bytes(v.sizeBytes)}
                  </small>
                </div>
                <Button
                  variant="ghost"
                  onClick={() => void download({ driveItemId: modal.item!.id, versionId: v.id })}
                >
                  Download
                </Button>
                {v.id !== modal.item?.currentVersionId && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      void act(async () => {
                        await api.request(
                          `/v1/drive/items/${modal.item!.id}/versions/${v.id}/restore`,
                          {
                            method: 'POST',
                            body: { ...operation(), baseRevision: modal.item!.revision },
                          },
                        );
                        setModal(null);
                      })
                    }
                  >
                    Restore
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <form onSubmit={submit}>
            {['folder', 'rename'].includes(modal?.mode ?? '') && (
              <label>
                Name
                <Input
                  autoFocus
                  name="name"
                  defaultValue={modal?.item?.name ?? ''}
                  required
                  maxLength={240}
                />
              </label>
            )}
            {modal?.mode === 'move' && <FolderPicker />}
            {['send', 'share'].includes(modal?.mode ?? '') && (
              <label>
                To
                <Input
                  autoFocus
                  name="recipient"
                  aria-label="To"
                  required
                  placeholder="@username or email address"
                />
                {modal?.mode === 'send' && (
                  <small>
                    New recipients can verify their email and find the transfer after signup.
                  </small>
                )}
              </label>
            )}
            {modal?.mode === 'share' && (
              <label>
                Permission
                <select name="permission">
                  <option value="VIEWER">Viewer — browse and download</option>
                  <option value="EDITOR">Editor — also rename, move, and trash</option>
                </select>
              </label>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <Button type="button" variant="outline" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                type="submit"
                variant={
                  ['permanent', 'empty-trash'].includes(modal?.mode ?? '')
                    ? 'destructive'
                    : 'default'
                }
              >
                {busy
                  ? 'Saving…'
                  : modal?.mode === 'empty-trash'
                    ? 'Empty Trash'
                    : modal?.mode === 'send'
                      ? 'Send files'
                      : modal?.mode === 'share'
                        ? 'Share access'
                        : modal?.mode === 'permanent'
                          ? 'Delete permanently'
                          : modal?.mode === 'trash'
                            ? 'Move to trash'
                            : 'Save'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}
function FileDetails({
  item,
  onDownload,
  onPreview,
}: {
  item: DriveItem;
  onDownload: () => void;
  onPreview: () => void;
}) {
  return (
    <div>
      <p>
        <strong>{item.name}</strong>
      </p>
      <dl>
        <dt>Size</dt>
        <dd>{bytes(item.sizeBytes)}</dd>
        <dt>Created</dt>
        <dd>{date(item.createdAt)}</dd>
        <dt>Modified</dt>
        <dd>{date(item.updatedAt)}</dd>
        <dt>Revision</dt>
        <dd>{item.revision}</dd>
      </dl>
      {item.type === 'FILE' && (
        <Button variant="outline" onClick={onPreview}>
          Preview
        </Button>
      )}
      {item.type === 'FILE' && (
        <Button onClick={onDownload}>
          <ArrowDownToLine size={16} />
          Download
        </Button>
      )}
    </div>
  );
}
function ProfileForm({
  user,
  save,
}: {
  user: { username: string; displayName: string };
  save: (values: Record<string, string>) => Promise<boolean>;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>);
      }}
    >
      <label>
        Display name
        <Input name="displayName" defaultValue={user.displayName} required maxLength={100} />
      </label>
      <label>
        Username
        <Input name="username" defaultValue={user.username} required maxLength={32} />
        <small>Usernames can be changed once every 30 days.</small>
      </label>
      <Button type="submit" variant="outline">
        Save profile
      </Button>
    </form>
  );
}
function FolderPicker() {
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const id = trail.at(-1)?.id ?? null;
  const list = useQuery({ queryKey: ['folder-picker', id], queryFn: () => api.list(id) });
  return (
    <div className="folder-picker">
      <Input type="hidden" name="parentId" value={id ?? ''} />
      <p>
        Destination: <strong>{trail.map((t) => t.name).join(' / ') || 'My Drive'}</strong>
      </p>
      {id && (
        <Button type="button" variant="ghost" onClick={() => setTrail(trail.slice(0, -1))}>
          ↑ Parent folder
        </Button>
      )}
      {list.isPending ? (
        <ContentSkeleton label="Loading folders" />
      ) : list.isError ? (
        <LoadError compact onRetry={() => void list.refetch()} />
      ) : !list.data?.items.some((item) => item.type === 'FOLDER') ? (
        <EmptyState
          compact
          icon={<Folder />}
          title="No subfolders here"
          description="You can use this folder as the destination, or choose a parent folder."
        />
      ) : null}
      {list.data?.items
        .filter((i) => i.type === 'FOLDER')
        .map((i) => (
          <button
            type="button"
            key={i.id}
            onClick={() => setTrail([...trail, { id: i.id, name: i.name }])}
          >
            <Folder size={17} />
            {i.name}
            <ChevronRight size={15} />
          </button>
        ))}
    </div>
  );
}
export default function AppShell({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <Suspense fallback={<WorkspaceSkeleton />}>
        <Workspace />
      </Suspense>
      {children}
    </QueryClientProvider>
  );
}
