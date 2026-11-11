import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A card is one task or one fact, made of these parts only (see the Components section of
 * `.cursor/rules/ui-ux.mdc`): CardHeader, then CardBody (or a flush list or table), CardSection
 * for titled parts inside, and CardFooter for its actions and the job it started.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border bg-card text-card-foreground shadow-xs', className)} {...props} />;
}

type HeaderProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  /** The card's name; with it the header lays out its parts itself. */
  title?: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  /** One thing about the card, on the right: a ScopeLabel, a StatusBadge or a count. */
  meta?: ReactNode;
  /** Buttons that act on the whole card, after the meta. */
  actions?: ReactNode;
};

/**
 * The top of a card under a line. With `title` it lays out the title, a description, one meta
 * item and the card's actions; without it, its children as they come (older cards).
 */
export function CardHeader({ className, title, description, meta, actions, children, ...props }: HeaderProps) {
  if (title === undefined) return <div className={cn('flex items-center justify-between gap-4 border-b px-5 py-3.5', className)} {...props}>{children}</div>;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-3.5', className)} {...props}>
      <div className="min-w-0 flex-[1_1_12rem]">
        <CardTitle>{title}</CardTitle>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {(meta || actions) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {meta}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-sm font-semibold tracking-tight', className)} {...props} />;
}

/**
 * The content of a card: padded, its parts stacked with a fixed gap. `flush` drops the padding
 * for a list of rows or a table that reaches the card's edges; `compact` is for dense cards.
 */
export function CardBody({ className, flush = false, compact = false, ...props }: HTMLAttributes<HTMLDivElement> & { flush?: boolean; compact?: boolean }) {
  return <div className={cn(flush ? 'min-w-0' : compact ? 'grid gap-3 px-4 py-3 text-sm' : 'grid gap-4 px-5 py-4 text-sm', className)} {...props} />;
}

/** A titled part inside a card's body, under a line: settings that belong together. */
export function CardSection({ title, description, actions, children, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-3 border-t px-5 py-4 text-sm first:border-t-0', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * The bottom of a card under a line: its buttons on the left and, in `end`, the way out of the
 * card ("Open Apache", a link) on the right. A job the card started goes here (JobFooter).
 */
export function CardFooter({ className, end, children, ...props }: HTMLAttributes<HTMLDivElement> & { end?: ReactNode }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 border-t px-5 py-3 text-sm', className)} {...props}>
      {children}
      {end && <div className="ml-auto flex flex-wrap items-center gap-2">{end}</div>}
    </div>
  );
}
