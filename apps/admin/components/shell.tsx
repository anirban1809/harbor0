'use client';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Flag, LayoutDashboard, LogOut, Mail, ScrollText, Users } from 'lucide-react';
import { BrandLogo } from '../../web/components/brand-logo';
import { Badge } from '../../web/components/ui/badge';
import { Button } from '../../web/components/ui/button';
import { Skeleton } from '../../web/components/ui/skeleton';
import { can, type Staff, type StaffPermission } from '../../../packages/contracts/src/admin';
import { api, ApiError } from '../lib/api';

const StaffContext = createContext<Staff | null>(null);
/** The signed-in staff member; only available inside `<Shell>`. */
export function useStaff() {
  const staff = useContext(StaffContext);
  if (!staff) throw new Error('useStaff must be used inside <Shell>.');
  return staff;
}
export function useCan(permission: StaffPermission) {
  return can(useStaff().role, permission);
}

const nav = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/users', label: 'Users', icon: Users },
  { href: '/flags', label: 'Feature flags', icon: Flag },
  { href: '/campaigns', label: 'Email campaigns', icon: Mail },
  { href: '/audit', label: 'Audit log', icon: ScrollText },
];

/** The signed-in frame: sidebar navigation, the staff member, and a redirect to sign-in. */
export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const queries = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const signedOut = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (signedOut) router.replace('/login');
  }, [signedOut, router]);
  // Any request that finds the session gone sends staff back to sign-in.
  useEffect(
    () =>
      queries.getQueryCache().subscribe((event) => {
        const error = event.query.state.error;
        if (error instanceof ApiError && error.status === 401) router.replace('/login');
      }),
    [queries, router],
  );
  const signOut = async () => {
    await api.logout().catch(() => undefined);
    queries.clear();
    router.replace('/login');
  };
  const staff = me.data?.staff;
  const active = (href: string) =>
    href === '/'
      ? pathname === '/'
      : pathname === href ||
        pathname.startsWith(`${href}/`) ||
        (href === '/users' && pathname.startsWith('/user')) ||
        (href === '/campaigns' && pathname.startsWith('/email-'));
  return (
    <div className="admin-frame">
      <aside className="sidebar admin-sidebar">
        <div className="admin-brand">
          <BrandLogo />
          <Badge tone="warning">Console</Badge>
        </div>
        <nav aria-label="Console">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="admin-nav"
              aria-current={active(href) ? 'page' : undefined}
            >
              <Icon aria-hidden="true" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="admin-staff">
          {staff ? (
            <>
              <div className="admin-staff-who">
                <span className="admin-staff-email" title={staff.email}>
                  {staff.email}
                </span>
                <Badge tone={staff.role === 'ADMIN' ? 'accent' : 'neutral'}>
                  {staff.role === 'ADMIN' ? 'Admin' : 'Support'}
                </Badge>
              </div>
              <Button variant="ghost" size="sm" onClick={signOut}>
                <LogOut aria-hidden="true" />
                Sign out
              </Button>
            </>
          ) : (
            <Skeleton className="admin-staff-skeleton" />
          )}
        </div>
      </aside>
      <main className="main-shell admin-main">
        {staff ? (
          <StaffContext.Provider value={staff}>{children}</StaffContext.Provider>
        ) : me.error && !signedOut ? (
          <p className="admin-empty">{me.error.message}</p>
        ) : (
          <div className="admin-loading">
            <Skeleton className="admin-skeleton-title" />
            <Skeleton className="admin-skeleton-block" />
          </div>
        )}
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="admin-page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </header>
  );
}
