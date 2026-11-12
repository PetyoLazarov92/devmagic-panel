import { CircleArrowUp, FlaskConical, Globe, KeyRound, Layers, ListChecks, LogOut, Mail, Menu, PanelLeftClose, PanelLeftOpen, Search, Server, Settings, Sparkles, Wrench, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Logo } from '@/components/layout/logo';
import { ChangePasswordDialog } from '@/features/settings/panel-password';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Notice } from '@/components/ui/notice';
import { AssistantDrawer } from '@/features/assistant/assistant-drawer';
import { JobsIndicator } from '@/components/layout/jobs-indicator';
import { UpdateIndicator, updateDot, useUpdateStatus } from '@/components/layout/update-indicator';
import { QueuedProposals } from '@/features/assistant/queued-proposals';
import { api, DEMO_HOME, isDemo, isMockup } from '@/lib/api';
import { loadGitHosts } from '@/lib/git-hosts';
import { setAssistantOpen } from '@/lib/assistant';
import { useDeveloper, useVersionTaps } from '@/lib/developer';
import { useMailUnread } from '@/lib/mail-unread';
import { useHtaccessNotices } from '@/lib/htaccess-notices';
import { navActive } from '@/lib/nav';
import { loadPreferences, savePreferences, usePreferences } from '@/lib/preferences';
import { useAsync } from '@/lib/use-async';
import { Link } from '@/lib/router';
import { Toaster } from '@/lib/toast';
import { PAGE_MAX_WIDTH, pageWidth } from '@/lib/page-width';
import { cn } from '@/lib/utils';

interface NavItem {
  label: string;
  href: string;
  icon: typeof Globe;
  /** A short word on the right of the item, when nothing live replaces it. */
  hint?: string;
  /** Other addresses that belong to this item, like a job's page to Activity. */
  also?: string[];
}

/** The menu in three groups: what you use every day, the server's software, and the panel itself. */
const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: 'Work',
    items: [
      { label: 'Sites', href: '/sites', icon: Globe },
      { label: 'Aura', href: '/aura', icon: Sparkles, hint: 'sites + machine' },
      { label: 'Mail', href: '/mail', icon: Mail, hint: 'Mailpit' },
    ],
  },
  {
    group: 'Server',
    items: [
      { label: 'Services', href: '/services', icon: Server, hint: 'PHP, MySQL...' },
      { label: 'WP Cores', href: '/cores', icon: Layers, hint: 'releases' },
    ],
  },
  {
    group: 'System',
    items: [
      { label: 'Activity', href: '/activity', icon: ListChecks, hint: 'jobs + runs', also: ['/jobs', '/runs'] },
      { label: 'Updates', href: '/update', icon: CircleArrowUp },
      { label: 'Settings', href: '/settings', icon: Settings, hint: 'AI, password' },
    ],
  },
];

interface Props {
  path: string;
  user: string;
  version: string;
  onLogout: () => void;
  children: ReactNode;
  /** How many sites there are, for the menu; unknown until read. */
  siteCount?: number;
}

function openPalette() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
}

export function AppShell({ path, user, version, onLogout, children, siteCount }: Props) {
  const [changingPassword, setChangingPassword] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const rail = usePreferences().sidebar === 'rail';
  // A link in the drawer goes to its page and the drawer closes.
  useEffect(() => setMenuOpen(false), [path]);
  useSidebarShortcut();
  const assistant = useAsync(() => api.assistant(), []);
  // Signed in: the panel's preferences replace this browser's copy.
  useEffect(() => void loadPreferences(), []);
  useEffect(() => void loadGitHosts(), []);
  const assistantOn = assistant.data?.enabled === true;
  const developer = useDeveloper();
  const tapVersion = useVersionTaps();
  const update = useUpdateStatus();
  const dot = updateDot(update);
  const unread = useMailUnread(path);
  useHtaccessNotices();
  // A dot on a nav item says something waits there: a newer release, or mail nobody opened.
  const dots: Record<string, { tone: string; title: string } | null> = {
    '/update': dot ? { tone: dot === 'new' ? 'bg-primary' : 'bg-warning', title: dot === 'new' ? `${update?.latest ?? 'A new release'} available` : 'No access to updates' } : null,
    '/mail': unread ? { tone: 'bg-primary', title: unread === 1 ? '1 new message' : `${unread} new messages` } : null,
  };
  const groups = developer ? NAV.map((g) => (g.group === 'System' ? { ...g, items: [...g.items, { label: 'Developer', href: '/developer', icon: Wrench, hint: 'logs, build' }] } : g)) : NAV;
  // Live facts replace an item's hint: the sites there are, new mail, a newer release.
  const live: Record<string, string | undefined> = {
    '/sites': siteCount === undefined ? undefined : String(siteCount),
    '/mail': unread ? `${unread} new` : undefined,
    '/update': dot === 'new' ? (update?.latest ?? 'new') : undefined,
  };
  const body = (mode: 'full' | 'rail') => (
    <SidebarBody mode={mode} path={path} groups={groups} live={live} dots={dots} user={user} version={version} onTapVersion={tapVersion} onPassword={() => setChangingPassword(true)} onLogout={onLogout} />
  );
  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      {/* From md up: the sidebar, with its labels or folded to a rail of icons. Below md it is a drawer behind the menu button. */}
      <aside className={cn('sticky top-0 hidden h-svh shrink-0 flex-col border-r bg-card transition-[width] duration-150 md:flex', rail ? 'w-14' : 'w-60')}>
        {body(rail ? 'rail' : 'full')}
      </aside>
      <MobileNav open={menuOpen} onClose={() => setMenuOpen(false)}>{body('full')}</MobileNav>
      <ChangePasswordDialog open={changingPassword} onClose={() => setChangingPassword(false)} user={user} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The public demo says on every page what it is, since a link can open any of them first. */}
        {isDemo && (
          <Notice tone="warning" icon={false} className="rounded-none border-x-0 border-t-0 px-6 py-2 text-center md:px-10">
            A demo on made-up sample data: nothing you do here runs anywhere.{' '}
            <a href={DEMO_HOME} data-mockup-exit className="font-medium whitespace-nowrap underline underline-offset-2">
              Get devmagic-panel
            </a>
          </Notice>
        )}
        {/* The whole width on every page: the search on the left, what changes while you work on the right, the room between. */}
        <header className="flex w-full items-center gap-2 px-4 pt-4 sm:px-6 md:px-10">
          <IconButton icon={Menu} label="Open the menu" onClick={() => setMenuOpen(true)} className="shrink-0 md:hidden" aria-expanded={menuOpen} />
          {/* Drawn like a search field: it opens the command palette. */}
          <Button
            variant="outline"
            onClick={openPalette}
            className="min-w-0 flex-1 justify-start px-3 font-normal text-muted-foreground shadow-xs hover:bg-card hover:text-foreground sm:flex-[0_1_28rem]"
          >
            <Search />
            <span className="flex-1 truncate text-left">Search sites and actions</span>
            <kbd className="hidden rounded border bg-muted px-1.5 font-mono text-2xs sm:inline">Ctrl K</kbd>
          </Button>
          <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
            {/* On a phone the menu has these: the bar keeps what changes while you work. */}
            <div className="hidden items-center gap-2 md:flex">
              <UpdateIndicator status={update} />
            </div>
            <JobsIndicator />
            <QueuedProposals />
            <ThemeToggle className="hidden md:inline-flex" />
            {assistantOn && (
              <Button variant="outline" onClick={() => setAssistantOpen(true)} title="Ask Claude about your sites">
                <Sparkles />
                <span className="hidden sm:inline">Ask Claude</span>
              </Button>
            )}
          </div>
        </header>
        {/* The content's width follows the page type: wide lists, detail pages, narrow settings and flows. */}
        <main className={cn('@container mx-auto w-full flex-1 px-4 pb-12 sm:px-6 md:px-10', PAGE_MAX_WIDTH[pageWidth(path)])}>{children}</main>
        <Toaster />
        {assistantOn && <AssistantDrawer />}
      </div>
    </div>
  );
}

type Dots = Record<string, { tone: string; title: string } | null>;

/** Folds the sidebar to its rail and back, kept with your other preferences. */
export function toggleSidebar(current: 'full' | 'rail'): void {
  savePreferences({ sidebar: current === 'rail' ? 'full' : 'rail' });
}

/** Ctrl+B (Cmd+B on a Mac) folds the sidebar, except while you type: there it is bold, or the editor's own. */
function useSidebarShortcut() {
  const prefs = usePreferences();
  const sidebar = useRef(prefs.sidebar);
  sidebar.current = prefs.sidebar;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'b' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable], .cm-editor')) return;
      e.preventDefault();
      toggleSidebar(sidebar.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * What the sidebar holds: the logo, the menu and you. As a rail it shows the
 * icons only, each named in its tooltip and to screen readers, and a dot
 * where an item has news.
 */
function SidebarBody({ mode, path, groups, live, dots, user, version, onTapVersion, onPassword, onLogout }: {
  mode: 'full' | 'rail';
  path: string;
  groups: Array<{ group: string; items: NavItem[] }>;
  live: Record<string, string | undefined>;
  dots: Dots;
  user: string;
  version: string;
  onTapVersion: () => void;
  onPassword: () => void;
  onLogout: () => void;
}) {
  const rail = mode === 'rail';
  const fold = rail ? 'Show the menu labels' : 'Fold the menu to icons';
  const FoldIcon = rail ? PanelLeftOpen : PanelLeftClose;
  return (
    <>
      <div className={cn('flex items-center gap-2.5 py-4', rail ? 'justify-center px-2' : 'px-5')}>
        <Logo className="size-7 shrink-0" />
        {!rail && <span className="font-semibold tracking-tight whitespace-nowrap">devmagic-panel</span>}
      </div>
      {/* Only in the mockup: first, on its own, so it is the first thing you see. */}
      {isMockup && (
        <div className={rail ? 'px-2' : 'px-3'}>
          <Link
            href="/mockup"
            aria-current={path === '/mockup' ? 'page' : undefined}
            title={rail ? `${isDemo ? 'Demo' : 'Mockup'}: sample data` : undefined}
            className={cn('flex items-center gap-2.5 rounded-md bg-warning/12 py-1.5 text-sm font-medium whitespace-nowrap text-warning transition-colors hover:bg-warning/20', rail ? 'justify-center px-0' : 'px-2.5', path === '/mockup' && 'bg-warning/20')}
          >
            <FlaskConical className="size-4 shrink-0" />
            <span className={cn(rail && 'sr-only')}>{isDemo ? 'Demo' : 'Mockup'}</span>
            {!rail && <span className="ml-auto pl-2 text-2xs font-normal">sample data</span>}
          </Link>
        </div>
      )}
      <nav className={cn('flex flex-col overflow-y-auto', rail ? 'px-2' : 'px-3')} aria-label="Main">
        {groups.map(({ group, items }) => (
          <div key={group} role="group" aria-label={group} className="flex flex-col gap-0.5">
            {rail ? <div className="mx-2 mt-3 mb-1 border-t" aria-hidden /> : <p className="px-2.5 pt-3 pb-1 text-2xs font-medium text-muted-foreground/80">{group}</p>}
            {items.map((item) => {
              const { label, href, icon: Icon } = item;
              const active = navActive(item, path);
              const hint = live[href] ?? item.hint;
              const dot = dots[href];
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  title={rail ? [label, dot?.title ?? live[href]].filter(Boolean).join(': ') : undefined}
                  className={cn(
                    'relative flex items-center gap-2.5 rounded-md py-1.5 text-sm whitespace-nowrap transition-colors',
                    rail ? 'justify-center px-0' : 'px-2.5',
                    active ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className={cn(rail && 'sr-only')}>{label}</span>
                  {!rail && hint && <span className={cn('ml-auto truncate pl-2 text-2xs font-normal', live[href] && dot ? 'text-primary' : 'text-muted-foreground/80')}>{hint}</span>}
                  {!rail && !hint && dot && <span className={cn('ml-auto size-2 shrink-0 rounded-full', dot.tone)} title={dot.title} aria-label={dot.title} />}
                  {rail && dot && <span className={cn('absolute top-1 right-1.5 size-2 rounded-full ring-2 ring-card', dot.tone)} aria-label={dot.title} />}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className={cn('mt-auto flex gap-1 border-t py-3', rail ? 'flex-col items-center px-2' : 'items-center justify-between px-4')}>
        {!rail && (
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium">{user}</div>
            {/* Seven taps turn on the Developer options, like a phone's build number. */}
            <button type="button" onClick={onTapVersion} className="cursor-default text-muted-foreground select-none">v{version}</button>
          </div>
        )}
        <div className={cn('flex shrink-0', rail && 'flex-col items-center gap-1')}>
          <IconButton icon={KeyRound} label="Change the panel password" onClick={onPassword} />
          <IconButton icon={LogOut} label="Log out" onClick={onLogout} />
          {/* Folding is for the sidebar beside the page; the drawer on a phone has no rail. */}
          <IconButton icon={FoldIcon} label={fold} onClick={() => toggleSidebar(mode)} title={`${fold} (Ctrl+B)`} className="hidden md:inline-flex" />
        </div>
      </div>
    </>
  );
}

/**
 * The menu on a phone: the sidebar as a drawer from the left, a modal dialog
 * so focus stays in it and the page stays still; Escape, a tap beside it or
 * a link closes it. The theme switch lives here too, as the bar on top has
 * no room for it; Updates in the menu says when a release is out.
 */
function MobileNav({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label="Menu"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="m-0 h-dvh max-h-none w-72 max-w-[85vw] border-r bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/40 md:hidden"
    >
      {open && (
        <div className="relative flex h-full flex-col">
          <IconButton icon={X} label="Close the menu" onClick={onClose} className="absolute top-3 right-3" />
          {children}
          <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
            <ThemeToggle />
          </div>
        </div>
      )}
    </dialog>
  );
}
