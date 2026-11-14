import type { SessionInfo } from '@devmagic-panel/shared';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { CommandPalette } from '@/components/layout/command-palette';
import { SessionDialog } from '@/components/layout/session-dialog';
import { StartingScreen } from '@/components/layout/starting-screen';
import { Button } from '@/components/ui/button';
import { api, isMockup } from '@/lib/api';
import { useApplyMode } from '@/lib/modes';
import { movedTo } from '@/lib/moved';
import { notePanelVersion } from '@/lib/restart';
import { match, navigate, usePath } from '@/lib/router';
import { isSessionLost, listenToOtherTabs, onSessionChange, sessionBack, sessionLost, startSessionWatch, tellOtherTabs } from '@/lib/session-watch';
import { type PanelStart, retryOnWake, startPanel } from '@/lib/startup';
import { useAsync } from '@/lib/use-async';
import { ActivityPage } from '@/pages/activity';
import { AuraPage } from '@/pages/aura';
import { CoresPage } from '@/pages/cores';
import { DeveloperPage } from '@/pages/developer';
import { JobPage } from '@/pages/job';
import { LoginPage, RESET_PATH } from '@/pages/login';
import { MailPage } from '@/pages/mail';
import { MockupPage } from '@/pages/mockup';
import { ModesPage } from '@/pages/modes';
import { UiKitPage } from '@/pages/ui-kit';
import { NewSitePage } from '@/pages/new-site';
import { RunPage } from '@/pages/run';
import { phpSectionOf, ServicesPage } from '@/pages/services';
import { SettingsPage } from '@/pages/settings';
import { SanctumPage } from '@/pages/sanctum';
import { SiteDetailPage } from '@/pages/site';
import { SitesPage } from '@/pages/sites';
import { UpdatePage } from '@/pages/update';
import { Spinner } from '@/components/ui/spinner';
import { ModeDefs } from '@/features/modes/mode-defs';

type Session = SessionInfo & { setupRequired: boolean };

function Routes({ path }: { path: string }) {
  if (path === '/sites/new') return <NewSitePage />;
  // An install draft, and the step it is on: /sites/new/<draft>/domains. Before /sites/:domain/:path, which it would match.
  const draft = match('/sites/new/:draft/:step', path) ?? match('/sites/new/:draft', path);
  if (draft?.draft) return <NewSitePage draft={draft.draft} {...(draft.step ? { step: draft.step } : {})} />;
  const site = match('/sites/:domain', path);
  if (site?.domain) return <SiteDetailPage key={site.domain} domain={site.domain} />;
  // A WordPress install under a path of a domain: /sites/local.spellbook.example/learn.
  const under = match('/sites/:domain/:path', path);
  if (under?.domain && under.path) return <SiteDetailPage key={`${under.domain}/${under.path}`} domain={under.domain} path={`/${under.path}`} />;
  if (path === '/aura') return <AuraPage />;
  if (path === '/aura/machine') return <AuraPage tab="machine" />;
  if (path === '/cores') return <CoresPage />;
  if (path === '/services') return <ServicesPage />;
  if (path === '/services/php') return <ServicesPage tab="php" />;
  const phpPage = match('/services/php/:version/:section', path) ?? match('/services/php/:version', path);
  if (phpPage) {
    const section = phpSectionOf(phpPage.section);
    return <ServicesPage tab="php" phpVersion={phpPage.version as string} {...(section ? { phpSection: section } : {})} />;
  }
  if (path === '/services/mysql') return <ServicesPage tab="mysql" />;
  if (path === '/services/apache') return <ServicesPage tab="apache" />;
  if (path === '/services/nginx') return <ServicesPage tab="nginx" />;
  if (path === '/services/cron') return <ServicesPage tab="cron" />;
  if (path === '/settings') return <SettingsPage />;
  if (path === '/modes') return <ModesPage />;
  if (path === '/sanctum') return <SanctumPage />;
  if (path === '/activity') return <ActivityPage tab="jobs" />;
  if (path === '/activity/runs') return <ActivityPage tab="runs" />;
  const run = match('/runs/:id', path);
  if (run?.id && /^\d+$/.test(run.id)) return <RunPage key={run.id} id={Number(run.id)} />;
  if (path === '/developer') return <DeveloperPage />;
  if (path === '/update') return <UpdatePage />;
  if (path === '/mail') return <MailPage />;
  if (path === '/mockup' && isMockup) return <MockupPage />;
  if (path === '/mockup/parts' && isMockup) return <UiKitPage />;
  const job = match('/jobs/:id', path);
  if (job?.id) return <JobPage key={job.id} id={job.id} />;
  return <SitesPage />;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Tries so far while the panel does not answer (it is still starting), or null. */
  const [waiting, setWaiting] = useState<number | null>(null);
  const start = useRef<PanelStart | null>(null);
  const path = usePath();
  // The mode's look, on the login page too: it comes from this browser's copy of the preferences.
  useApplyMode();

  // Asks for the session until the panel answers: a tab restored after a reboot opens before the panel has started.
  const refresh = useCallback(() => {
    start.current?.stop();
    setError(null);
    start.current = startPanel(() => api.session(), {
      ready: (value) => {
        if (value.version) notePanelVersion(value.version);
        setSession(value);
        setWaiting(null);
      },
      waiting: setWaiting,
      failed: (err) => {
        setWaiting(null);
        setError(err.message);
      },
    });
  }, []);

  useEffect(() => {
    refresh();
    const stopWake = retryOnWake(() => start.current?.retryNow());
    return () => {
      stopWake();
      start.current?.stop();
    };
  }, [refresh]);

  const lost = useSyncExternalStore(onSessionChange, isSessionLost);
  const signedIn = useRef(false);
  signedIn.current = session?.authenticated === true && !lost;

  // A session that ended here, or came back in another tab: a check when the tab returns or the computer wakes, and what the other tabs say.
  useEffect(() => {
    const backElsewhere = () => !signedIn.current && window.location.reload();
    const stopWatch = startSessionWatch(async () => {
      if ((await api.session()).authenticated) backElsewhere();
      else sessionLost();
    });
    const stopListening = listenToOtherTabs((message) => (message === 'logged-out' ? sessionLost() : backElsewhere()));
    return () => {
      stopWatch();
      stopListening();
    };
  }, []);

  useEffect(() => {
    // A page that moved: its old address goes on to the new one, the query kept.
    const moved = movedTo(path, window.location.search);
    if (moved) {
      navigate(moved, { replace: true });
      return;
    }
    const known = ((path === '/mockup' || path === '/mockup/parts') && isMockup) || path === '/settings' || path === '/modes' || path === '/sanctum' || path === '/activity' || path === '/activity/runs' || path === '/sites' || path === '/aura' || path === '/cores' || path === '/services' || path === '/services/php' || match('/services/php/:version', path) !== null || match('/services/php/:version/:section', path) !== null || path === '/services/mysql' || path === '/services/apache' || path === '/services/nginx' || path === '/services/cron' || path === '/aura/machine' || path === '/mail' || path === '/developer' || path === '/update' || match('/sites/:domain', path) !== null || match('/sites/:domain/:path', path) !== null || match('/sites/new/:draft/:step', path) !== null || match('/jobs/:id', path) !== null || match('/runs/:id', path) !== null;
    // The password reset has its own address, but only while signed out (the effect below sends a signed-in browser on).
    if (!known && path !== RESET_PATH) navigate('/sites');
  }, [path]);

  useEffect(() => {
    if (session?.authenticated && path === RESET_PATH) navigate('/sites', { replace: true });
  }, [session, path]);

  if (error) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 px-4 text-sm" role="alert">
        <p className="text-danger">Cannot reach the panel: {error}</p>
        <Button variant="outline" size="sm" onClick={refresh}>
          Try again
        </Button>
      </div>
    );
  }
  if (!session && waiting !== null) return <StartingScreen attempt={waiting} onRetry={() => start.current?.retryNow()} />;
  if (!session) {
    return (
      <div className="flex min-h-svh items-center justify-center text-muted-foreground">
        <Spinner className="size-5" label="Loading" />
      </div>
    );
  }
  if (!session.authenticated) {
    return (
      <LoginPage
        setupRequired={session.setupRequired}
        {...(session.user ? { user: session.user } : {})}
        onLogin={() => {
          tellOtherTabs('logged-in');
          sessionBack();
          refresh();
        }}
      />
    );
  }

  async function logout() {
    await api.logout();
    tellOtherTabs('logged-out');
    refresh();
  }

  return (
    <SignedIn path={path} user={session.user ?? ''} version={session.version} onLogout={() => void logout()}>
      <ModeDefs />
      <Routes path={path} />
      {lost && (
        <SessionDialog
          onLogin={() => {
            tellOtherTabs('logged-in');
            window.location.reload();
          }}
        />
      )}
    </SignedIn>
  );
}

/** The shell and the command palette, with the sites read once for both: the palette's commands and the menu's count. */
function SignedIn({ children, ...shell }: Omit<Parameters<typeof AppShell>[0], 'siteCount'>) {
  const { data } = useAsync(() => api.sites().catch(() => []), []);
  return (
    <AppShell {...shell} {...(data ? { siteCount: data.length } : {})}>
      {children}
      <CommandPalette sites={data ?? []} />
    </AppShell>
  );
}
