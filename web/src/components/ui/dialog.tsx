import { type ReactNode, useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Hide the visual title (it stays for screen readers), e.g. for the command palette. */
  bare?: boolean;
}

/**
 * Modal dialog on the native <dialog> element: focus trapping, Escape and the
 * backdrop come from the browser.
 */
export function Dialog({ open, onClose, title, description, children, className, bare }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className={cn(
        'm-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-[2px]',
        className,
      )}
    >
      {open && (
        <div className={cn(!bare && 'p-5')}>
          <h2 id={titleId} className={cn('text-base font-semibold tracking-tight', bare && 'sr-only')}>
            {title}
          </h2>
          {description && !bare && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
          <div className={cn(!bare && 'mt-4')}>{children}</div>
        </div>
      )}
    </dialog>
  );
}
