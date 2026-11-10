import type { LogLine } from '@devmagic-panel/shared';
import { Pause, Play, Search, Trash2 } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fileMentions, filesHref } from '@/lib/file-links';
import { timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

const LEVELS: Array<LogLine['level']> = ['fatal', 'error', 'warning', 'notice', 'deprecated', 'info'];

const levelTone: Record<LogLine['level'], string> = {
  fatal: 'bg-danger/15 text-danger',
  error: 'bg-danger/10 text-danger',
  warning: 'bg-warning/15 text-warning',
  notice: 'bg-primary/10 text-primary',
  deprecated: 'bg-muted text-muted-foreground',
  info: 'bg-muted text-muted-foreground',
};

/** Where the files a log names open: the site and its folder on disk. */
export interface LogFiles {
  domain: string;
  path?: string;
  docroot: string;
}

/** A log message with the site's own files as links to the Files tab, at the line named. */
function Message({ text, files }: { text: string; files: LogFiles | undefined }) {
  const mentions = files ? fileMentions(text, files.docroot) : [];
  if (!files || mentions.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  mentions.forEach((m, i) => {
    parts.push(text.slice(at, m.start));
    parts.push(
      <Link key={i} href={filesHref(files, m)} className="underline decoration-dotted underline-offset-2 hover:text-primary hover:decoration-solid" title="Open in Files">
        {text.slice(m.start, m.end)}
      </Link>,
    );
    at = m.end;
  });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** A debug.log or Apache log viewer: level filter, search, follow. */
export function LogView({ lines, onClear, files }: { lines: LogLine[]; onClear?: () => void; files?: LogFiles }) {
  const [levels, setLevels] = useState<Set<LogLine['level']>>(new Set());
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);

  const counts = useMemo(() => {
    const c = new Map<LogLine['level'], number>();
    lines.forEach((l) => c.set(l.level, (c.get(l.level) ?? 0) + 1));
    return c;
  }, [lines]);

  const shown = lines.filter(
    (l) => (levels.size === 0 || levels.has(l.level)) && (!query || l.message.toLowerCase().includes(query.toLowerCase())),
  );

  function toggle(level: LogLine['level']) {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Levels">
          {LEVELS.filter((l) => counts.get(l)).map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={levels.has(level)}
              onClick={() => toggle(level)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize transition-colors',
                levels.has(level) ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {level} <span className="tabular-nums opacity-70">{counts.get(level)}</span>
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search the log" className="h-8 pl-8 text-xs" />
        </div>
        <Button size="sm" variant="ghost" onClick={() => setFollow((f) => !f)} aria-pressed={follow}>
          {follow ? <Pause /> : <Play />}
          {follow ? 'Following' : 'Paused'}
        </Button>
        {onClear && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            <Trash2 />
            Clear log
          </Button>
        )}
      </div>
      <ol className="max-h-[28rem] divide-y overflow-auto font-mono text-xs">
        {shown.map((line, i) => (
          <li key={i} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-2.5 sm:grid-cols-[5.5rem_5.5rem_minmax(0,1fr)]">
            <time dateTime={line.time} className="whitespace-nowrap text-muted-foreground" title={new Date(line.time).toLocaleString()}>
              {timeAgo(line.time)}
            </time>
            <span className={cn('h-fit w-fit rounded px-1.5 py-px text-[11px] font-semibold uppercase', levelTone[line.level])}>{line.level}</span>
            <p className="col-span-2 min-w-0 whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere] sm:col-span-1"><Message text={line.message} files={files} /></p>
          </li>
        ))}
        {shown.length === 0 && <li className="px-4 py-8 text-center font-sans text-sm text-muted-foreground">Nothing logged{levels.size || query ? ' for this filter' : ''}.</li>}
      </ol>
    </div>
  );
}
