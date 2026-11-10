import { MoreHorizontal } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * A small popover menu with click-outside and Escape to close. It is placed
 * against the window, not its parent, so a table or card that clips its
 * content never cuts it, and it opens upwards when there is no room below.
 */
export function Menu({ items, label = 'More actions', align = 'end', trigger, triggerClassName }: {
  items: MenuItem[];
  label?: string;
  align?: 'start' | 'end';
  /** What the button shows in place of the three dots, like More and a count; label still names it. */
  trigger?: ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' });
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return setPlace({ visibility: 'hidden' });
    const button = root.current?.querySelector('button')?.getBoundingClientRect();
    const menu = list.current;
    if (!button || !menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const gap = 4;
    const below = window.innerHeight - button.bottom;
    const up = below < height + gap + 8 && button.top > below;
    const top = up ? Math.max(8, button.top - gap - height) : button.bottom + gap;
    const left = Math.min(Math.max(8, align === 'end' ? button.right - width : button.left), window.innerWidth - width - 8);
    // An ancestor with a transform or a filter moves where "fixed" starts: measure and take the difference off.
    menu.style.top = '0px';
    menu.style.left = '0px';
    const origin = menu.getBoundingClientRect();
    setPlace({ top: top - origin.top, left: left - origin.left });
  }, [open, align, items.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // It does not follow the page: scrolling or resizing closes it.
    const close = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    root.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not([disabled])')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label={trigger ? label : undefined}
        className={cn(trigger ? 'inline-flex items-center gap-1.5' : 'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', triggerClassName)}
      >
        {trigger ?? (
          <>
            <MoreHorizontal className="size-4" />
            <span className="sr-only">{label}</span>
          </>
        )}
      </button>
      {open && (
        <div
          id={id}
          ref={list}
          role="menu"
          style={place}
          className="fixed z-50 min-w-48 rounded-lg border bg-card p-1 text-left shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground',
                item.danger && 'text-danger [&_svg]:text-danger',
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
