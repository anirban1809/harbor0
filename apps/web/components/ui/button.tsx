import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'md' | 'sm' | 'lg' | 'icon' | 'icon-sm';

/** The one button used across both apps; icon-only buttons need an `aria-label`. */
export function Button({
  className,
  variant = 'primary',
  size = 'md',
  block,
  ...props
}: ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize; block?: boolean }) {
  return (
    <button
      data-variant={variant}
      data-size={size}
      className={cn('btn', block && 'btn-block', className)}
      {...props}
    />
  );
}
