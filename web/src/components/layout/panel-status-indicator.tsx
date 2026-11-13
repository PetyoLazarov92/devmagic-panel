import type { PanelStatus, RunningProgram } from '@devmagic-panel/shared';
import { CircleAlert, CircleCheck, HeartPulse } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { TextLink } from '@/components/ui/text-link';
import { api } from '@/lib/api';
import { isUnreachable, noteReached, onConnectionChange } from '@/lib/connection';
import { timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

/** How often the status is read while its card is open, and while the panel does not answer. */
const OPEN_POLL_MS = 3000;
/** How often it is read in the background, for the warning dot only. */
const QUIET_POLL_MS = 5 * 60_000;

/** The one line that says how the panel is: what needs a look first, else that all is well. */
function headline(s: PanelStatus): { text: string; warn: boolean; note?: string } {
  const failed = s.tasks.filter((t) => t.lastOk === false);
  if (failed.length === 1) return { text: `${failed[0]?.label} failed`, warn: true, ...(failed[0]?.lastNote ? { note: failed[0].lastNote } : {}) };
  if (failed.length) return { text: `${failed.length} background tasks failed`, warn: true, note: failed.map((t) => t.label).join(', ') };
  if (s.before?.ended === 'unexpectedly') return { text: 'The last run stopped unexpectedly', warn: true, note: 'A crash, or the computer turned off' };
  return { text: 'All good', warn: false, note: `Running since ${timeAgo(s.startedAt).replace(/ ago$/, '')}` };
}

/** The programs running now, one line per job or background task; a page's reads are only counted. */
function workingOn(programs: readonly RunningProgram[]) {
  const by = new Map<string, { program: RunningProgram; names: string[]; since: string }>();
  let reads = 0;
  for (const p of programs) {
    const from = p.job ? `job:${p.job.id}` : p.task ? `task:${p.task.id}` : null;
    if (!from) {
      reads += 1;
      continue;
    }
    const line = by.get(from) ?? { program: p, names: [], since: p.startedAt };
    if (p.startedAt < line.since) line.since = p.startedAt;
    if (!line.names.includes(p.program)) line.names.push(p.program);
    by.set(from, line);
  }
  return { lines: [...by.values()], reads };
}

/**
 * The panel's own status in the top bar, answering one question: is the
 * panel fine, and is it busy? A line that says so (what failed first), what
 * it works on right now, its next task, and the way to Sanctum. Amber
 * while the panel does not answer (a restart) or when something needs a look.
 */
export function PanelStatusIndicator() {
  const [status, setStatus] = useState<PanelStatus | null>(null);
  const [down, setDown] = useState(isUnreachable);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => onConnectionChange(() => setDown(isUnreachable())), []);

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = async () => {
      if (down) {
        // Only the health check while the panel is away: it answers without a session, and once it does the rest comes back.
        const version = await api.health();
        if (stop) return;
        if (version) noteReached(true);
      } else {
        await api.panelStatus().then((s) => !stop && setStatus(s), () => undefined);
        if (stop) return;
      }
      timer = window.setTimeout(() => void tick(), open || down ? OPEN_POLL_MS : QUIET_POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [open, down]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const head = status ? headline(status) : null;
  const warn = down || head?.warn === true;
  const busy = workingOn(status?.programs ?? []);
  const next = status?.tasks.filter((t) => t.nextRunAt && !t.running).sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))[0];

  return (
    <div ref={box} className="relative">
      <Button
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={down ? 'The panel does not answer: it may be restarting' : 'Panel status'}
        aria-label="Panel status"
        className={cn(down ? 'border-warning/40 text-warning hover:text-warning' : 'text-muted-foreground', !down && 'px-2.5')}
      >
        {down ? <Spinner /> : <HeartPulse />}
        {down && <span className="hidden sm:inline">Reconnecting...</span>}
        {!down && warn && <span aria-hidden className="size-1.5 rounded-full bg-warning" />}
      </Button>
      {open && (
        // Built like the Jobs card next to it: the same box, rows and footer link, with a small heading per part.
        <div className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-card p-1.5 text-sm shadow-lg">
          {down ? (
            <Row title={<span className="text-warning">Reconnecting...</span>} sub="The panel does not answer: it may be restarting after an update. It comes back by itself, and this page with it." />
          ) : !status || !head ? (
            <Row title={<span className="flex items-center gap-2 font-normal text-muted-foreground"><Spinner />Reading the status...</span>} />
          ) : (
            <>
              <Row
                title={
                  <span className={cn('flex items-center gap-1.5', head.warn ? 'text-warning' : 'text-success')}>
                    {head.warn ? <CircleAlert className="size-4 shrink-0" /> : <CircleCheck className="size-4 shrink-0" />}
                    <span className="truncate">{head.text}</span>
                  </span>
                }
                {...(head.note ? { sub: head.note } : {})}
              />
              <Heading>Running now</Heading>
              {busy.lines.length === 0 && busy.reads === 0 && <p className="px-2.5 py-1.5 text-muted-foreground">Nothing right now.</p>}
              {busy.lines.map(({ program: p, names, since }) => (
                <Row
                  key={p.job?.id ?? p.task?.id}
                  {...(p.job ? { href: `/jobs/${encodeURIComponent(p.job.id)}`, onGo: () => setOpen(false) } : {})}
                  title={p.job?.title ?? p.task?.title}
                  meta={elapsed(since)}
                  sub={<span className="font-mono">{names.join(' · ')}</span>}
                />
              ))}
              {busy.reads > 0 && <Row title={<span className="font-normal text-muted-foreground">Page reads</span>} meta={String(busy.reads)} />}
              {next?.nextRunAt && (
                <>
                  <Heading>Up next</Heading>
                  <Row title={next.label} meta={timeAgo(next.nextRunAt)} />
                </>
              )}
            </>
          )}
          <TextLink href="/sanctum" className="mt-1 flex rounded-md border-t px-2.5 pt-2 pb-1.5 text-xs" onClick={() => setOpen(false)}>
            Open Sanctum: background tasks and storage
          </TextLink>
        </div>
      )}
    </div>
  );
}

/** A part's heading inside the card. */
function Heading({ children }: { children: ReactNode }) {
  return <h3 className="mt-1 border-t px-2.5 pt-2.5 pb-0.5 text-xs text-muted-foreground">{children}</h3>;
}

/** A line of the card as the Jobs card draws one: the title with its time on the right, a muted line under it; a link when it opens something. */
function Row({ title, meta, sub, href, onGo }: { title: ReactNode; meta?: string; sub?: ReactNode; href?: string; onGo?: () => void }) {
  const body = (
    <>
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium">{title}</span>
        {meta && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{meta}</span>}
      </span>
      {sub && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
    </>
  );
  const box = 'grid grid-cols-[minmax(0,1fr)] gap-1 rounded-md px-2.5 py-2';
  return href ? <Link href={href} className={cn(box, 'hover:bg-muted')} onClick={onGo}>{body}</Link> : <div className={box}>{body}</div>;
}

/** How long something has run, short: "42 s", "3 min". */
function elapsed(since: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

/** What started a program: its job (a link to it), a background task, or a page's read. */
export function ProgramFrom({ program, onGo }: { program: RunningProgram; onGo?: () => void }) {
  if (program.job) {
    return (
      <Link href={`/jobs/${encodeURIComponent(program.job.id)}`} className="underline-offset-2 hover:underline" onClick={onGo}>
        {program.job.title}
      </Link>
    );
  }
  if (program.task) return <>Background: {program.task.title}</>;
  return <>A page&apos;s read</>;
}
