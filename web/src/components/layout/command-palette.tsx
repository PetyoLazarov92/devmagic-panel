import type { ActionId, InstallDraft, Site } from '@devmagic-panel/shared';
import { branchWebUrl, repoWeb } from '@devmagic-panel/shared';
import { Activity, Archive, HeartPulse, KeyRound, Palette, CircleArrowUp, Code2, CornerDownLeft, ExternalLink, Folder, GitBranch, Globe, History, Layers, ListChecks, LogIn, Mail, Play, Plus, Search, Server, Settings, Sparkles, Wrench } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { openInVSCode, siteUrl } from '@/components/layout/site-bits';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { setAssistantOpen } from '@/lib/assistant';
import { draftHref, draftProgress } from '@/lib/drafts';
import { currentSite, paletteRuns } from '@/lib/palette';
import { filesHref } from '@/lib/file-links';
import { navigate, usePath } from '@/lib/router';
import { lastLine, openWpAdmin } from '@/lib/site-actions';
import { siteHref, siteName } from '@/lib/site-ref';
import { siteSections } from '@/lib/site-tabs';
import { SITE_TAB_ICONS } from '@/features/site/site-shared';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { reportModeEvent, speakModeWord, useActiveMode, useModeText, usePageName } from '@/lib/modes';

interface Command {
  id: string;
  label: string;
  hint?: string | undefined;
  icon: ReactNode;
  group: string;
  /** Asked in the palette before `run`. */
  confirm?: string | undefined;
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
    return [{ id: `branch:${label}`, label: `${label} branch on ${web.name}`, hint: git.branch, icon: <GitBranch />, group: 'Open', run: () => window.open(url, '_blank', 'noopener') }];
  });
}

/** Runs an action from the palette; the outcome is a toast, with the job one click away when it started one. */
async function runFromPalette(id: ActionId, input: Record<string, unknown>, label: string, restarts: boolean): Promise<void> {
  try {
    const result = await api.runAction(id, input);
    const jobId = result.data?.jobId;
    if (!result.ok) toast({ tone: 'danger', title: `${label} failed`, detail: lastLine(result.output) });
    else if (jobId) toast({ tone: 'info', title: `${label} started`, action: { label: 'Open job', run: () => navigate(`/jobs/${jobId}`) } });
    else toast({ tone: 'success', title: `${label}: done` });
  } catch (error) {
    toast(
      restarts && error instanceof TypeError
        ? { tone: 'info', title: `${label}: likely done`, detail: 'The connection dropped during the restart; the page answers again in a moment.' }
        : { tone: 'danger', title: `${label} failed`, detail: (error as Error).message },
    );
  }
}

/** The registry's palette entries as commands, under This site for the open site's. */
function actionCommands(sites: Site[], here: { domain: string; path?: string } | null): Command[] {
  return paletteRuns(sites, here).map((r) => ({
    id: `run:${r.key}`,
    label: r.label,
    hint: r.here ? r.site : undefined,
    icon: <Play />,
    group: r.here ? 'This site' : 'Run',
    confirm: r.entry.confirm,
    run: () => void runFromPalette(r.id, r.input, r.title, Boolean(r.entry.restarts)),
  }));
}

/** Ctrl+K / Cmd+K: jump to a site or page, or run a common action. */
export function CommandPalette({ sites }: { sites: Site[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [drafts, setDrafts] = useState<InstallDraft[]>([]);
  const [asking, setAsking] = useState<Command | null>(null);
  const path = usePath();
  const here = useMemo(() => currentSite(path), [path]);

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

  const name = usePageName();
  const text = useModeText();
  const { mode } = useActiveMode();
  const commands = useMemo<Command[]>(() => {
    // A page's name in the mode on screen, with the Classic one in the hint so typing either finds it.
    const page = (id: string, classic: string, hint: string | undefined, icon: ReactNode, href: string): Command => {
      const label = name(classic);
      return { id, label, hint: label === classic ? hint : [classic, hint].filter(Boolean).join(' · '), icon, group: 'Go to', run: () => navigate(href) };
    };
    const pages: Command[] = [
      { id: 'ask', label: 'Ask Claude', hint: 'when the AI assistant is on', icon: <Sparkles />, group: 'Actions', run: () => setAssistantOpen(true) },
      { id: 'new', label: text('newSite'), ...(text('newSite') !== 'New site' ? { hint: 'New site' } : {}), icon: <Plus />, group: 'Actions', run: () => navigate('/sites/new') },
      ...drafts
        .filter((d) => d.status !== 'installing')
        .map((d): Command => {
          const p = draftProgress(d);
          return { id: `draft:${d.id}`, label: `Continue ${d.title || 'New site'}`, hint: `Step ${p.at} of ${p.total}: ${p.label}`, icon: <History />, group: 'Actions', run: () => navigate(draftHref(d.id, p.step)) };
        }),
      page('sites', 'Sites', undefined, <Globe />, '/sites'),
      { id: 'aura', label: 'Aura', icon: <Sparkles />, group: 'Go to', run: () => navigate('/aura') },
      page('cores', 'WP Cores', 'WordPress releases', <Layers />, '/cores'),
      page('services', 'Services', undefined, <Server />, '/services'),
      { id: 'machine', label: 'Machine checks', hint: 'Aura: Apache, MySQL, PHP, tools', icon: <Activity />, group: 'Go to', run: () => navigate('/aura/machine') },
      page('settings', 'Settings', 'password, AI assistant, Claude Code defaults', <Settings />, '/settings'),
      page('modes', 'Modes', 'how the panel looks: themes and effects', <Palette />, '/modes'),
      { id: 'password', label: 'Change the panel password', hint: 'on Settings', icon: <KeyRound />, group: 'Actions', run: () => navigate('/settings') },
      { id: 'sanctum', label: 'Sanctum', hint: 'the panel: programs running, background tasks, storage', icon: <HeartPulse />, group: 'Go to', run: () => navigate('/sanctum') },
      page('activity', 'Activity', 'jobs since the panel started', <ListChecks />, '/activity'),
      { id: 'runs', label: 'Run history', hint: 'every action with its output', icon: <History />, group: 'Go to', run: () => navigate('/activity/runs') },
      page('mail', 'Mail', 'what Mailpit caught', <Mail />, '/mail'),
      { id: 'removed', label: 'Removed sites', hint: 'kept 14 days, to restore', icon: <Archive />, group: 'Go to', run: () => navigate('/sites?show=removed') },
      page('developer', 'Developer options', undefined, <Wrench />, '/developer'),
      page('update', 'Updates', 'new releases, changelogs, switch back', <CircleArrowUp />, '/update'),
    ];
    const perSite = sites.flatMap((s): Command[] => {
      const name = siteName(s);
      return [
        { id: `go:${name}`, label: name, hint: s.title ?? '', icon: <Globe />, group: 'Sites', run: () => navigate(siteHref(s)) },
        { id: `open:${name}`, label: `Open ${name}`, icon: <ExternalLink />, group: 'Open', run: () => window.open(siteUrl(s.domain, s.path), '_blank', 'noopener') },
        { id: `admin:${name}`, label: `wp-admin on ${name}`, icon: <LogIn />, group: 'Open', run: () => void openWpAdmin(s) },
        { id: `files:${name}`, label: `Files of ${name}`, hint: s.docroot, icon: <Folder />, group: 'Open', run: () => navigate(filesHref(s)) },
        { id: `code:${name}`, label: `${name} in VS Code`, hint: s.docroot, icon: <Code2 />, group: 'Open', run: () => openInVSCode(s.docroot) },
        ...branchCommand(s),
      ];
    });
    // The open site's tabs and views first; every other site's are found by typing, as "shop SQL".
    const sections = sites.flatMap((s): Command[] => {
      const isHere = Boolean(here && s.domain === here.domain && (s.path ?? '') === (here.path ?? ''));
      const name = siteName(s);
      return siteSections(s).map((sec) => {
        const Icon = SITE_TAB_ICONS[sec.tab];
        return {
          id: `section:${name}:${sec.tab}:${sec.view ?? ''}`,
          label: isHere ? sec.label : `${name}: ${sec.label}`,
          icon: <Icon />,
          group: isHere ? 'Sections' : 'Sections of other sites',
          run: () => navigate(sec.href),
        };
      });
    });
    const run = actionCommands(sites, here);
    return [...sections.filter((c) => c.group === 'Sections'), ...run.filter((c) => c.group === 'This site'), ...pages, ...perSite, ...run.filter((c) => c.group !== 'This site'), ...sections.filter((c) => c.group !== 'Sections')];
    // With the mode: the pages' names change with it.
  }, [sites, drafts, here, mode]);

  const q = query.trim().toLowerCase();
  // With nothing typed: the open site's tabs and views and its first few actions, then the pages; typing searches everything, every word in any order.
  const words = q.split(/\s+/).filter(Boolean);
  const shown = (
    q
      ? commands.filter((c) => {
          const text = `${c.label} ${c.hint ?? ''}`.toLowerCase();
          return words.every((w) => text.includes(w));
        })
      : [
          ...commands.filter((c) => c.group === 'Sections'),
          ...commands.filter((c) => c.group === 'This site').slice(0, 4),
          ...commands.filter((c) => !['Open', 'Run', 'This site', 'Sections', 'Sections of other sites'].includes(c.group)),
        ]
  ).slice(0, here ? 30 : 12);

  useEffect(() => setActive(0), [query]);
  // The arrows move past what the list shows: keep the chosen one in view, its group heading too at the top.
  const activeId = shown[active]?.id;
  useEffect(() => {
    if (!open || !activeId) return;
    const option = document.getElementById(`cmd-${activeId}`);
    if (active === 0) document.getElementById('palette-list')?.scrollTo({ top: 0 });
    else (option?.parentElement ?? option)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeId, active]);

  function close() {
    setOpen(false);
    setQuery('');
    setAsking(null);
  }

  function pick(c: Command | undefined) {
    if (!c) return;
    if (c.confirm && asking !== c) {
      setAsking(c);
      return;
    }
    close();
    c.run();
    reportModeEvent('paletteCommand');
  }

  /** Enter with nothing to pick: a single word typed might be one the panel listens for. */
  async function speak() {
    const word = query.trim();
    if (!/^[a-z]{3,20}$/i.test(word)) return;
    const unlocked = await speakModeWord(word);
    if (unlocked) {
      close();
      toast({ tone: 'info', title: 'Something stirred' });
    }
  }

  let lastGroup = '';
  return (
    <Dialog open={open} onClose={close} title="Command palette" bare className="mt-[12vh] mb-auto">
      {asking ? (
        <div
          className="grid gap-3 p-5"
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); pick(asking); }
          }}
        >
          <p className="text-base font-semibold">{asking.label}?</p>
          <p className="text-sm text-muted-foreground">{asking.confirm}</p>
          <div className="flex justify-end gap-2">
            <Button variant="soft" onClick={() => setAsking(null)}>Cancel</Button>
            <Button autoFocus onClick={() => pick(asking)}>{asking.label}</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b px-4">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) pick(shown[active]); else void speak(); }
              }}
              placeholder={text('palette')}
              aria-label="Search commands"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={shown[active] ? `cmd-${shown[active].id}` : undefined}
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded border bg-muted px-1.5 font-mono text-2xs text-muted-foreground">Esc</kbd>
          </div>
          <ul id="palette-list" role="listbox" className="max-h-80 overflow-auto p-1.5">
            {shown.map((c, i) => {
              const header = c.group !== lastGroup ? c.group : null;
              lastGroup = c.group;
              return (
                <li key={c.id} role="presentation">
                  {header && <p className="px-2.5 pt-2 pb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">{header}</p>}
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
        </>
      )}
    </Dialog>
  );
}
