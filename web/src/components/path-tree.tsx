import type { FolderListing } from '@devmagic-panel/shared';
import { ChevronRight, File, Folder, FolderOpen, Link2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { childRows, foldersShowingAll, type ListedPath, topRows, type TreeNode } from '@/lib/path-tree';
import { cn } from '@/lib/utils';

const items = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'item' : 'items'}`;

/**
 * A file list of the Developer options as folders that start closed. Opening
 * one reads what it holds on disk (names and sizes, never contents), with any
 * folders in it closed again. The paths the list names keep their notes and,
 * given `badge`, what uninstall does with them.
 */
export function PathTree({ listed, badge }: { listed: ListedPath[]; badge?: (l: ListedPath) => ReactNode }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState<ReadonlyMap<string, FolderListing | 'loading'>>(new Map());

  function load(paths: string[]) {
    const missing = paths.filter((p) => !loaded.has(p));
    if (missing.length === 0) return;
    setLoaded((m) => new Map([...m, ...missing.map((p) => [p, 'loading'] as const)]));
    for (const path of missing) {
      api.developerFolder(path).then(
        (listing) => setLoaded((m) => new Map(m).set(path, listing)),
        (err: Error) => setLoaded((m) => new Map(m).set(path, { path, entries: [], more: 0, error: err.message })),
      );
    }
  }
  function toggle(path: string) {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      load([path]);
    }
    setOpen(next);
  }
  function expandAll() {
    const all = foldersShowingAll(listed);
    setOpen(new Set(all));
    load(all);
  }

  const columns = badge ? 4 : 3;
  const note = (key: string, depth: number, text: string) => (
    <tr key={key}>
      <td colSpan={columns} className="px-5 py-1.5 text-xs text-muted-foreground">
        <span style={{ paddingLeft: `${depth * 1.125 + 1.25}rem` }}>{text}</span>
      </td>
    </tr>
  );

  function rows(nodes: TreeNode[], depth: number): ReactNode[] {
    return nodes.flatMap((node) => {
      const isOpen = node.folder && open.has(node.path);
      const state = loaded.get(node.path);
      const listing = state && state !== 'loading' ? state : undefined;
      const l = node.listed;
      const Icon = node.folder ? (isOpen ? FolderOpen : Folder) : node.entry?.kind === 'link' || l?.kind === 'link' ? Link2 : File;
      const size = l?.sizeBytes ?? node.entry?.sizeBytes;
      const sub = [
        l ? `${l.kind}${l.exists ? '' : ', not there any more'}` : null,
        node.entry?.kind === 'link' && node.entry.target ? `points to ${node.entry.target}` : null,
        listing && !listing.error ? items(listing.entries.length + listing.more) : null,
      ].filter(Boolean);
      const name = (
        <>
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="font-mono text-dense break-all">{node.name}</span>
        </>
      );
      const out: ReactNode[] = [
        <tr key={node.path} className={cn(l && !l.exists && 'text-muted-foreground')}>
          <td className="px-5 py-1.5 align-top">
            <div className="flex items-start gap-1" style={{ paddingLeft: `${depth * 1.125}rem` }}>
              {node.folder ? (
                <button type="button" aria-expanded={isOpen} onClick={() => toggle(node.path)} className="flex min-w-0 items-start gap-1 rounded text-left hover:text-primary">
                  <ChevronRight className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                  {name}
                </button>
              ) : (
                <span className="flex min-w-0 items-start gap-1 pl-5">{name}</span>
              )}
            </div>
            {sub.length > 0 && <span className="block text-xs text-muted-foreground" style={{ paddingLeft: `${depth * 1.125 + 2.5}rem` }}>{sub.join(' · ')}</span>}
          </td>
          <td className="px-3 py-1.5 align-top">{l?.note}</td>
          {badge && <td className="px-3 py-1.5 align-top">{l ? badge(l) : null}</td>}
          <td className="px-5 py-1.5 text-right align-top whitespace-nowrap tabular-nums text-muted-foreground">{size !== undefined ? bytes(size) : ''}</td>
        </tr>,
      ];
      if (!isOpen) return out;
      const children = childRows(node.path, listed, listing);
      if (state === 'loading') out.push(note(`${node.path}:reading`, depth + 1, 'Reading...'));
      if (listing?.error) out.push(note(`${node.path}:error`, depth + 1, `${listing.error[0]?.toUpperCase()}${listing.error.slice(1)}.`));
      out.push(...rows(children, depth + 1));
      if (listing?.more) out.push(note(`${node.path}:more`, depth + 1, `And ${listing.more.toLocaleString()} more, not shown.`));
      if (listing && !listing.error && children.length === 0) out.push(note(`${node.path}:empty`, depth + 1, 'Empty.'));
      return out;
    });
  }

  return (
    <>
      <div className="flex justify-end gap-1 border-b px-3 py-1.5">
        <Button size="sm" variant="soft" onClick={expandAll}>Expand all</Button>
        <Button size="sm" variant="soft" disabled={open.size === 0} onClick={() => setOpen(new Set())}>Collapse all</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-2.5 font-medium">Path</th>
              <th className="px-3 py-2.5 font-medium">What it is</th>
              {badge && <th className="px-3 py-2.5 font-medium">On uninstall</th>}
              <th className="px-5 py-2.5 text-right font-medium">Size</th>
            </tr>
          </thead>
          <tbody className="divide-y">{rows(topRows(listed), 0)}</tbody>
        </table>
      </div>
    </>
  );
}
