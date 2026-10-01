'use client';
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Dialog, DialogActions } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';

/** Settings card that deletes the account after the email is retyped. */
export function DeleteAccount({
  email,
  onDelete,
}: {
  email: string;
  onDelete: (email: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const matches = typed.trim().toLowerCase() === email.toLowerCase();
  return (
    <Card
      className="panel"
      title="Delete account"
      description="You’ll be signed out everywhere right away. Your files, backups and transfers are kept for 30 days and then permanently deleted."
    >
      <Button
        variant="danger"
        onClick={() => {
          setTyped('');
          setError('');
          setOpen(true);
        }}
      >
        <Trash2 />
        Delete account
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value && !busy) setOpen(false);
        }}
        title="Delete your account?"
        description="This can’t be undone. You’ll be signed out on every device, and your data will be permanently deleted after 30 days."
      >
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!matches || busy) return;
            setBusy(true);
            setError('');
            onDelete(typed.trim())
              .catch((e: Error) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {error && <Alert tone="error">{error}</Alert>}
          <Field label={`Type ${email} to confirm`}>
            <Input
              name="email"
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              required
            />
          </Field>
          <DialogActions>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Go back
            </Button>
            <Button type="submit" variant="danger" disabled={!matches || busy}>
              {busy ? 'Deleting…' : 'Delete account'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Card>
  );
}
