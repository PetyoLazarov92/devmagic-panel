import { type DailyLine as Line, dailyLineParts } from '@devmagic-panel/shared';
import { Quote } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { quietMoment } from '@/features/modes/unlock-dialog';
import { api } from '@/lib/api';
import { MODE_COLOR, modeDots, SLOTS } from '@/lib/mode-dots';
import { useModesView, useReducedMotion } from '@/lib/modes';
import { cn } from '@/lib/utils';

/**
 * The daily line: a short thought set as a quote, one secret word in bold. It
 * opens by itself the first time the panel is opened each day (once across
 * browsers, waiting for a quiet moment like the unlock dialog), and the quote
 * icon in the top bar opens it again all day.
 */
export function DailyLine() {
  const [line, setLine] = useState<(Line & { seen: boolean }) | null>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const quote = useRef<HTMLQuoteElement>(null);
  // Where the dialog was closed (the click on ×, Thanks or the backdrop): a small + K rises from there and fades.
  const [ghost, setGhost] = useState<{ x: number; y: number; at: number } | null>(null);
  const lastPress = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    // Only a press on the dialog or its backdrop: the click that opened it does not count.
    const note = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('dialog')) lastPress.current = { x: e.clientX, y: e.clientY, at: Date.now() };
    };
    window.addEventListener('pointerdown', note, true);
    return () => window.removeEventListener('pointerdown', note, true);
  }, [open]);
  const reduced = useReducedMotion();
  const dots = modeDots(useModesView());

  useEffect(() => {
    let alive = true;
    let timer = 0;
    api.dailyLine().then(
      (l) => {
        if (!alive) return;
        setLine(l);
        if (l.seen) return;
        // A moment after the panel opened, then every few seconds until nothing else is showing.
        timer = window.setTimeout(function check() {
          if (!alive) return;
          if (quietMoment()) setOpen(true);
          else timer = window.setTimeout(check, 3000);
        }, 2500);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  async function show() {
    // Past midnight the line is a new one: ask again before showing it.
    try {
      setLine(await api.dailyLine());
    } catch {
      // the one read earlier will do
    }
    setOpen(true);
  }

  function close() {
    // The dialog's own close event follows a close from here: one + K only.
    if (!openRef.current) return;
    openRef.current = false;
    // Where it was clicked; closed with Escape, the middle of the dialog, which the browser may have
    // closed already (its box is empty then), and it sits in the middle of the window.
    const press = lastPress.current && Date.now() - lastPress.current.at < 1500 ? lastPress.current : null;
    lastPress.current = null;
    const box = quote.current?.closest('dialog')?.getBoundingClientRect();
    const middle = box && box.width > 0 ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const at = press ?? middle;
    setGhost({ x: at.x, y: at.y - 14, at: Date.now() });
    setOpen(false);
    if (line && !line.seen) void api.dailyLineSeen().then(setLine, () => undefined);
  }

  const parts = line ? dailyLineParts(line.text) : null;
  return (
    <>
      <IconButton icon={Quote} label="Today's line" variant="outline" onClick={() => void show()} />
      {line && parts && (
        <Dialog
          open={open}
          onClose={close}
          title="A line for today"
          footer={
            <>
              <div data-ui="mode-dots" className="mr-auto flex items-center gap-2" aria-label={`${dots.filter((d) => d.mode).length} of ${SLOTS} modes found`} role="img">
                {dots.map((d, i) => (
                  <span
                    key={i}
                    style={d.mode ? ({ '--c-l': MODE_COLOR[d.mode][0], '--c-d': MODE_COLOR[d.mode][1] } as CSSProperties) : undefined}
                    className={cn(
                      'size-2.5 rounded-full transition-colors duration-500',
                      d.bonus
                        ? cn('border-[1.5px] bg-clip-content p-px', d.mode ? 'border-(--c-l) bg-(--c-l) shadow-[0_0_6px_-1px_var(--c-l)] dark:border-(--c-d) dark:bg-(--c-d) dark:shadow-[0_0_6px_-1px_var(--c-d)]' : 'border-foreground/25')
                        : d.mode
                          ? 'bg-(--c-l) shadow-[0_0_6px_-1px_var(--c-l)] dark:bg-(--c-d) dark:shadow-[0_0_6px_-1px_var(--c-d)]'
                          : 'bg-foreground/15',
                    )}
                  />
                ))}
              </div>
              <Button data-autofocus onClick={close}>
                Thanks
              </Button>
            </>
          }
        >
          {/* Ctrl, faintly, one letter in each corner; the K rises as the dialog closes. */}
          {(['left-2 top-1.5', 'right-2 top-1.5', 'left-2 bottom-1.5', 'right-2 bottom-1.5'] as const).map((at, i) => (
            <span key={at} aria-hidden className={cn('pointer-events-none absolute font-serif text-2xs leading-none font-semibold text-foreground/12 select-none', at)}>
              {'Ctrl'[i]}
            </span>
          ))}
          <figure className="grid gap-3">
            <blockquote ref={quote} data-ui="daily-line" className="font-serif text-lg leading-relaxed text-balance">
              <span aria-hidden className="mr-1 text-2xl leading-none text-muted-foreground">“</span>
              {parts.before}
              <strong className="font-semibold">{parts.word}</strong>
              {parts.after}
              <span aria-hidden className="ml-0.5 text-2xl leading-none text-muted-foreground">”</span>
            </blockquote>
            <figcaption className="text-sm text-muted-foreground">{line.source}</figcaption>
          </figure>
        </Dialog>
      )}
      {ghost && (
        <span
          key={ghost.at}
          aria-hidden
          ref={(el) => {
            if (!el) return;
            const rise = reduced ? 'translate(-50%, -50%)' : 'translate(-50%, calc(-50% - 16px))';
            el.animate(
              [
                { opacity: 0, transform: 'translate(-50%, -50%)' },
                { opacity: 0.45, offset: 0.25 },
                { opacity: 0, transform: rise },
              ],
              { duration: 1400, easing: 'ease-out', fill: 'forwards' },
            ).onfinish = () => setGhost((g) => (g?.at === ghost.at ? null : g));
          }}
          style={{ left: ghost.x, top: ghost.y }}
          className="pointer-events-none fixed z-[60] font-mono text-xs font-medium tracking-wide text-muted-foreground opacity-0 select-none"
        >
          + K
        </span>
      )}
    </>
  );
}
