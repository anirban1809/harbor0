'use client';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
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

/** A password input with a show/hide toggle. */
export function PasswordInput({
  className,
  size = 'md',
  ...props
}: Omit<ComponentProps<'input'>, 'size' | 'type'> & Size) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <div className={cn('input-group password-input', className)}>
      <input data-size={size} className="input" type={visible ? 'text' : 'password'} {...props} />
      <button
        type="button"
        className="password-toggle"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
      >
        <Icon aria-hidden="true" />
      </button>
    </div>
  );
}
