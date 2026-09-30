import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';

type Size = { size?: 'md' | 'lg' };

export function Input({
  className,
  size = 'md',
  ...props
}: Omit<ComponentProps<'input'>, 'size'> & Size) {
  return <input data-size={size} className={cn('input', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn('input', className)} {...props} />;
}

/** An input with a leading icon or a short text prefix such as “@”. */
export function InputGroup({
  icon,
  prefix,
  className,
  children,
}: {
  icon?: ReactNode;
  prefix?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('input-group', className)}>
      {icon}
      {prefix && (
        <span className="input-prefix" aria-hidden="true">
          {prefix}
        </span>
      )}
      {children}
    </div>
  );
}
