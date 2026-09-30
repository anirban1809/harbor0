import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** A labelled control with an optional hint. `inline` places a checkbox beside its label. */
export function Field({
  label,
  hint,
  inline,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  inline?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn('field', className)} data-inline={inline}>
      {inline && children}
      <span className="field-label">{label}</span>
      {!inline && children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
