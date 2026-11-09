import { Maximize2, Minimize2 } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { DIALOG_SIZES, type DialogSize } from '@/lib/dialog-sizes';
import { cn } from '@/lib/utils';


interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Its width, from DIALOG_SIZES; md by default. */
  size?: DialogSize;
  /** Placement and the like; never a width (use size). */
  className?: string;
  /** Hide the visual title (it stays for screen readers), e.g. for the command palette. */
  bare?: boolean;
  /** False keeps it open on a click outside, for a form a misclick would lose. */
  closeOnBackdrop?: boolean;
  /** False keeps it open on Escape; onKeptOpen is told, to say how to close it. */
  closeOnEscape?: boolean;
  onKeptOpen?: () => void;
  /**
   * The buttons, kept below the content: a long content scrolls between the
   * title and them, with a line above them, so a field never runs into them.
   */
  footer?: ReactNode;
  /** A button next to the title that fills the window, and back. */
  fullScreen?: { on: boolean; onChange: (on: boolean) => void };
}

/**
 * Modal dialog on the native <dialog> element: focus trapping, Escape and the
 * backdrop come from the browser. A click closes it only when it starts and
 * ends on the backdrop, so selecting text in a field and letting go outside
 * keeps it open.
 */
export function Dialog({ open, onClose, title, description, children, size = 'md', className, bare, closeOnBackdrop = true, closeOnEscape = true, onKeptOpen, footer, fullScreen }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const pressedOnBackdrop = useRef(false);

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
      // Escape's keydown, not the cancel event: Chrome closes a dialog anyway
      // on a second Escape when only its cancel event was stopped.
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || closeOnEscape) return;
        e.preventDefault();
        onKeptOpen?.();
      }}
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const onBackdrop = pressedOnBackdrop.current && e.target === e.currentTarget;
        pressedOnBackdrop.current = false;
        if (onBackdrop && closeOnBackdrop) onClose();
      }}
      className={cn(
        'm-auto rounded-xl border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-[2px]',
        DIALOG_SIZES[size],
        footer !== undefined && 'max-h-[calc(100dvh-2rem)] overflow-hidden',
        className,
        // Full screen wins over the width a caller gives.
        fullScreen?.on && 'h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none',
      )}
    >
      {open &&
        (footer === undefined ? (
          <div className={cn(!bare && 'p-5')}>
            <Heading id={titleId} title={title} bare={bare} fullScreen={fullScreen} />
            {description && !bare && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
            <div className={cn(!bare && 'mt-4')}>{children}</div>
          </div>
        ) : (
          <div className={cn('flex max-h-[calc(100dvh-2rem)] flex-col', fullScreen?.on && 'h-full')}>
            <div className="shrink-0 px-5 pt-5">
              <Heading id={titleId} title={title} bare={bare} fullScreen={fullScreen} />
              {description && !bare && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
            </div>
            {/* Room on every side, so a focused field's ring is never cut off. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-4">{children}</div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>
          </div>
        ))}
    </dialog>
  );
}

function Heading({ id, title, bare, fullScreen }: { id: string; title: string; bare: boolean | undefined; fullScreen: Props['fullScreen'] }) {
  const h2 = (
    <h2 id={id} className={cn('text-base font-semibold tracking-tight', bare && 'sr-only')}>
      {title}
    </h2>
  );
  if (!fullScreen || bare) return h2;
  const Icon = fullScreen.on ? Minimize2 : Maximize2;
  const label = fullScreen.on ? 'Back to the usual size' : 'Full screen';
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">{h2}</div>
      <Button variant="ghost" size="icon" onClick={() => fullScreen.onChange(!fullScreen.on)} aria-label={label} title={label} className="-mt-1.5 -mr-2 size-8 text-muted-foreground hover:text-foreground">
        <Icon />
      </Button>
    </div>
  );
}
