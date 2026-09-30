'use client';
import type { ComponentProps, ReactNode } from 'react';
import { Dialog as Base } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './button';

type FinalFocus = ComponentProps<typeof Base.Popup>['finalFocus'];
type Shared = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  /** Where focus returns when the dialog closes; defaults to the element that opened it. */
  finalFocus?: FinalFocus;
  children: ReactNode;
};

function Header({ title, description }: Pick<Shared, 'title' | 'description'>) {
  return (
    <header className="dialog-header">
      <Base.Title className="dialog-title">{title}</Base.Title>
      {description && (
        <Base.Description className="dialog-description">{description}</Base.Description>
      )}
    </header>
  );
}

// Rendered last so the first field, not the close button, receives initial focus.
function Close({ label = 'Close' }: { label?: string }) {
  return (
    <Base.Close
      render={<Button variant="ghost" size="icon-sm" className="dialog-close" />}
      aria-label={label}
    >
      <X aria-hidden="true" />
    </Base.Close>
  );
}

/** A centred modal for confirmations and short forms. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  className,
  finalFocus,
  children,
}: Shared) {
  return (
    <Base.Root open={open} onOpenChange={(value) => onOpenChange(value)}>
      <Base.Portal>
        <Base.Backdrop className="dialog-backdrop" />
        <Base.Popup className={cn('dialog', className)} finalFocus={finalFocus}>
          <Header title={title} description={description} />
          <div className="dialog-body">{children}</div>
          <Close />
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  );
}

/** A side panel for details, previews and activity. */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  className,
  finalFocus,
  footer,
  closeLabel,
  modal = true,
  children,
}: Shared & {
  footer?: ReactNode;
  closeLabel?: string;
  /** Non-modal drawers leave the page interactive and stay open on outside clicks. */
  modal?: boolean;
}) {
  return (
    <Base.Root
      open={open}
      modal={modal}
      disablePointerDismissal={!modal}
      onOpenChange={(value) => onOpenChange(value)}
    >
      <Base.Portal>
        {modal && <Base.Backdrop className="dialog-backdrop" />}
        <Base.Popup className={cn('drawer', className)} finalFocus={finalFocus}>
          <Header title={title} description={description} />
          <div className="drawer-body">{children}</div>
          {footer && <div className="drawer-footer">{footer}</div>}
          <Close label={closeLabel} />
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  );
}

export function DialogActions({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('dialog-actions', className)} {...props} />;
}
