import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** Shared table surface for files and transfers in both clients. */
export function DataTable({
  children,
  label,
  className,
  containerClassName,
}: {
  children: ReactNode;
  label: string;
  className?: string;
  containerClassName?: string;
}) {
  return (
    <div
      className={cn('data-table-scroll', containerClassName)}
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <table className={cn('data-table', className)}>{children}</table>
    </div>
  );
}
