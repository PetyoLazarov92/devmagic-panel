import { type FileMatch, type Site } from '@devmagic-panel/shared';
import { FileText, Folder, Search, X } from 'lucide-react';
import { Fragment, useMemo } from 'react';
import { EmptyState, Notice } from '@/components/layout/page';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextLink } from '@/components/ui/text-link';
import { api } from '@/lib/api';
import { filesHref } from '@/lib/file-links';
import { Link, navigate } from '@/lib/router';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { type Find } from './files-shared';

/** A line of a file with each place the text was found marked. */
export function Marked({ text, q }: { text: string; q: string }) {
  const parts: Array<{ text: string; hit: boolean }> = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); needle && i >= 0; i = lower.indexOf(needle, at)) {
    if (i > at) parts.push({ text: text.slice(at, i), hit: false });
    parts.push({ text: text.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return <>{parts.map((p, i) => (p.hit ? <mark key={i} className="rounded-xs bg-warning/30 text-foreground">{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>))}</>;
}

/** What a search under a folder found, in the folder's place: names, or the lines of text files, file by file. */
export function FindResults({ site, dir, find }: { site: Site; dir: string; find: Find }) {
  const key = `${site.domain}${site.path ?? ''}|${dir}|${find.where}|${find.q}`;
  const { data, error, loading, reload } = useAsync(async () => ({ key, result: await api.fileFind(site.domain, dir, find.q, find.where, site.path) }), [key]);
  const result = data?.key === key ? data.result : undefined;
  const short = (path: string) => (dir ? path.slice(dir.length + 1) : path);
  const groups = useMemo(() => {
    const byFile = new Map<string, FileMatch[]>();
    for (const m of result?.matches ?? []) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m]);
    return [...byFile];
  }, [result]);
  const place = dir || 'the site folder';
  return (
    <section aria-label="Search results" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-sm" role="status">
          {loading && !result ? (
            <span className="inline-flex items-center gap-2 text-muted-foreground"><Spinner className="size-4" />Looking in {place}</span>
          ) : result ? (
            <>
              <span className="font-medium">{find.where === 'text' ? `${result.matches.length} ${result.matches.length === 1 ? 'line' : 'lines'} in ${groups.length} ${groups.length === 1 ? 'file' : 'files'}` : `${result.matches.length} ${result.matches.length === 1 ? 'name' : 'names'}`}</span>
              <span className="text-muted-foreground"> with <span className="font-mono text-foreground">{find.q}</span> in {place}{result.more ? ', and more that are not listed: look in a folder further down, or for a longer text' : ''}.</span>
            </>
          ) : null}
        </p>
        <span className="ml-auto flex gap-2">
          {result && <Button size="sm" variant="soft" disabled={loading} onClick={reload}>Look again</Button>}
          <ButtonLink size="sm" variant="outline" href={filesHref(site, { dir })} onClick={(e) => (e.preventDefault(), navigate(filesHref(site, { dir }), { scroll: false }))}><X />Back to the folder</ButtonLink>
        </span>
      </div>
      {error && !loading && <Notice>{error}</Notice>}
      {result && result.matches.length === 0 && (
        <EmptyState icon={Search} title={find.where === 'text' ? 'No file here has that text' : 'Nothing here by that name'}>
          {find.where === 'text' ? 'Text files are read whatever the case of the letters. .git, node_modules and minified files are left out.' : 'Names are matched whatever the case of the letters. What is inside .git and node_modules is left out.'}
        </EmptyState>
      )}
      {result && result.matches.length > 0 && (
        <Card className={cn('overflow-hidden', loading && 'opacity-70')}>
          <ul className="divide-y text-sm">
            {groups.map(([path, matches]) => {
              const folder = matches[0]?.kind === 'dir';
              return (
                <li key={path} className="px-4 py-2">
                  <TextLink href={folder ? filesHref(site, { dir: path }) : filesHref(site, { file: path })} tone="plain" className="flex min-w-0 gap-2.5 font-medium">
                    {folder ? <Folder className="size-4 shrink-0 text-primary" aria-hidden /> : <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                    <span className="min-w-0 [overflow-wrap:anywhere]">{find.where === 'name' ? <Marked text={short(path)} q={find.q} /> : short(path)}</span>
                  </TextLink>
                  {find.where === 'text' && (
                    <ul className="mt-1 grid gap-0.5 pl-6.5">
                      {matches.map((m) => (
                        <li key={m.line}>
                          <Link href={filesHref(site, { file: path, ...(m.line ? { line: m.line } : {}) })} className="flex min-w-0 gap-3 rounded px-1 font-mono text-xs leading-5 hover:bg-muted">
                            <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">{m.line}</span>
                            <span className="min-w-0 truncate"><Marked text={m.text ?? ''} q={find.q} /></span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}
