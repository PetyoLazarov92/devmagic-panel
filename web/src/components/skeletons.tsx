import { RefreshCw } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A gray bar standing in for text or a control while it loads, as the Plugins tab draws them. */
function Bar({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cn('animate-pulse rounded bg-muted', className)} style={style} />;
}

/** What is being read, with a turning icon, for screen readers too. */
function Reading({ children }: { children: ReactNode }) {
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
        <div className="grid gap-4 lg:grid-cols-2">{[58, 46, 66, 40].map((w, i) => <SiteCardSkeleton key={i} width={w} />)}</div>
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
      <div className="grid gap-4 lg:grid-cols-2">
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
