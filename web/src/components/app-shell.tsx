import { Activity, ArchiveRestore, CircleArrowUp, Globe, History, KeyRound, Layers, LogOut, Mail, Search, Server, Sparkles, Wrench } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Logo } from '@/components/logo';
import { ChangePasswordDialog } from '@/components/panel-password';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { AssistantDrawer } from '@/components/assistant-drawer';
import { JobsIndicator } from '@/components/jobs-indicator';
import { UpdateIndicator, updateDot, useUpdateStatus } from '@/components/update-indicator';
import { QueuedProposals } from '@/components/queued-proposals';
import { api, isMockup } from '@/lib/api';
import { loadGitHosts } from '@/lib/git-hosts';
import { setAssistantOpen } from '@/lib/assistant';
import { useDeveloper, useVersionTaps } from '@/lib/developer';
import { useMailUnread } from '@/lib/mail-unread';
import { loadPreferences } from '@/lib/preferences';
import { useAsync } from '@/lib/use-async';
import { Link } from '@/lib/router';
import { Toaster } from '@/lib/toast';
import { cn } from '@/lib/utils';

const nav = [
  { label: 'Sites', href: '/sites', icon: Globe },
  { label: 'Aura', href: '/aura', icon: Sparkles },
  { label: 'WordPress', href: '/cores', icon: Layers },
  { label: 'Services', href: '/services', icon: Server },
  { label: 'Mail', href: '/mail', icon: Mail },
  { label: 'Environment', href: '/environment', icon: Activity },
  { label: 'Run history', href: '/runs', icon: History },
  { label: 'Archive', href: '/trash', icon: ArchiveRestore },
  { label: 'Updates', href: '/update', icon: CircleArrowUp },
];

interface Props {
  path: string;
  user: string;
  version: string;
  onLogout: () => void;
  children: ReactNode;
}

function openPalette() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
}

export function AppShell({ path, user, version, onLogout, children }: Props) {
  const [changingPassword, setChangingPassword] = useState(false);
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
  // A dot on a nav item says something waits there: a newer release, or mail nobody opened.
  const dots: Record<string, { tone: string; title: string } | null> = {
    '/update': dot ? { tone: dot === 'new' ? 'bg-primary' : 'bg-warning', title: dot === 'new' ? `${update?.latest ?? 'A new release'} available` : 'No access to updates' } : null,
    '/mail': unread ? { tone: 'bg-primary', title: unread === 1 ? '1 new message' : `${unread} new messages` } : null,
  };
  const items = developer ? [...nav, { label: 'Developer', href: '/developer', icon: Wrench }] : nav;
  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b bg-card md:sticky md:top-0 md:h-svh md:w-60 md:border-r md:border-b-0">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <Logo className="size-7" />
          <span className="font-semibold tracking-tight whitespace-nowrap">devmagic-panel</span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:pb-0" aria-label="Main">
          {items.map(({ label, href, icon: Icon }) => {
            const active = path === href || path.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors',
                  active ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="size-4" />
                {label}
                {dots[href] && <span className={cn('ml-auto size-2 shrink-0 rounded-full', dots[href]?.tone)} title={dots[href]?.title} aria-label={dots[href]?.title} />}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto hidden items-center justify-between gap-2 border-t px-4 py-3 md:flex">
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium">{user}</div>
            {/* Seven taps turn on the Developer options, like a phone's build number. */}
            <button type="button" onClick={tapVersion} className="cursor-default text-muted-foreground select-none">v{version}</button>
          </div>
          <div className="flex shrink-0">
            <Button variant="ghost" size="icon" onClick={() => setChangingPassword(true)} title="Change the panel password">
              <KeyRound />
              <span className="sr-only">Change the panel password</span>
            </Button>
            <Button variant="ghost" size="icon" onClick={onLogout} title="Log out">
              <LogOut />
              <span className="sr-only">Log out</span>
            </Button>
          </div>
        </div>
        <ChangePasswordDialog open={changingPassword} onClose={() => setChangingPassword(false)} user={user} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Lined up with the page below: the search centered over it while the indicators on the right leave room, else just left of them. */}
        <header className="mx-auto flex w-full max-w-7xl items-center gap-2 px-6 pt-4 md:px-10">
          <div className="hidden min-w-0 flex-1 basis-0 sm:block">
            {isMockup && (
              <span className="rounded-md bg-warning/15 px-2 py-1 text-xs font-medium text-warning" title="Sample data, nothing changes on this machine">
                Mockup: sample data
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={openPalette}
            className="inline-flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border bg-card px-3 text-sm text-muted-foreground shadow-xs transition-colors hover:text-foreground sm:flex-[0_1_28rem]"
          >
            <Search className="size-4 shrink-0" />
            <span className="flex-1 truncate text-left">Search sites and actions</span>
            <kbd className="hidden rounded border bg-muted px-1.5 font-mono text-[10px] sm:inline">Ctrl K</kbd>
          </button>
          <div className="flex items-center justify-end gap-2 sm:flex-1 sm:basis-0">
            <UpdateIndicator status={update} />
            <JobsIndicator />
            <ThemeToggle />
            {assistantOn && (
              <Button variant="outline" onClick={() => setAssistantOpen(true)} title="Ask Claude about your sites">
                <Sparkles />
                <span className="hidden sm:inline">Ask Claude</span>
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={onLogout} title="Log out" className="md:hidden">
              <LogOut />
              <span className="sr-only">Log out</span>
            </Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-6 pb-12 md:px-10">{children}</main>
        <Toaster />
        {assistantOn && <AssistantDrawer />}
        <QueuedProposals />
      </div>
    </div>
  );
}
