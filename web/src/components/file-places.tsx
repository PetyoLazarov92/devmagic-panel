import type { FileShortcut } from '@devmagic-panel/shared';
import { FileCode, FileText, FolderGit2, FolderOpen, Image, Palette, Plug } from 'lucide-react';
import { filesHref } from '@/lib/file-links';
import { placeFact } from '@/lib/file-places';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

type SiteId = { domain: string; path?: string };

const iconOf = (place: FileShortcut) =>
  place.path === 'wp-content/themes' ? Palette
  : place.path === 'wp-content/plugins' ? Plug
  : place.path === 'wp-content/uploads' ? Image
  : place.label.startsWith('Repo') ? FolderGit2
  : place.kind === 'file' ? (place.path.endsWith('.php') ? FileCode : FileText)
  : FolderOpen;

/**
 * The places of a site worth one click. At the site's folder they are tiles
 * with a fact each (how many plugins, how big debug.log is); in a folder
 * below, a slim row of the same, so the list stays near the top.
 */
export function FilePlaces({ site, places, dir }: { site: SiteId; places: FileShortcut[]; dir: string }) {
  if (places.length === 0) return null;
  const href = (p: FileShortcut) => filesHref(site, p.kind === 'dir' ? { dir: p.path } : { file: p.path });
  if (dir === '') {
    return (
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7" aria-label="Places of this site">
        {places.map((p) => {
          const Icon = iconOf(p);
          const fact = placeFact(p);
          return (
            <li key={p.path} className="min-w-0">
              <Link href={href(p)} className="group flex h-full min-w-0 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 transition-colors hover:border-primary/40 hover:bg-primary/5">
                <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary', fact?.warn && 'bg-warning/12 text-warning')}>
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="grid min-w-0">
                  <span className="truncate text-sm font-medium" title={p.label}>{p.label}</span>
                  {fact && <span className={cn('truncate text-xs text-muted-foreground', fact.warn && 'text-warning')}>{fact.text}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Places of this site">
      {places.map((p) => {
        const here = p.kind === 'dir' && p.path === dir;
        const Icon = iconOf(p);
        return (
          <li key={p.path}>
            <Link
              href={href(p)}
              aria-current={here ? 'page' : undefined}
              className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground', here && 'border-primary bg-primary/10 text-foreground')}
            >
              <Icon className="size-3" aria-hidden />
              {p.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
