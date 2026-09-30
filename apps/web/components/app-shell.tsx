'use client';
import { useOptimisticRemoval } from '../lib/use-optimistic-removal';
import { browserSession, clearBrowserCaches } from '../lib/browser-cache';
import { ActivityNotifications, useActivityFeed } from './activity-notifications';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  authRoutes,
  workspaceRoutes,
  type AuthMode,
  type WorkspaceSection,
  loginDestination,
  driveHref,
  sharedHref,
} from '../lib/routes';
import { loadFolderTrail } from '../lib/folder-navigation';
import { useDebouncedValue } from '../lib/use-debounced-value';
import { downloadFolderZip } from '../lib/folder-download';
import { ZipDownloadStatusPanel, type ZipDownloadStatus } from './zip-download-status';
import { BrandLogo } from '../components/brand-logo';
import { FilePreview } from '../components/lazy-file-preview';
import { previewKind, type PreviewLoader } from '../lib/file-preview';
import { fetchTextPreview } from '../../../packages/api-client/src/preview';
import { Input, InputGroup } from '../components/ui/input';
import { Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowDownToLine,
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
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  Laptop,
  Clock,
  Pause,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
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
import { SharedTabs, type SharedTab } from './shared-tabs';
import { TransferTable, type TransferView } from './transfer-table';
import { BackupsPage } from './backups-page';
import { DriveWorkspace } from './lazy-drive-workspace';
import { AccountMenu, StorageIndicator } from './drive-account';
import { Button } from '../components/ui/button';
import { Dialog, DialogActions } from '../components/ui/dialog';
import { Alert } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { Field } from '../components/ui/field';
import { ActionsMenu, MenuItem, MenuSeparator } from '../components/ui/menu';
import { Progress } from '../components/ui/progress';
import { Segmented } from '../components/ui/segmented';
import { Select } from '../components/ui/select';
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
const platforms: Record<string, string> = {
  WEB: 'Web browser',
  MACOS: 'Mac',
  WINDOWS: 'Windows PC',
  LINUX: 'Linux computer',
  IOS: 'iPhone or iPad',
  ANDROID: 'Android device',
};
const notificationTitles: Record<string, string> = {
  TRANSFER_RECEIVED: 'Someone sent you files',
  TRANSFER_ACCEPTED: 'Your transfer was accepted',
  TRANSFER_DECLINED: 'Your transfer was declined',
  TRANSFER_CANCELLED: 'A transfer was cancelled',
  TRANSFER_EXPIRED: 'A transfer expired',
  SHARE_RECEIVED: 'Someone shared an item with you',
};
const sentence = (value: string) => {
  const text = value.replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
};
// Select the name without its extension so typing replaces only the name.
const selectBaseName = (input: HTMLInputElement) => {
  const dot = input.value.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
};
type Confirmation = {
  title: string;
  description: string;
  label: string;
  done?: string;
  run: () => Promise<unknown>;
};
const navigation = [
  { name: 'My Drive', icon: HardDrive },
  { name: 'Shared', icon: Users },
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
      className="file-entry-icon"
      data-kind={
        item.type === 'FOLDER'
          ? 'folder'
          : item.mimeType?.startsWith('image/')
            ? 'image'
            : 'document'
      }
    >
      <Icon aria-hidden="true" />
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
  const [notice, setNotice] = useState('');
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
    setNotice('');
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
        setNotice(
          mode === 'signup'
            ? `We sent a verification code to ${email}.`
            : mode === 'forgot'
              ? `If ${email} has an account, a reset code is on its way.`
              : mode === 'confirm'
                ? 'Email verified. Sign in to continue.'
                : 'Password updated. Sign in with your new password.',
        );
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
                  : mode === 'forgot'
                    ? 'Enter your account email and we’ll send you a reset code.'
                    : 'Enter the reset code from your email and choose a new password.'}
          </p>
          {notice && <Alert tone="success">{notice}</Alert>}
          <form className="form" onSubmit={submit}>
            <Field label="Email">
              <Input
                size="lg"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            {mode === 'signup' && (
              <>
                <Field label="Display name">
                  <Input
                    size="lg"
                    name="displayName"
                    autoComplete="name"
                    required
                    maxLength={100}
                  />
                </Field>
                <Field label="Username" hint="People can send files directly to your @username.">
                  <InputGroup prefix="@">
                    <Input
                      size="lg"
                      name="username"
                      aria-label="Username"
                      autoComplete="username"
                      required
                      pattern="[a-z0-9_.]{3,32}"
                    />
                  </InputGroup>
                </Field>
              </>
            )}
            {['login', 'signup', 'reset'].includes(mode) && (
              <Field
                label="Password"
                hint={
                  mode !== 'login' &&
                  'At least 12 characters, including upper/lowercase, a number, and a symbol.'
                }
              >
                <Input
                  size="lg"
                  name="password"
                  aria-label="Password"
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={mode === 'login' ? 1 : 12}
                />
              </Field>
            )}
            {['confirm', 'reset'].includes(mode) && (
              <Field label="Verification code">
                <Input size="lg" name="code" autoComplete="one-time-code" required />
              </Field>
            )}
            {error && <Alert tone="error">{error}</Alert>}
            <Button disabled={busy} type="submit" size="lg" block>
              {busy
                ? 'Please wait…'
                : {
                    login: 'Sign in',
                    signup: 'Create your account',
                    confirm: 'Verify email',
                    forgot: 'Send reset code',
                    reset: 'Reset password',
                  }[mode]}
            </Button>
          </form>
          <div className="auth-links">
            {mode === 'login' ? (
              <>
                <Link href={authHref('signup')}>New here? Create an account</Link>
                <Link href={authHref('forgot')}>Forgot password?</Link>
              </>
            ) : (
              <Link href={authHref('login')}>
                {mode === 'signup' ? 'Already have an account? Sign in' : 'Back to sign in'}
              </Link>
            )}
            {mode === 'confirm' && (
              <Button
                variant="link"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setNotice('');
                  if (!email) return setError('Enter your email to get a new code.');
                  void api
                    .request('/v1/auth/resend', { method: 'POST', body: { email } })
                    .then(() => setNotice(`A new code is on its way to ${email}.`))
                    .catch((e) => setError(e.message));
                }}
              >
                Resend code
              </Button>
            )}
            {mode === 'reset' && <Link href={authHref('forgot')}>Send a new code</Link>}
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
    ) ?? (['/received', '/sent'].includes(pathname) ? 'Shared' : 'My Drive');
  const sharedTab: SharedTab =
    pathname === '/sent' || searchParams.get('tab') === 'sent' ? 'Sent' : 'Received';
  const [transferPage, setTransferPage] = useState<{ tab: SharedTab; cursor?: string }>({
    tab: 'Received',
  });
  const transferCursor = transferPage.tab === sharedTab ? transferPage.cursor : undefined;
  const setTransferCursor = (cursor?: string) => setTransferPage({ tab: sharedTab, cursor });
  useEffect(() => {
    if (pathname === '/received' || pathname === '/sent')
      router.replace(sharedHref(pathname === '/sent' ? 'Sent' : 'Received'));
  }, [pathname, router]);
  const authMode = (Object.keys(authRoutes) as AuthMode[]).find(
    (mode) => authRoutes[mode] === pathname,
  );
  const next = loginDestination(searchParams.get('next'));
  const parentId = pathname === '/drive' ? searchParams.get('folder') || null : null;
  const [query, setQuery] = useState('');
  const [driveReadOnly, setDriveReadOnly] = useState(true);
  const [grid, setGrid] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [modal, setModal] = useState<{
    mode: string;
    item?: DriveItem;
    items?: DriveItem[];
  } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState<ZipDownloadStatus | null>(null);
  const zipJob = useRef<AbortController | null>(null);
  useEffect(() => () => zipJob.current?.abort(), []);
  const [cursor, setCursor] = useState<string>();
  const [progress, setProgress] = useState<(UploadProgress & { key: string })[]>([]);
  const [online, setOnline] = useState(true);
  const jobs = useRef(
    new Map<string, { upload: BrowserUpload; file: File; parent: string | null }>(),
  );
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me() });
  const user = me.data?.user;
  const activity = useActivityFeed(user?.id);
  useEffect(() => {
    if (!user) clearBrowserCaches();
  }, [user?.id]);
  const needsLogin = me.error instanceof ApiError && [401, 403].includes(me.error.status);
  useAccountAppearance(needsLogin ? undefined : user?.id, api.request);
  useEffect(() => {
    if (user && (pathname === '/' || authMode)) router.replace(authMode ? next : '/drive');
    else if (needsLogin && !authMode) {
      const destination =
        pathname === '/drive'
          ? driveHref(parentId)
          : section === 'Shared'
            ? sharedHref(sharedTab)
            : pathname === '/'
              ? '/drive'
              : pathname;
      router.replace(`/login?next=${encodeURIComponent(destination)}`);
    }
  }, [user, needsLogin, pathname, parentId, authMode, next, router, section, sharedTab]);
  useEffect(() => {
    setQuery('');
    setSelected([]);
    setCursor(undefined);
    setError('');
    setModal(null);
    setTransferPage({ tab: sharedTab });
  }, [pathname, parentId, sharedTab]);
  const folderTrail = useQuery({
    queryKey: ['folder-trail', parentId],
    enabled: !!user && !!parentId,
    queryFn: ({ signal }) => loadFolderTrail(api, parentId!, signal),
  });
  const trail = parentId ? (folderTrail.data ?? [{ id: parentId, name: 'Folder' }]) : [];
  const fileSection = ['My Drive', 'Trash'].includes(section) || !!query;
  // Search results replace the page they were started from until the search is cleared.
  const searching = !!query && !['My Drive', 'Trash'].includes(section);
  const listingQuery = useDebouncedValue(query);
  const listing = useQuery<{ items: DriveItem[]; nextCursor: string | null }>({
    queryKey: ['files', section, parentId, listingQuery, cursor],
    enabled: !!user && (section === 'Trash' || (searching && !!listingQuery)),
    queryFn: () => {
      if (section === 'My Drive' && !listingQuery) return api.list(parentId, cursor);
      const params = new URLSearchParams({
        ...(listingQuery ? { q: listingQuery } : {}),
        ...(section === 'Trash' ? { trash: 'true' } : {}),
        ...(cursor ? { cursor } : {}),
      });
      return api.request('/v1/search?' + params);
    },
  });
  const transfers = useQuery<{ items: TransferView[]; nextCursor: string | null }>({
    queryKey: ['transfers', sharedTab, transferCursor],
    enabled: !!user && section === 'Shared',
    queryFn: () =>
      api.request(
        `/v1/transfers/${sharedTab.toLowerCase()}${transferCursor ? '?cursor=' + encodeURIComponent(transferCursor) : ''}`,
      ),
    refetchInterval: 15000,
  });
  const shares = useQuery<{ items: any[] }>({
    queryKey: ['shares', sharedTab],
    enabled: !!user && section === 'Shared',
    queryFn: () => api.request(`/v1/shares/${sharedTab.toLowerCase()}`),
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
  const trashChanges = useOptimisticRemoval(
    listing.data?.items ?? [],
    user?.id ?? 'anonymous',
    setError,
    async () => {
      await refresh();
    },
  );
  const files = trashChanges.items;
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
        if (section !== 'My Drive' || !driveReadOnly) input.current?.click();
      }
      // My Drive handles its own selection shortcuts.
      if (section === 'My Drive') return;
      if (
        (e.target as HTMLElement).closest?.(
          'input, textarea, select, [contenteditable], [role="dialog"], [role="menu"]',
        )
      )
        return;
      if (e.key === 'Escape') setSelected([]);
      const chosen = files.filter((f) => selected.includes(f.id));
      if (e.key === 'F2' && chosen.length === 1 && section !== 'Trash')
        setModal({ mode: 'rename', item: chosen[0] });
      if (e.key === 'Delete' && chosen.length) {
        if (section === 'Trash') setModal({ mode: 'permanent', items: chosen });
        else if (chosen.length === 1) setModal({ mode: 'trash', item: chosen[0] });
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [selected, files, section, driveReadOnly]);
  const refresh = async () => {
    const browser = browserSession(api.request, user?.id ?? 'anonymous');
    browser.data.clear();
    browser.views.clear();
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
    setTransferPage({ tab: 'Received' });
    setQuery('');
    setSelected([]);
    setCursor(undefined);
    setError('');
    setModal(null);
    setConfirmation(null);
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
    // Files with the same name can upload to different folders at once.
    const key = `${target ?? 'root'}/${file.name}`;
    const record = { upload, file, parent: target };
    jobs.current.set(key, record);
    const update = (p: UploadProgress) =>
      setProgress((old) => {
        const entry = { ...p, key };
        return old.some((v) => v.key === key)
          ? old.map((v) => (v.key === key ? entry : v))
          : [...old, entry];
      });
    try {
      await upload.run(file, target, update);
      jobs.current.delete(key);
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
    const targets = modal?.items ?? (item ? [item] : []);
    if (modal?.mode === 'permanent' && targets.length) {
      setModal(null);
      setSelected([]);
      await Promise.all(
        targets.map((target) =>
          trashChanges.remove([target], () =>
            api.request(`/v1/drive/items/${target.id}/permanent`, {
              method: 'DELETE',
              body: { ...operation(), baseRevision: target.revision },
            }),
          ),
        ),
      );
      return;
    }
    const mode = modal?.mode;
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
      mode === 'send'
        ? 'Sent. Your recipient will see it after signing in.'
        : mode === 'share'
          ? 'Access shared.'
          : mode === 'folder'
            ? 'Folder created.'
            : mode === 'rename'
              ? 'Renamed.'
              : mode === 'move'
                ? 'Moved.'
                : mode === 'trash'
                  ? 'Moved to trash.'
                  : mode === 'empty-trash'
                    ? 'Trash emptied.'
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
  function restore(targets: DriveItem[]) {
    setSelected([]);
    return Promise.all(
      targets.map((item) =>
        trashChanges.remove([item], () =>
          api.request(`/v1/drive/items/${item.id}/restore`, {
            method: 'POST',
            body: { ...operation(), baseRevision: item.revision },
          }),
        ),
      ),
    );
  }
  async function transferAction(t: Transfer, action: string) {
    // Declining or cancelling cannot be undone, so ask first.
    if (action === 'decline' || action === 'cancel') {
      setConfirmation({
        title: action === 'decline' ? 'Decline this transfer?' : 'Cancel this transfer?',
        description:
          action === 'decline'
            ? 'You won’t be able to download these files unless they are sent again.'
            : 'The recipient will no longer be able to accept or download these files.',
        label: action === 'decline' ? 'Decline transfer' : 'Cancel transfer',
        done: action === 'decline' ? 'Transfer declined.' : 'Transfer cancelled.',
        run: () =>
          api.request(`/v1/transfers/${t.id}/${action}`, { method: 'POST', body: operation() }),
      });
      return;
    }
    await act(
      () =>
        api.request(`/v1/transfers/${t.id}/${action}`, {
          method: 'POST',
          body: { ...operation(), ...(action === 'save' ? { targetParentId: null } : {}) },
        }),
      action === 'save'
        ? 'Saving to My Drive. Large folders finish in the background.'
        : 'Transfer accepted. You can now download or save the files.',
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
          clearBrowserCaches();
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
          disabled={section === 'My Drive' && driveReadOnly}
          className="upload-button"
          aria-label="Upload files"
        >
          <Plus />
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
              <Icon aria-hidden="true" />
              <span>{name}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <StorageIndicator storage={usage} onManage={() => navigate('Storage')} />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <InputGroup className="search-box" icon={<Search aria-hidden="true" />}>
            <Input
              ref={search}
              type="search"
              aria-label="Search files"
              placeholder={section === 'Trash' ? 'Search Trash' : 'Search your files'}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(undefined);
                setSelected([]);
              }}
            />
            {!query && <kbd>{mac ? '⌘ K' : 'Ctrl K'}</kbd>}
          </InputGroup>
          <div className="topbar-right">
            <ThemeToggle />
            <ActivityNotifications
              feed={activity}
              onAllNotifications={() => navigate('Notifications')}
            />
            <AccountMenu
              user={user}
              storage={usage}
              onNavigate={navigate}
              onSignOut={() =>
                void act(async () => {
                  await api.request('/v1/auth/logout', { method: 'POST', body: {} });
                  cache.clear();
                  clearBrowserCaches();
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
            // Files dropped outside a writable folder are ignored instead of landing in the root.
            e.preventDefault();
            if (section === 'My Drive' && !driveReadOnly) void uploadFiles(e.dataTransfer.files);
          }}
        >
          <div className="page-alerts">
            {!online && (
              <Alert tone="warning">
                You’re offline. Changes will sync when your connection returns.
              </Alert>
            )}
            {pageError && (
              <Alert
                tone="error"
                className="banner"
                dismissLabel="Dismiss error"
                onDismiss={() => setError('')}
              >
                {pageError}
              </Alert>
            )}
          </div>
          {zipProgress && (
            <ZipDownloadStatusPanel
              progress={zipProgress}
              onCancel={() => zipJob.current?.abort()}
            />
          )}
          {section !== 'My Drive' && (
            <div className={`page-heading ${section === 'Shared' ? 'shared-heading' : ''}`}>
              <div>
                <h1>{searching ? 'Search results' : section}</h1>
                {query && (
                  <p className="muted">
                    {section === 'Trash' ? 'Items in Trash' : 'Files'} matching “{query}”
                  </p>
                )}
              </div>
              {query && (
                <div className="heading-actions">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQuery('');
                      setCursor(undefined);
                      setSelected([]);
                    }}
                  >
                    <X />
                    Clear search
                  </Button>
                </div>
              )}
            </div>
          )}
          {section === 'My Drive' && (
            <DriveWorkspace
              onActivity={activity.publish}
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
                    <Button variant="link" onClick={() => void folderTrail.refetch()}>
                      Retry folder path
                    </Button>
                  )}
                </>
              }
              onOpen={open}
              onSyncRemoved={() => navigate('My Drive')}
              onRoot={() => navigate('My Drive')}
              onReadOnlyChange={setDriveReadOnly}
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
                  <Badge className="count">
                    {listing.isPending
                      ? 'Loading…'
                      : listing.isError && !files.length
                        ? 'Unavailable'
                        : `${files.length} ${files.length === 1 ? 'item' : 'items'}${cursor || listing.data?.nextCursor ? ' on this page' : ''}`}
                  </Badge>
                </div>
                <div className="file-toolbar-actions">
                  {section === 'Trash' && (
                    <Button
                      variant="outline"
                      disabled={
                        busy ||
                        listing.isPending ||
                        listing.isError ||
                        (!files.length && !cursor && !listing.data?.nextCursor && !query)
                      }
                      onClick={() => setModal({ mode: 'empty-trash' })}
                    >
                      <Trash2 />
                      Empty Trash
                    </Button>
                  )}
                  <Segmented
                    label="View"
                    className="view-switch"
                    value={grid ? 'grid' : 'list'}
                    onValueChange={(view) => setGrid(view === 'grid')}
                    options={[
                      { value: 'list', label: 'List view', icon: <List />, iconOnly: true },
                      { value: 'grid', label: 'Grid view', icon: <LayoutGrid />, iconOnly: true },
                    ]}
                  />
                </div>
              </div>
              {selected.length > 0 && (
                <div className="selection-bar">
                  <span aria-live="polite">{selected.length} selected</span>
                  {section === 'Trash' ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => void restore(files.filter((f) => selected.includes(f.id)))}
                      >
                        <RotateCcw />
                        Restore
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setModal({
                            mode: 'permanent',
                            items: files.filter((f) => selected.includes(f.id)),
                          })
                        }
                      >
                        <Trash2 />
                        Delete permanently
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() =>
                        setModal({ mode: 'send', item: files.find((f) => f.id === selected[0]) })
                      }
                    >
                      <Send />
                      Send
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
                    Clear
                  </Button>
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
                    <ActionsMenu label={`Actions for ${item.name}`}>
                      {section === 'Trash' ? (
                        <>
                          <MenuItem onClick={() => void restore([item])}>Restore</MenuItem>
                          <MenuItem
                            tone="danger"
                            onClick={() => setModal({ mode: 'permanent', item })}
                          >
                            Delete permanently
                          </MenuItem>
                        </>
                      ) : (
                        <>
                          {item.type === 'FILE' && (
                            <MenuItem onClick={() => setModal({ mode: 'preview', item })}>
                              Preview
                            </MenuItem>
                          )}
                          <MenuItem
                            disabled={busy || !!zipProgress}
                            onClick={() =>
                              void (item.type === 'FOLDER'
                                ? downloadFolder(item)
                                : download({ driveItemId: item.id }))
                            }
                          >
                            {item.type === 'FOLDER' ? 'Download as ZIP' : 'Download'}
                          </MenuItem>
                          <MenuItem onClick={() => setModal({ mode: 'send', item })}>
                            Send to someone
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem onClick={() => setModal({ mode: 'details', item })}>
                            File details
                          </MenuItem>
                          <MenuItem onClick={() => setModal({ mode: 'rename', item })}>
                            Rename
                          </MenuItem>
                          <MenuItem onClick={() => setModal({ mode: 'move', item })}>Move</MenuItem>
                          <MenuItem onClick={() => void toggleFavorite(item)}>
                            {item.favorite ? 'Remove favorite' : 'Add to favorites'}
                          </MenuItem>
                          {item.type === 'FILE' && (
                            <MenuItem onClick={() => setModal({ mode: 'versions', item })}>
                              Version history
                            </MenuItem>
                          )}
                          <MenuSeparator />
                          <MenuItem tone="danger" onClick={() => setModal({ mode: 'trash', item })}>
                            Move to trash
                          </MenuItem>
                        </>
                      )}
                    </ActionsMenu>
                  )}
                />
              )}

              {(cursor || listing.data?.nextCursor) && (
                <div className="file-pagination">
                  {cursor && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSelected([]);
                        setCursor(undefined);
                      }}
                    >
                      First page
                    </Button>
                  )}
                  {listing.data?.nextCursor && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSelected([]);
                        setCursor(listing.data!.nextCursor!);
                      }}
                    >
                      Next page
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
          {section === 'Shared' && !searching && (
            <SharedTabs
              tab={sharedTab}
              onChange={(tab) => {
                setTransferPage({ tab });
                router.push(sharedHref(tab), { scroll: false });
              }}
            >
              <div className="transfer-list">
                {transfers.isPending ? (
                  <ContentSkeleton label="Loading transfers" />
                ) : transfers.isError && !transfers.data?.items.length ? (
                  <LoadError onRetry={() => void transfers.refetch()} />
                ) : !transfers.data?.items.length ? (
                  <EmptyState
                    icon={sharedTab === 'Received' ? <Inbox /> : <Send />}
                    title={sharedTab === 'Received' ? 'No received files' : 'No sent files'}
                    description={
                      sharedTab === 'Received'
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
                    direction={sharedTab}
                    busy={busy}
                    onAction={transferAction}
                    onDownload={(t, entry) => download({ transferId: t.id, entryId: entry.id })}
                    loadEntries={(id, cursor) =>
                      api.request(`/v1/transfers/${id}/items?cursor=${encodeURIComponent(cursor)}`)
                    }
                  />
                )}
                {(transferCursor || transfers.data?.nextCursor) && (
                  <div className="file-pagination">
                    {transferCursor && (
                      <Button variant="outline" onClick={() => setTransferCursor(undefined)}>
                        First page
                      </Button>
                    )}
                    {transfers.data?.nextCursor && (
                      <Button
                        variant="outline"
                        onClick={() => setTransferCursor(transfers.data!.nextCursor!)}
                      >
                        Next page
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {(shares.isPending || shares.isError || !!shares.data?.items.length) && (
                <Card title="Shared access">
                  {shares.isPending ? (
                    <ContentSkeleton label="Loading shared files" />
                  ) : shares.isError && !shares.data?.items.length ? (
                    <LoadError onRetry={() => void shares.refetch()} />
                  ) : (
                    shares.data?.items.map((s) => (
                      <article className="list-row simple-row" key={s.id}>
                        <FileGlyph item={s.item} />
                        <button className="list-row-text" onClick={() => open(s.item)}>
                          <strong>{s.item.name}</strong>
                          <small>
                            {s.permission === 'EDITOR' ? 'Can edit' : 'Can view'} ·{' '}
                            {s.ownerUserId === user.id ? 'Shared by you' : 'Shared with you'}
                          </small>
                        </button>
                        {s.ownerUserId === user.id && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setConfirmation({
                                title: `Remove access to ${s.item.name}?`,
                                description:
                                  'The person you shared this with will no longer be able to open it.',
                                label: 'Remove access',
                                done: 'Access removed.',
                                run: () =>
                                  api.request(`/v1/shares/${s.id}`, {
                                    method: 'DELETE',
                                    body: operation(),
                                  }),
                              })
                            }
                          >
                            Remove access
                          </Button>
                        )}
                      </article>
                    ))
                  )}
                </Card>
              )}
            </SharedTabs>
          )}
          {section === 'Backups' && !searching && <BackupsPage api={api} />}
          {section === 'Devices' && !searching && (
            <Card
              className="panel"
              title="Connected devices"
              description="Use harbor0 on all your devices. Remove access whenever you need to."
            >
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
                <article className="list-row simple-row" key={d.id}>
                  <span className="icon-tile">
                    <Laptop aria-hidden="true" />
                  </span>
                  <div className="list-row-text">
                    <strong>{d.name}</strong>
                    <small>
                      {platforms[d.platform] ?? d.platform} ·{' '}
                      {d.revokedAt
                        ? 'Access removed'
                        : `Last active ${date(d.lastSeenAt ?? d.createdAt)}`}
                    </small>
                  </div>
                  {!d.revokedAt && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setConfirmation({
                          title: `Revoke access for ${d.name}?`,
                          description:
                            'This device will be signed out and will stop syncing. If it is the browser you are using now, you will need to sign in again.',
                          label: 'Revoke access',
                          done: 'Device access removed.',
                          run: () => api.request(`/v1/devices/${d.id}`, { method: 'DELETE' }),
                        })
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </article>
              ))}
            </Card>
          )}
          {section === 'Storage' && !searching && (
            <div className="storage-page">
              <Card className="panel capacity">
                <Badge tone="accent">Free plan</Badge>
                <p className="storage-amount">
                  <strong>{bytes(usage.usedBytes)}</strong>
                  <span>of {bytes(usage.quotaBytes)} used</span>
                </p>
                <Progress
                  value={usage.usedBytes + usage.reservedBytes}
                  max={usage.quotaBytes}
                  aria-label="Storage used"
                />
                <div className="storage-breakdown">
                  <span>{bytes(usage.usedBytes)} stored</span>
                  <span>{bytes(usage.reservedBytes)} uploading</span>
                  <span>{bytes(usage.availableBytes)} available</span>
                </div>
                <p className="muted">
                  Storage includes current files, version history, backups, trash, and content
                  retained for sent transfers. Permanently deleting unused files frees up space.
                </p>
              </Card>
              <Card
                className="panel"
                title="Plan features"
                description="Backup, sync, file sharing, and transfers are included in the free plan."
              >
                <Alert role="none">Additional storage purchases are not available yet.</Alert>
              </Card>
            </div>
          )}
          {section === 'Notifications' && !searching && (
            <Card className="panel">
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
                  <article className="list-row simple-row" key={n.id}>
                    <Bell aria-hidden="true" />
                    <div className="list-row-text">
                      <strong>{notificationTitles[n.type] ?? sentence(n.type)}</strong>
                      <small>{date(n.createdAt)}</small>
                    </div>
                    <Button
                      size="sm"
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
            </Card>
          )}
          {section === 'Settings' && !searching && (
            <div className="settings-layout">
              <AppearanceSettings />
              <Card
                className="panel"
                title="Your account"
                description="Manage active sessions in Devices. Use “Forgot password” on the sign-in screen to reset your password."
              >
                <dl className="details">
                  <dt>Email</dt>
                  <dd className="account-email">
                    {user.email} <Badge tone="success">Verified</Badge>
                  </dd>
                </dl>
                <ProfileForm
                  key={`${user.displayName}:${user.username}`}
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
                  <Settings />
                  Manage devices
                </Button>
              </Card>
            </div>
          )}
        </main>
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
        <aside className="floating-card upload-tray" aria-live="polite">
          <div className="upload-title">
            <strong>Uploads</strong>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss completed uploads"
              title="Dismiss completed uploads"
              disabled={!progress.some((p) => p.phase === 'done')}
              onClick={() => setProgress((v) => v.filter((p) => p.phase !== 'done'))}
            >
              <X />
            </Button>
          </div>
          {progress.map((p) => (
            <div className="upload-entry" key={p.key}>
              <div>
                <strong title={p.name}>{p.name}</strong>
                <span>
                  {p.phase === 'done' ? (
                    <Check size={16} className="upload-done" />
                  ) : ['uploading', 'hashing'].includes(p.phase) ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Pause ${p.name}`}
                      onClick={() => jobs.current.get(p.key)?.upload.pause()}
                    >
                      <Pause />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${p.phase === 'failed' ? 'Retry' : 'Resume'} ${p.name}`}
                      title={p.phase === 'failed' ? 'Retry' : 'Resume'}
                      onClick={() => {
                        const job = jobs.current.get(p.key);
                        if (job) void startUpload(job.file, job.parent);
                      }}
                    >
                      <Play />
                    </Button>
                  )}
                  {p.phase !== 'done' && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Cancel ${p.name}`}
                      onClick={() =>
                        void act(async () => {
                          await jobs.current.get(p.key)?.upload.cancel();
                          jobs.current.delete(p.key);
                          setProgress((old) => old.filter((v) => v.key !== p.key));
                        })
                      }
                    >
                      <X />
                    </Button>
                  )}
                </span>
              </div>
              <Progress value={p.loaded} max={p.size || 1} />
              <small>
                {p.phase === 'done'
                  ? 'Uploaded'
                  : p.phase === 'hashing'
                    ? 'Preparing file…'
                    : p.phase === 'paused'
                      ? `Paused · ${bytes(p.loaded)} of ${bytes(p.size)}`
                      : (p.error ?? `${bytes(p.loaded)} of ${bytes(p.size)}`)}
              </small>
            </div>
          ))}
        </aside>
      )}
      {modal?.mode === 'preview' && modal.item && (
        <FilePreview
          cacheScope={user?.id ?? 'anonymous'}
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
                        ? (modal.items?.length ?? 1) > 1
                          ? `Delete ${modal.items!.length} items permanently?`
                          : `Delete ${(modal.items?.[0] ?? modal.item)?.name ?? 'this item'} permanently?`
                        : modal?.mode === 'trash'
                          ? `Move ${modal.item?.name ?? 'this item'} to trash?`
                          : modal?.mode === 'move'
                            ? 'Move to folder'
                            : `Rename ${modal?.item?.name ?? 'item'}`
        }
        description={
          modal?.mode === 'empty-trash'
            ? 'Permanently delete all items in Trash, including items on other pages and their version history? This cannot be undone. Content needed by sent transfers remains stored until those transfers end.'
            : modal?.mode === 'send'
              ? 'Send a copy to a person. They must sign in to receive it.'
              : modal?.mode === 'share'
                ? 'Give a registered person access to the original item.'
                : modal?.mode === 'permanent'
                  ? 'This removes the selected items and their version history, and cannot be undone. Content needed by your sent transfers remains stored and counted until those transfers are cancelled or expire.'
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
            {error && <Alert tone="error">{error}</Alert>}
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
              <div className="list-row simple-row" key={v.id}>
                <div className="list-row-text">
                  <strong>Version {v.versionNumber}</strong>
                  <small>
                    {date(v.createdAt)} · {bytes(v.sizeBytes)}
                  </small>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void download({ driveItemId: modal.item!.id, versionId: v.id })}
                >
                  Download
                </Button>
                {v.id !== modal.item?.currentVersionId && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
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
                      }, `Restored version ${v.versionNumber}.`)
                    }
                  >
                    Restore
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <form className="form" onSubmit={submit}>
            {['folder', 'rename'].includes(modal?.mode ?? '') && (
              <Field label="Name">
                <Input
                  autoFocus
                  name="name"
                  defaultValue={modal?.item?.name ?? ''}
                  onFocus={(e) => modal?.mode === 'rename' && selectBaseName(e.currentTarget)}
                  required
                  maxLength={240}
                />
              </Field>
            )}
            {modal?.mode === 'move' && <FolderPicker />}
            {['send', 'share'].includes(modal?.mode ?? '') && (
              <Field
                label="To"
                hint={
                  modal?.mode === 'send' &&
                  'New recipients can verify their email and find the transfer after signup.'
                }
              >
                <Input
                  autoFocus
                  name="recipient"
                  aria-label="To"
                  required
                  placeholder="@username or email address"
                />
              </Field>
            )}
            {modal?.mode === 'share' && (
              <Field label="Permission">
                <Select name="permission" block>
                  <option value="VIEWER">Viewer — browse and download</option>
                  <option value="EDITOR">Editor — also rename, move, and trash</option>
                </Select>
              </Field>
            )}
            {error && <Alert tone="error">{error}</Alert>}
            <DialogActions>
              <Button type="button" variant="outline" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                type="submit"
                variant={
                  ['permanent', 'empty-trash'].includes(modal?.mode ?? '') ? 'danger' : 'primary'
                }
              >
                {busy
                  ? 'Working…'
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
            </DialogActions>
          </form>
        )}
      </Dialog>
      <Dialog
        open={!!confirmation}
        onOpenChange={(v) => {
          if (!v && !busy) setConfirmation(null);
        }}
        title={confirmation?.title ?? ''}
        description={confirmation?.description}
      >
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
            Go back
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void act(confirmation!.run, confirmation!.done).then((done) => {
                if (done) setConfirmation(null);
              })
            }
          >
            {busy ? 'Working…' : confirmation?.label}
          </Button>
        </DialogActions>
      </Dialog>
      {toast && (
        <div className="toast" role="status">
          <Check aria-hidden="true" />
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
    <>
      <p>
        <strong>{item.name}</strong>
      </p>
      <dl className="details">
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
        <DialogActions>
          <Button variant="outline" onClick={onPreview}>
            Preview
          </Button>
          <Button onClick={onDownload}>
            <ArrowDownToLine />
            Download
          </Button>
        </DialogActions>
      )}
    </>
  );
}
function ProfileForm({
  user,
  save,
}: {
  user: { username: string; displayName: string };
  save: (values: Record<string, string>) => Promise<boolean>;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [username, setUsername] = useState(user.username);
  const [saving, setSaving] = useState(false);
  const changed = displayName.trim() !== user.displayName || username !== user.username;
  return (
    <form
      className="form profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        // Only changed fields are sent, so an unchanged username never counts as a rename.
        void save({
          ...(displayName.trim() !== user.displayName ? { displayName: displayName.trim() } : {}),
          ...(username !== user.username ? { username } : {}),
        }).finally(() => setSaving(false));
      }}
    >
      <Field label="Display name">
        <Input
          name="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          maxLength={100}
        />
      </Field>
      <Field
        label="Username"
        hint="3–32 lowercase letters, numbers, dots, or underscores. Usernames can be changed once every 30 days."
      >
        <InputGroup prefix="@">
          <Input
            name="username"
            aria-label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            required
            pattern="[a-z0-9_.]{3,32}"
            maxLength={32}
          />
        </InputGroup>
      </Field>
      <div>
        <Button type="submit" disabled={!changed || saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  );
}
function FolderPicker() {
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const id = trail.at(-1)?.id ?? null;
  const list = useQuery({ queryKey: ['folder-picker', id], queryFn: () => api.list(id) });
  return (
    <div className="folder-picker">
      <input type="hidden" name="parentId" value={id ?? ''} />
      <p>
        Destination: <strong>{trail.map((t) => t.name).join(' / ') || 'My Drive'}</strong>
      </p>
      {id && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setTrail(trail.slice(0, -1))}
          >
            ↑ Parent folder
          </Button>
        </div>
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
            className="picker-row"
            key={i.id}
            onClick={() => setTrail([...trail, { id: i.id, name: i.name }])}
          >
            <Folder size={16} />
            <span>{i.name}</span>
            <ChevronRight size={14} />
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
