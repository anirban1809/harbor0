import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function Checkbox({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input type="checkbox" className={cn('checkbox', className)} {...props} />;
}

export function Radio({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input type="radio" className={cn('radio', className)} {...props} />;
}
