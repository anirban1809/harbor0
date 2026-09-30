'use client';
import type { ComponentProps, ReactNode } from 'react';
import { Tabs as Base } from '@base-ui/react/tabs';
import { cn } from '../../lib/utils';

/** Wraps a tab list and its panel; `value` is the selected tab. */
export function Tabs<T extends string>({
  value,
  onValueChange,
  className,
  children,
}: {
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Base.Root
      className={className}
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
    >
      {children}
    </Base.Root>
  );
}

export function TabList({ className, ...props }: ComponentProps<typeof Base.List>) {
  return <Base.List activateOnFocus className={cn('tabs-list', className)} {...props} />;
}

export function Tab({ className, ...props }: ComponentProps<typeof Base.Tab>) {
  return <Base.Tab className={cn('tab', className)} {...props} />;
}

export function TabPanel({ className, ...props }: ComponentProps<typeof Base.Panel>) {
  return <Base.Panel className={cn('tab-panel', className)} {...props} />;
}
