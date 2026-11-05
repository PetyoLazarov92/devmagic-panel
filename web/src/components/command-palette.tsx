import type { InstallDraft, Site } from '@devmagic-panel/shared';
import { branchWebUrl, repoWeb } from '@devmagic-panel/shared';
import { Activity, CircleArrowUp, Code2, CornerDownLeft, ExternalLink, GitBranch, Globe, History, Layers, LogIn, Plus, Search, Server, Settings, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { openInVSCode, siteUrl } from '@/components/site-bits';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { setAssistantOpen } from '@/lib/assistant';
import { draftHref, draftProgress } from '@/lib/drafts';
import { navigate } from '@/lib/router';
import { openWpAdmin } from '@/lib/site-actions';
import { siteHref, siteName } from '@/lib/site-ref';
import { cn } from '@/lib/utils';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  group: string;
  run: () => void;
}

function branchCommand(site: Site): Command[] {
  const repos = [
    ...(site.git ? [{ label: siteName(site), git: site.git }] : []),
    ...(site.mounts ?? []).flatMap((m) => (m.git ? [{ label: `${site.domain}${m.path}`, git: m.git }] : [])),
  ];
  return repos.flatMap(({ label, git }): Command[] => {
    const web = git.remote ? repoWeb(git.remote) : null;
    const url = git.remote ? branchWebUrl(git.remote, git.branch) : null;
    if (!web || !url) return [];
    return [{ id: `branch:${label}`, label: `${label} branch on ${web.provider}`, hint: git.branch, icon: <GitBranch />, group: 'Open', run: () => window.open(url, '_blank', 'noopener') }];
  });
}

/** Ctrl+K / Cmd+K: jump to a site or page, or run a common action. */
export function CommandPalette({ sites }: { sites: Site[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [drafts, setDrafts] = useState<InstallDraft[]>([]);

  // Unfinished installs, read each time it opens: they change while you work.
  useEffect(() => {
    if (open) api.drafts().then(setDrafts, () => setDrafts([]));
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const commands = useMemo<Command[]>(() => {
    const pages: Command[] = [
      { id: 'ask', label: 'Ask Claude', hint: 'when the AI assistant is on', icon: <Sparkles />, group: 'Actions', run: () => setAssistantOpen(true) },
      { id: 'new', label: 'New site', icon: <Plus />, group: 'Actions', run: () => navigate('/sites/new') },
      ...drafts
        .filter((d) => d.status !== 'installing')
        .map((d): Command => {
          const p = draftProgress(d);
          return { id: `draft:${d.id}`, label: `Continue ${d.title || 'New site'}`, hint: `Step ${p.at} of ${p.total}: ${p.label}`, icon: <History />, group: 'Actions', run: () => navigate(draftHref(d.id, p.step)) };
        }),
      { id: 'sites', label: 'Sites', icon: <Globe />, group: 'Go to', run: () => navigate('/sites') },
      { id: 'aura', label: 'Aura', icon: <Sparkles />, group: 'Go to', run: () => navigate('/aura') },
      { id: 'cores', label: 'WordPress cores', icon: <Layers />, group: 'Go to', run: () => navigate('/cores') },
      { id: 'services', label: 'Services', icon: <Server />, group: 'Go to', run: () => navigate('/services') },
      { id: 'env', label: 'Environment', icon: <Activity />, group: 'Go to', run: () => navigate('/environment') },
      { id: 'env-settings', label: 'Settings', hint: 'AI assistant, Claude Code defaults', icon: <Settings />, group: 'Go to', run: () => navigate('/environment/settings') },
      { id: 'runs', label: 'Run history', icon: <History />, group: 'Go to', run: () => navigate('/runs') },
      { id: 'update', label: 'Updates', hint: 'new releases, changelogs, switch back', icon: <CircleArrowUp />, group: 'Go to', run: () => navigate('/update') },
    ];
    const perSite = sites.flatMap((s): Command[] => {
      const name = siteName(s);
      return [
        { id: `go:${name}`, label: name, hint: s.title ?? '', icon: <Globe />, group: 'Sites', run: () => navigate(siteHref(s)) },
        { id: `open:${name}`, label: `Open ${name}`, icon: <ExternalLink />, group: 'Open', run: () => window.open(siteUrl(s.domain, s.path), '_blank', 'noopener') },
        { id: `admin:${name}`, label: `wp-admin on ${name}`, icon: <LogIn />, group: 'Open', run: () => void openWpAdmin(s) },
        { id: `code:${name}`, label: `${name} in VS Code`, hint: s.docroot, icon: <Code2 />, group: 'Open', run: () => openInVSCode(s.docroot) },
        ...branchCommand(s),
      ];
    });
    return [...pages, ...perSite];
  }, [sites, drafts]);

  const q = query.trim().toLowerCase();
  const shown = (q ? commands.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q)) : commands.filter((c) => c.group !== 'Open')).slice(0, 12);

  useEffect(() => setActive(0), [query]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  function pick(c: Command | undefined) {
    if (!c) return;
    close();
    c.run();
  }

  let lastGroup = '';
  return (
    <Dialog open={open} onClose={close} title="Command palette" bare className="mt-[12vh] mb-auto w-[min(36rem,calc(100vw-2rem))]">
      <div className="flex items-center gap-2 border-b px-4">
        <Search className="size-4 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); pick(shown[active]); }
          }}
          placeholder="Jump to a site or run an action"
          aria-label="Search commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={shown[active] ? `cmd-${shown[active].id}` : undefined}
          className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <kbd className="rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">Esc</kbd>
      </div>
      <ul id="palette-list" role="listbox" className="max-h-80 overflow-auto p-1.5">
        {shown.map((c, i) => {
          const header = c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          return (
            <li key={c.id} role="presentation">
              {header && <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{header}</p>}
              <div
                id={`cmd-${c.id}`}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(c)}
                className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm [&_svg]:size-4 [&_svg]:text-muted-foreground', i === active && 'bg-muted')}
              >
                {c.icon}
                <span className="flex-1 truncate">{c.label}</span>
                {c.hint && <span className="truncate text-xs text-muted-foreground">{c.hint}</span>}
                {i === active && <CornerDownLeft className="size-3.5" />}
              </div>
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches.</li>}
      </ul>
    </Dialog>
  );
}
