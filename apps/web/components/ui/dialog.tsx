'use client';
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './dialog-primitives';
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ?? 'Manage your private files in harbor0.'}
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </DialogRoot>
  );
}
