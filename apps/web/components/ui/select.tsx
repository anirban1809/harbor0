import type { ComponentProps } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

/** A native select with the kit's chrome, so it keeps platform keyboard and mobile behaviour. */
export function Select({
  className,
  active,
  block,
  children,
  ...props
}: ComponentProps<'select'> & { active?: boolean; block?: boolean }) {
  return (
    <span className={cn('select', className)} data-active={active} data-block={block}>
      <select {...props}>{children}</select>
      <ChevronDown aria-hidden="true" />
    </span>
  );
}
