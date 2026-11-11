import type { GitDetails, GitPullRequest as PullRequest } from '@devmagic-panel/shared';
import { fuzzyMatch } from '@devmagic-panel/shared';
import { Check, ChevronDown, GitPullRequest, GitPullRequestDraft } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Branch = GitDetails['branches'][number];

const SHOWN = 60;

/** The matched characters of a name in bold. */
function Highlight({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const set = new Set(positions);
  return <>{[...text].map((ch, i) => (set.has(i) ? <mark key={i} className="bg-transparent font-semibold text-primary">{ch}</mark> : ch))}</>;
}

/** A branch's open pull request (GitHub, #12) or merge request (GitLab, !12), linked in a new tab; with its title where there is room. Drafts are grey. */
export function PullBadge({ pull, withTitle = false }: { pull: PullRequest; withTitle?: boolean }) {
  const merge = pull.kind === 'merge';
  const ref = `${merge ? '!' : '#'}${pull.number}`;
  const what = merge ? 'merge request' : 'pull request';
  const label = `${pull.draft ? `Draft ${what}` : what[0]?.toUpperCase() + what.slice(1)} ${ref}: ${pull.title}`;
  const Icon = pull.draft ? GitPullRequestDraft : GitPullRequest;
  return (
    <a
      href={pull.url}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={`${label}, opens on ${merge ? 'GitLab' : 'GitHub'}`}
      // Opens the pull request without picking the branch in the list around it.
      onClick={(e) => e.stopPropagation()}
      className="inline-flex max-w-full min-w-0 shrink-0 rounded-full font-sans hover:underline"
    >
      <Badge tone={pull.draft ? 'neutral' : 'success'} className={cn('max-w-full min-w-0', withTitle ? 'px-2' : 'px-1.5')}>
        <Icon className="size-3 shrink-0" />
        <span className="shrink-0">{ref}</span>
        {withTitle && <span className="truncate">{pull.title}</span>}
        {/* In the branch list the draft icon and grey are the marker, to leave room for the name. */}
        {pull.draft && withTitle && <span className="shrink-0 font-normal">draft</span>}
      </Badge>
    </a>
  );
}

/**
 * Pick a branch by typing any characters of its name in order: "tsedit" finds
 * feature/ts-editor. Local branches first, then those only on origin. Arrow
 * keys move, Enter picks, Escape closes.
 */
export function BranchPicker({ id, branches, pulls, value, onChange, disabled, currentLabel = 'current' }: {
  id: string;
  branches: Branch[];
  /** Open pull requests by branch name, marked next to their branch (not the marked one). */
  pulls?: ReadonlyMap<string, PullRequest>;
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  /** What the marked branch is called: the checked-out one on a site, the default one for a new site. */
  currentLabel?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const matches = useMemo(() => {
    const scored = branches.flatMap((b) => {
      const m = fuzzyMatch(query, b.name);
      return m ? [{ branch: b, ...m }] : [];
    });
    // Best fit first within each group; with no query, the order git gave stays.
    const order = (a: (typeof scored)[number], b: (typeof scored)[number]) => Number(a.branch.remoteOnly) - Number(b.branch.remoteOnly) || (query ? b.score - a.score : 0);
    return scored.sort(order);
  }, [branches, query]);
  const shown = matches.slice(0, SHOWN);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function pick(name: string) {
    onChange(name);
    setQuery('');
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && open && shown[active]) {
      e.preventDefault();
      pick(shown[active].branch.name);
    } else if (e.key === 'Escape') {
      setQuery('');
      setOpen(false);
    }
  }

  return (
    <div ref={box} className="relative">
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        value={open ? query : value}
        placeholder={open ? `Search ${branches.length} branches` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // After a pick the field keeps focus, so focus alone would not open it again: a click does.
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        className="h-10 w-full rounded-md border border-input bg-card pr-9 pl-3 font-mono text-dense shadow-xs focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none disabled:opacity-60"
      />
      <Button
        variant="ghost"
        size="icon"
        tabIndex={-1}
        aria-label={open ? 'Close the branch list' : 'Open the branch list'}
        disabled={disabled}
        // Keeps the focus in the field, so typing goes on there.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) {
            setQuery('');
            setOpen(false);
          } else {
            setOpen(true);
            document.getElementById(id)?.focus();
          }
        }}
        className="absolute inset-y-0 right-0 h-auto w-9 rounded-l-none text-muted-foreground hover:bg-transparent disabled:opacity-60"
      >
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <ul ref={list} id={listId} role="listbox" className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-card py-1 text-sm shadow-lg">
          {shown.length === 0 && <li className="px-3 py-2 text-muted-foreground">No branch matches "{query}"</li>}
          {shown.map((m, i) => {
            const groupStart = i === 0 || shown[i - 1]?.branch.remoteOnly !== m.branch.remoteOnly;
            // The checked-out branch's pull request is shown with its title above the picker, so its row keeps room for the name.
            const pull = m.branch.current ? undefined : pulls?.get(m.branch.name);
            return (
              <li key={m.branch.name} role="presentation">
                {groupStart && <p className="px-3 pt-1.5 pb-1 text-2xs font-medium text-muted-foreground uppercase">{m.branch.remoteOnly ? 'Only on origin' : 'Branches'}</p>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={m.branch.name === value}
                  data-index={i}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(m.branch.name)}
                  className={cn('flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-dense', i === active && 'bg-muted')}
                >
                  <span className="min-w-0 flex-1 truncate" title={m.branch.name}><Highlight text={m.branch.name} positions={m.positions} /></span>
                  {pull && <PullBadge pull={pull} />}
                  {m.branch.current && <span className="text-xs text-muted-foreground">{currentLabel}</span>}
                  {m.branch.name === value && <Check className="size-3.5 text-primary" />}
                </div>
              </li>
            );
          })}
          {matches.length > SHOWN && <li className="px-3 py-1.5 text-xs text-muted-foreground">{matches.length - SHOWN} more: keep typing to narrow down</li>}
        </ul>
      )}
    </div>
  );
}
