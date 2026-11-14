import { type DailyLine as Line, dailyLineParts } from '@devmagic-panel/shared';
import { Quote } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { quietMoment } from '@/features/modes/unlock-dialog';
import { api } from '@/lib/api';

/**
 * The daily line: a short thought set as a quote, one secret word in bold. It
 * opens by itself the first time the panel is opened each day (once across
 * browsers, waiting for a quiet moment like the unlock dialog), and the quote
 * icon in the top bar opens it again all day.
 */
export function DailyLine() {
  const [line, setLine] = useState<(Line & { seen: boolean }) | null>(null);
  const [open, setOpen] = useState(false);

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
            <Button data-autofocus onClick={close}>
              Thanks
            </Button>
          }
        >
          <figure className="grid gap-3">
            <blockquote data-ui="daily-line" className="font-serif text-lg leading-relaxed text-balance">
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
    </>
  );
}
