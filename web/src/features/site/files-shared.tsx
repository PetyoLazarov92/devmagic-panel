import { type ActionId, type FileEntry, type FileGitState, type Site, nameOf } from '@devmagic-panel/shared';
import { ChevronRight, FolderOpen } from 'lucide-react';
import { Fragment } from 'react';
import { api, fileUrl, isMockup } from '@/lib/api';
import { filesHref } from '@/lib/file-links';
import { Link } from '@/lib/router';
import { lastLine } from '@/lib/output';
import { toast } from '@/lib/toast';

export type SiteId = Pick<Site, 'domain' | 'path'>;
export const CODE = /\.(php|js|jsx|ts|tsx|css|scss|json|html?|twig|xml|ya?ml|sh|sql|inc)$/i;
export const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|avif)$/i;

export const copyPath = (path: string) =>
  void navigator.clipboard?.writeText(path).then(
    () => toast({ tone: 'success', title: 'Path copied', detail: path }),
    () => toast({ tone: 'danger', title: 'The path could not be copied', detail: path }),
  );

export function download(site: SiteId, file: string) {
  if (isMockup) return toast({ tone: 'info', title: 'Mockup: this downloads the file' });
  const a = document.createElement('a');
  a.href = fileUrl(site.domain, file, site.path);
  a.download = nameOf(file);
  a.click();
}

export const siteInput = (site: SiteId) => ({ domain: site.domain, ...(site.path ? { path: site.path } : {}) });

/** Runs one of the Files actions; a refusal comes back as its message. */
export async function fileAction(site: SiteId, id: ActionId, input: Record<string, unknown>): Promise<{ ok: true; data?: { hash?: string; trashId?: string; warning?: string } } | { ok: false; error: string }> {
  try {
    const result = await api.runAction(id, { ...siteInput(site), ...input });
    return result.ok ? { ok: true, ...(result.data ? { data: result.data } : {}) } : { ok: false, error: lastLine(result.output) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Where you are: the site's folder, then each folder down to this one. */
export function Breadcrumb({ site, path }: { site: SiteId; path: string }) {
  const parts = path ? path.split('/') : [];
  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-sm">
      {parts.length === 0 ? (
        <span className="flex items-center gap-1.5 font-medium"><FolderOpen className="size-4 text-muted-foreground" aria-hidden />Site folder</span>
      ) : (
        <Link href={filesHref(site)} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"><FolderOpen className="size-4" aria-hidden />Site folder</Link>
      )}
      {parts.map((part, i) => {
        const here = parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        return (
          <Fragment key={here}>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            {last ? (
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]" aria-current="page">{part}</span>
            ) : (
              <Link href={filesHref(site, { dir: here })} className="text-muted-foreground [overflow-wrap:anywhere] hover:text-foreground">{part}</Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

export type SortKey = 'name' | 'size' | 'changed';
export interface Sort {
  key: SortKey;
  down: boolean;
}

export const isFolder = (e: FileEntry) => e.kind === 'dir' || (e.kind === 'link' && e.targetKind === 'dir');

/** What git says about an entry, in a word. Colour is never the only sign: each has its word. */
export const GIT_LABEL: Record<FileGitState, { text: string; tone: 'warning' | 'success' | 'danger' | 'primary'; title: string }> = {
  modified: { text: 'modified', tone: 'warning', title: 'Changed since the last commit' },
  new: { text: 'new', tone: 'success', title: 'Not in git yet' },
  added: { text: 'added', tone: 'success', title: 'New, and staged for the next commit' },
  renamed: { text: 'renamed', tone: 'primary', title: 'Renamed since the last commit' },
  deleted: { text: 'deleted', tone: 'danger', title: 'Deleted since the last commit' },
  conflict: { text: 'conflict', tone: 'danger', title: 'A merge left this file with both sides in it' },
};

export type Find = { q: string; where: 'name' | 'text' };
