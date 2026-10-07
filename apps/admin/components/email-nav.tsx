'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CampaignState } from '../../../packages/contracts/src/campaigns';
import { Badge, type BadgeTone } from '../../web/components/ui/badge';
import { campaignStateLabels } from '../lib/format';

const sections = [
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/email-templates', label: 'Templates' },
  { href: '/email-groups', label: 'Groups' },
];

/** Moves between the three parts of email campaigns. */
export function EmailNav() {
  const pathname = usePathname();
  return (
    <nav className="admin-subnav" aria-label="Email campaigns">
      {sections.map((s) => (
        <Link key={s.href} href={s.href} aria-current={pathname === s.href ? 'page' : undefined}>
          {s.label}
        </Link>
      ))}
    </nav>
  );
}

const tones: Record<CampaignState, BadgeTone> = {
  DRAFT: 'neutral',
  SCHEDULED: 'accent',
  SENDING: 'warning',
  SENT: 'success',
  STOPPED: 'danger',
};
export function CampaignStateBadge({ state }: { state: CampaignState }) {
  return <Badge tone={tones[state]}>{campaignStateLabels[state]}</Badge>;
}
export function CategoryBadge({ category }: { category: 'PRODUCT' | 'SERVICE' }) {
  return category === 'PRODUCT' ? (
    <Badge>Product update</Badge>
  ) : (
    <Badge tone="warning">Service notice</Badge>
  );
}
