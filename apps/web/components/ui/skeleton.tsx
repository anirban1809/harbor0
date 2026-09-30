import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden="true" className={cn('skeleton', className)} {...props} />;
}
