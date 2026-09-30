'use client';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { Menu as Base } from '@base-ui/react/menu';
import { Check, MoreHorizontal } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './button';

export const Menu = Base.Root;

export function MenuTrigger({
  render = <Button variant="ghost" size="icon" />,
  ...props
}: ComponentProps<typeof Base.Trigger> & { render?: ReactElement }) {
  return <Base.Trigger render={render} {...props} />;
}

export function MenuContent({
  className,
  align = 'end',
  side = 'bottom',
  sideOffset = 6,
  children,
}: {
  className?: string;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  sideOffset?: number;
  children: ReactNode;
}) {
  return (
    <Base.Portal>
      <Base.Positioner
        className="menu-positioner"
        align={align}
        side={side}
        sideOffset={sideOffset}
      >
        <Base.Popup className={cn('menu', className)}>{children}</Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  );
}

export function MenuItem({
  className,
  tone,
  ...props
}: ComponentProps<typeof Base.Item> & { tone?: 'danger' }) {
  return <Base.Item data-tone={tone} className={cn('menu-item', className)} {...props} />;
}

export function MenuSeparator() {
  return <Base.Separator className="menu-separator" />;
}

export function MenuLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Base.Group>
      <Base.GroupLabel className={cn('menu-label', className)}>{children}</Base.GroupLabel>
    </Base.Group>
  );
}

export const MenuRadioGroup = Base.RadioGroup;

export function MenuRadioItem({ children, ...props }: ComponentProps<typeof Base.RadioItem>) {
  return (
    <Base.RadioItem className="menu-item" {...props}>
      {children}
      <Base.RadioItemIndicator className="menu-item-indicator">
        <Check aria-hidden="true" />
      </Base.RadioItemIndicator>
    </Base.RadioItem>
  );
}

export function MenuCheckboxItem({ children, ...props }: ComponentProps<typeof Base.CheckboxItem>) {
  return (
    <Base.CheckboxItem className="menu-item" {...props}>
      {children}
      <Base.CheckboxItemIndicator className="menu-item-indicator">
        <Check aria-hidden="true" />
      </Base.CheckboxItemIndicator>
    </Base.CheckboxItem>
  );
}

/** The “⋯” menu shown on rows and cards. */
export function ActionsMenu({
  label,
  disabled,
  className,
  children,
}: {
  label: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger aria-label={label} disabled={disabled}>
        <MoreHorizontal aria-hidden="true" />
      </MenuTrigger>
      <MenuContent className={className}>{children}</MenuContent>
    </Menu>
  );
}
