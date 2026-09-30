import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** The table surface for files, transfers and sync folders; it scrolls sideways when narrow. */
export function DataTable({
  children,
  label,
  className,
  containerClassName,
  align,
}: {
  children: ReactNode;
  label: string;
  className?: string;
  containerClassName?: string;
  align?: 'top';
}) {
  return (
    <div
      className={cn('table-scroll', containerClassName)}
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <table className={cn('table', className)} data-align={align}>
        {children}
      </table>
    </div>
  );
}
