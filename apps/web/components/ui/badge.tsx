import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return <span data-tone={tone} className={cn('badge', className)} {...props} />;
}
