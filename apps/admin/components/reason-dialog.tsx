'use client';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert } from '../../web/components/ui/alert';
import { Button } from '../../web/components/ui/button';
import { Dialog, DialogActions } from '../../web/components/ui/dialog';
import { Field } from '../../web/components/ui/field';
import { Textarea } from '../../web/components/ui/input';

/**
 * Confirms a change to a customer account. Every change needs a reason; it is stored in the
 * audit log with the staff member's name.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger,
  children,
  canSubmit = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  children?: ReactNode;
  canSubmit?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setReason('');
      setError('');
    }
  }, [open]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onConfirm(reason.trim());
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <form className="admin-dialog-form" onSubmit={submit}>
        {children}
        <Field label="Reason" hint="Recorded in the audit log, e.g. a ticket number.">
          <Textarea
            required
            minLength={3}
            maxLength={500}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={danger ? 'danger' : 'primary'}
            disabled={busy || !canSubmit || reason.trim().length < 3}
          >
            {confirmLabel}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
