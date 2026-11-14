import { Maximize2, Minimize2, X } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
  /** A button next to the title that fills the window, and back, when the caller needs to know; else the dialog keeps it. */
  fullScreen?: { on: boolean; onChange: (on: boolean) => void };
  /** Offer full screen even while nothing scrolls, for a dialog that holds a long list of its own (see useDialogFull). */
  expandable?: boolean;
}

/** Whether the dialog around is full screen: a list in it with a height of its own lets it go then. */
const FullContext = createContext(false);
export const useDialogFull = (): boolean => useContext(FullContext);

/** A long list in a dialog: held to a height of its own, which goes once the dialog is full screen. */
export function DialogList({ className, children }: { className: string; children: ReactNode }) {
  const full = useDialogFull();
  return <div className={cn('overflow-y-auto pr-1', full ? '' : className)}>{children}</div>;
}

/**
 * Full screen for a dialog, or for several that take turns (a row's View,
 * then Edit): it lasts while they are open, and every new open starts at the
 * usual size, since a dialog that closes turns it off.
 */
export function useFullScreen(): { on: boolean; onChange: (on: boolean) => void } {
  const [on, onChange] = useState(false);
  return { on, onChange };
}

/**
 * Modal dialog on the native <dialog> element: focus trapping, Escape and the
 * backdrop come from the browser. A click closes it only when it starts and
 * ends on the backdrop, so selecting text in a field and letting go outside
 * keeps it open.
 */
export function Dialog({ open, onClose, title, description, children, size = 'md', className, bare, closeOnBackdrop = true, closeOnEscape = true, onKeptOpen, footer, fullScreen: given, expandable }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const pressedOnBackdrop = useRef(false);
  const own = useFullScreen();
  const full = given ?? own;
  // Full screen is offered once the content scrolls, or when the caller asks; never on a short dialog.
  const [scrolls, setScrolls] = useState(false);
  const fullScreen = !bare && (given !== undefined || expandable || scrolls || full.on) ? full : undefined;

  useLayoutEffect(() => {
    const el = footer === undefined ? ref.current : body.current;
    if (!open || !el) return;
    const look = () => setScrolls(el.scrollHeight > el.clientHeight + 1);
    look();
    const observer = new ResizeObserver(look);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [open, footer === undefined]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // The browser focuses the first button (often the ×); a dialog that marks its main control data-autofocus gets it instead.
      el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && el.open) el.close();
    // Full screen is never kept: the next open is at the usual size.
    if (!open && full.on) full.onChange(false);
  }, [open]);

  // The ×: as Escape, so a dialog that must stay open (a run in progress) says why instead of closing.
  const closeAsked = () => (closeOnEscape ? onClose() : onKeptOpen?.());

  return (
    <dialog
      ref={ref}
      data-ui="dialog"
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
        full.on && 'h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none',
      )}
    >
      <FullContext.Provider value={full.on}>
      {open &&
        (footer === undefined ? (
          <div className={cn(!bare && 'p-5')}>
            <Heading id={titleId} title={title} bare={bare} fullScreen={fullScreen} onClose={closeAsked} />
            {description && !bare && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
            <div className={cn(!bare && 'mt-4')}>{children}</div>
          </div>
        ) : (
          <div className={cn('flex max-h-[calc(100dvh-2rem)] flex-col', full.on && 'h-full')}>
            <div className="shrink-0 px-5 pt-5">
              <Heading id={titleId} title={title} bare={bare} fullScreen={fullScreen} onClose={closeAsked} />
              {description && !bare && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
            </div>
            {/* Room on every side, so a focused field's ring is never cut off. */}
            <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-4">{children}</div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>
          </div>
        ))}
      </FullContext.Provider>
    </dialog>
  );
}

/**
 * The title, and in the top right corner × to close, where every app has it. A dialog that can
 * fill the screen has its button just left of ×, with its own icon and name, so the two are
 * never taken for each other.
 */
function Heading({ id, title, bare, fullScreen, onClose }: { id: string; title: string; bare: boolean | undefined; fullScreen: Props['fullScreen']; onClose: () => void }) {
  const h2 = (
    <h2 id={id} data-ui="dialog-title" className={cn('text-base font-semibold tracking-tight', bare && 'sr-only')}>
      {title}
    </h2>
  );
  if (bare) return h2;
  const Icon = fullScreen?.on ? Minimize2 : Maximize2;
  const label = fullScreen?.on ? 'Back to the usual size' : 'Full screen';
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">{h2}</div>
      <div className="-mt-1.5 -mr-2 flex shrink-0 items-center gap-0.5">
        {fullScreen && (
          <Button variant="ghost" size="icon" onClick={() => fullScreen.onChange(!fullScreen.on)} aria-label={label} title={label} className="size-8 text-muted-foreground hover:text-foreground">
            <Icon />
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" title="Close" className="size-8 text-muted-foreground hover:text-foreground">
          <X />
        </Button>
      </div>
    </div>
  );
}
