import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** A bordered surface. `title` adds a heading row with an optional description and action. */
export function Card({
  title,
  description,
  action,
  className,
  children,
  ...props
}: Omit<ComponentProps<'section'>, 'title'> & {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className={cn('card', className)} {...props}>
      {title && (
        <div className="card-header">
          <div>
            <h2 className="card-title">{title}</h2>
            {description && <p className="card-description">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
