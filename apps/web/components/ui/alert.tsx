import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './button';

type Tone = 'info' | 'success' | 'warning' | 'error';
const icons = { info: Info, success: CheckCircle2, warning: AlertCircle, error: AlertCircle };

/** An inline message. Errors are announced immediately; other tones politely. */
export function Alert({
  tone = 'info',
  className,
  role,
  action,
  onDismiss,
  dismissLabel = 'Dismiss',
  children,
}: {
  tone?: Tone;
  className?: string;
  role?: 'alert' | 'status' | 'none';
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  children: ReactNode;
}) {
  const Icon = icons[tone];
  const resolved = role ?? (tone === 'error' ? 'alert' : 'status');
  return (
    <div
      className={cn('alert', tone === 'error' && 'error', className)}
      data-tone={tone}
      role={resolved === 'none' ? undefined : resolved}
    >
      <Icon aria-hidden="true" />
      <div className="alert-content">{children}</div>
      {action}
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="alert-dismiss"
          aria-label={dismissLabel}
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
