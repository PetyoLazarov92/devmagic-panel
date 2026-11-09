import type { RepoPlacement } from '@devmagic-panel/shared';
import { cloneFolder, PLACEMENT_DIRS, placementWarnings, repoBaseName, repoTarget, siteDir, throughCoreLink } from '@devmagic-panel/shared';
import { CircleAlert, FolderTree, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Why a placement cannot be used as typed, or null. */
export function placementError(p: RepoPlacement): string | null {
  const dir = siteDir.safeParse(p.dir);
  if (!dir.success) return dir.error.issues[0]?.message ?? 'Not a folder of the site';
  const folder = cloneFolder.safeParse(p.folder);
  if (!folder.success) return folder.error.issues[0]?.message ?? 'Not a folder name';
  return null;
}

/**
 * Where a repo goes in the site: Install to (a folder of the site, with quick
 * picks) and Folder name (the folder it is cloned into there, empty for the
 * folder itself), with the final path and any advice. Nothing here refuses
 * core or uploads in a repo; only a shared core's links are a problem.
 */
export function PlacementFields({ url, value, onChange, site, sharedCore, problem }: {
  url: string;
  value: RepoPlacement;
  onChange: (p: RepoPlacement) => void;
  /** The site's address, for the path shown: local.spellbook.example. */
  site: string;
  /** The WordPress step links a shared core: a repo in its folders cannot work. */
  sharedCore: boolean;
  /** A clash with another repo of the install. */
  problem?: string | null;
}) {
  const id = useId();
  const quick = PLACEMENT_DIRS.some((d) => d.dir === value.dir);
  const [other, setOther] = useState(!quick);
  const target = repoTarget(value);
  const error = placementError(value);
  const warnings = error ? [] : placementWarnings(target);
  const coreLink = !error && sharedCore && throughCoreLink(target);
  const name = repoBaseName(url);
  const pick = (dir: string) => {
    setOther(false);
    // A repo moved out of the site root gets its own folder there, named after it.
    onChange({ dir, folder: value.folder || (dir === '' ? '' : name) });
  };
  const chip = (on: boolean) =>
    cn('rounded-md border px-2.5 py-1 text-xs whitespace-nowrap transition-colors hover:border-primary/50', on ? 'border-primary bg-primary/8 font-medium text-foreground' : 'bg-card text-muted-foreground');
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <span id={`${id}-to`} className="text-sm font-medium">Install to</span>
        <div role="radiogroup" aria-labelledby={`${id}-to`} className="flex flex-wrap gap-1.5">
          {PLACEMENT_DIRS.map((d) => (
            <button key={d.dir || 'root'} type="button" role="radio" aria-checked={!other && value.dir === d.dir} onClick={() => pick(d.dir)} className={chip(!other && value.dir === d.dir)}>
              {d.label}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={other} onClick={() => setOther(true)} className={chip(other)}>
            Other folder
          </button>
        </div>
        {other && (
          <Input
            aria-label="Folder of the site"
            value={value.dir}
            onChange={(e) => onChange({ ...value, dir: e.target.value.trim().replace(/^\/+|\/+$/g, '') })}
            placeholder="wp-content/client-plugins"
            className="font-mono text-[13px]"
            spellCheck={false}
          />
        )}
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-folder`} className="text-sm font-medium">Folder name</label>
        <Input
          id={`${id}-folder`}
          value={value.folder}
          onChange={(e) => onChange({ ...value, folder: e.target.value.trim() })}
          placeholder={value.dir === '' ? 'Empty: the repo is the site root' : `Empty: right into ${value.dir}`}
          className="font-mono text-[13px]"
          spellCheck={false}
        />
      </div>
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <FolderTree className="mt-px size-3.5 shrink-0" />
        <span className="font-mono break-all text-foreground">{site || 'the site'}/{target}</span>
        {!target && <span>(the site root)</span>}
      </p>
      {(error || problem) && (
        <p role="alert" className="flex items-start gap-2 text-xs text-danger"><CircleAlert className="mt-px size-3.5 shrink-0" />{error ?? problem}</p>
      )}
      {coreLink && (
        <p role="alert" className="flex items-start gap-2 text-xs text-danger">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          With a shared core, {target.split('/')[0]} is a link to the core every site uses. Pick WordPress from the repo or a download of its own on the WordPress step, or another folder.
        </p>
      )}
      {warnings.map((w) => (
        <p key={w} className="flex items-start gap-2 text-xs text-warning"><TriangleAlert className="mt-px size-3.5 shrink-0" />{w}.</p>
      ))}
    </div>
  );
}
