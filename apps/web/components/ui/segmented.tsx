'use client';
import type { ReactNode } from 'react';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { cn } from '../../lib/utils';

/** A single-choice switch between a few views or modes. */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
  disabled,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: { value: T; label: string; icon?: ReactNode; iconOnly?: boolean }[];
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      className={cn('segmented', className)}
      disabled={disabled}
      value={[value]}
      onValueChange={(next) => {
        // Pressing the active option again keeps it selected.
        if (next[0]) onValueChange(next[0] as T);
      }}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          className="segment"
          data-icon={option.iconOnly}
          aria-label={option.iconOnly ? option.label : undefined}
          title={option.iconOnly ? option.label : undefined}
        >
          {option.icon}
          {!option.iconOnly && option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
