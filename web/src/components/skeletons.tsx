import { RefreshCw } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A gray bar standing in for text or a control while it loads, as the Plugins tab draws them. */
export function Bar({ className, style }: { className?: string; style?: CSSProperties | undefined }) {
  return <div className={cn('animate-pulse rounded bg-muted', className)} style={style} />;
}

/** What is being read, with a turning icon, for screen readers too. */
export function Reading({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <RefreshCw className="size-3.5 animate-spin" />
      {children}
    </p>
  );
}

/** One site card's shape: status dot, domain, subtitle, badge, the facts and the buttons. */
function SiteCardSkeleton({ width }: { width: number }) {
  return (
    <div className="flex flex-col rounded-xl border bg-card px-5 py-4 shadow-xs">
      <div className="flex items-start gap-3">
        <Bar className="mt-1 size-2.5 rounded-full" />
        <div className="grid flex-1 gap-2">
          <Bar className="h-3.5" style={{ width: `${width}%` }} />
          <Bar className="h-3" style={{ width: `${width * 0.6}%` }} />
          <Bar className="h-5 w-28 rounded-full" />
        </div>
      </div>
      <div className="mt-4 grid gap-2.5">
        {[42, 56, 34].map((w, i) => (
          <div key={i} className="flex items-center gap-3">
            <Bar className="size-4 rounded" />
            <Bar className="h-3 w-16" />
            <Bar className="h-3" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2 border-t pt-3">
        <Bar className="h-8 w-20 rounded-md" />
        <Bar className="h-8 w-24 rounded-md" />
      </div>
    </div>
  );
}

/** One row of the list view: status dot, domain and title, branch, version and the buttons. */
function SiteRowSkeleton({ width }: { width: number }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Bar className="size-2.5 shrink-0 rounded-full" />
      <div className="grid flex-1 gap-1.5">
        <Bar className="h-3.5" style={{ width: `${width}%` }} />
        <Bar className="h-2.5" style={{ width: `${width * 0.55}%` }} />
      </div>
      <Bar className="hidden h-3 w-40 md:block" />
      <Bar className="hidden h-3 w-20 lg:block" />
      <Bar className="hidden h-7 w-32 rounded-md sm:block" />
      <Bar className="size-7 shrink-0 rounded-md" />
    </li>
  );
}

/** The Sites page while the panel reads its sites the first time, in the view picked: cards, or the lighter rows. */
export function SitesSkeleton({ view, className }: { view: 'grid' | 'list'; className?: string }) {
  return (
    <div className={cn('grid gap-4', className)} aria-busy="true">
      <Reading>Reading the sites from Apache, /etc/hosts and wp-config.php...</Reading>
      {view === 'grid' ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">{[58, 46, 66, 40].map((w, i) => <SiteCardSkeleton key={i} width={w} />)}</div>
      ) : (
        <ul className="divide-y rounded-xl border bg-card shadow-xs">{[42, 30, 50, 36, 46, 28, 40, 34].map((w, i) => <SiteRowSkeleton key={i} width={w} />)}</ul>
      )}
    </div>
  );
}

/** A site's page while it loads: its header, the tabs and a few cards. */
export function SitePageSkeleton() {
  return (
    <div className="grid gap-5 pt-4" aria-busy="true">
      <Bar className="h-3 w-40" />
      <div className="grid gap-2.5">
        <Bar className="h-7 w-72 max-w-full" />
        <Bar className="h-3.5 w-56 max-w-full" />
        <div className="mt-1 flex flex-wrap gap-2">
          {[24, 28, 20].map((w, i) => <Bar key={i} className="h-8 rounded-md" style={{ width: `${w * 4}px` }} />)}
        </div>
      </div>
      <div className="flex gap-4 border-b pb-2.5">
        {[18, 14, 12, 16, 22].map((w, i) => <Bar key={i} className="h-4" style={{ width: `${w * 4}px` }} />)}
      </div>
      <Reading>Reading the site...</Reading>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        {[64, 48, 56, 40].map((w, i) => (
          <div key={i} className="grid gap-3 rounded-xl border bg-card p-5">
            <Bar className="h-4 w-32" />
            <Bar className="h-3" style={{ width: `${w}%` }} />
            <Bar className="h-3" style={{ width: `${w * 0.75}%` }} />
            <Bar className="h-3" style={{ width: `${w * 0.5}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Widths that look like text of different lengths, picked by a line's number so a skeleton is the same on every render. */
const WIDTHS = [72, 54, 64, 40, 58, 46, 68, 36];
const width = (i: number, scale = 1) => `${(WIDTHS[i % WIDTHS.length] as number) * scale}%`;

/** Lines inside a card that is still reading, under its real header: a label and a value each, like Facts. */
export function CardLinesSkeleton({ lines = 3, values = true, className }: { lines?: number; values?: boolean; className?: string }) {
  return (
    <div className={cn('grid gap-2.5 px-5 py-4', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Bar className="h-3" style={{ width: width(i, values ? 0.7 : 1) }} />
          {values && <Bar className="ml-auto h-3 w-14" />}
        </div>
      ))}
    </div>
  );
}

/** A whole card while it reads: a title, an icon and a few lines. */
export function CardSkeleton({ lines = 3, values = true, className, children }: { lines?: number; values?: boolean; className?: string; children?: ReactNode }) {
  return (
    <div className={cn('rounded-xl border bg-card shadow-xs', className)} aria-hidden>
      <div className="flex items-center justify-between border-b px-5 py-3.5">
        <Bar className="h-4 w-36" />
        <Bar className="size-4 rounded" />
      </div>
      {children ?? <CardLinesSkeleton lines={lines} values={values} />}
    </div>
  );
}

/** A table's shape: a header row and rows of cells. */
export function TableSkeleton({ columns = 4, rows = 6, className }: { columns?: number; rows?: number; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-xl border bg-card shadow-xs', className)} aria-hidden>
      <div className="flex gap-6 border-b bg-muted/40 px-4 py-3">
        {Array.from({ length: columns }, (_, c) => <Bar key={c} className={cn('h-3', c === 0 ? 'w-32' : 'w-16')} />)}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-6 border-b px-4 py-3 last:border-b-0">
          {Array.from({ length: columns }, (_, c) => (
            <Bar key={c} className={cn('h-3', c === 0 ? 'w-40' : 'w-16')} style={c === 0 ? { width: `${8 + ((r * 3) % 5) * 1.5}rem` } : undefined} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A log while it is read: lines of monospace text of different lengths. */
export function LogSkeleton({ lines = 10, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('grid gap-2 rounded-xl border bg-card px-4 py-4', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => <Bar key={i} className="h-2.5" style={{ width: width(i + 3) }} />)}
    </div>
  );
}

/** A page of cards while it reads: what is read, then cards in one or two columns. */
export function CardsSkeleton({ reading, cards = [4, 3, 5, 3], columns = 2, className }: { reading: ReactNode; cards?: number[]; columns?: 1 | 2; className?: string }) {
  return (
    <div className={cn('grid gap-4', className)} aria-busy="true">
      <Reading>{reading}</Reading>
      <div className={cn('grid grid-cols-[minmax(0,1fr)] gap-4', columns === 2 && 'lg:grid-cols-2')}>
        {cards.map((lines, i) => <CardSkeleton key={i} lines={lines} />)}
      </div>
    </div>
  );
}

/** A list of rows, each an icon, a line of text with a smaller one under it, and a value at the end: jobs, admins, sites. */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <ul className={cn('divide-y overflow-hidden rounded-xl border bg-card', className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-3">
          <Bar className="size-4 shrink-0 rounded-full" />
          <div className="grid flex-1 gap-1.5">
            <Bar className="h-3.5" style={{ width: width(i, 0.7) }} />
            <Bar className="h-2.5" style={{ width: width(i + 2, 0.4) }} />
          </div>
          <Bar className="h-3 w-16 shrink-0" />
        </li>
      ))}
    </ul>
  );
}

/** Form fields while their values load: a label and a box each. */
export function FieldsSkeleton({ fields = 4, className }: { fields?: number; className?: string }) {
  return (
    <div className={cn('grid gap-4', className)} aria-hidden>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="grid gap-1.5">
          <Bar className="h-3" style={{ width: `${5 + (i % 3) * 2}rem` }} />
          <Bar className={cn('w-full rounded-md', i % 3 === 2 ? 'h-20' : 'h-9')} />
        </div>
      ))}
    </div>
  );
}
