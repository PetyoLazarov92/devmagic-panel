import { actions, addressSummary, branchName, coreVersion as coreVersionSchema, databaseNameFor, gitUrl, hostname, isLocalName, mountFolder, mountPath } from '@devmagic-panel/shared';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Plus, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import '@/features/site/branch-picker';
import { Badge } from '@/components/ui/badge';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { newOrgState, ProjectReadStep, runFor } from '@/features/new-site/org';
import { ClaudeSwitch, CodeStep, codeProblem, SitePlan, useRepoLookups } from '@/features/new-site/code';
import { DatabaseStep } from '@/features/new-site/database';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { navigate } from '@/lib/router';
import { toast } from '@/lib/toast';
import { runSource, skipAccess } from '@/lib/claude-steps';
import { draftHref, migrateStep, type InstallKind, KIND_LABEL, keptUntil, kindOf, landingStep, STEP_LABEL, stepsFor } from '@/lib/drafts';
import { answersHash, stepViews } from '@/lib/steps';
import { useAsync } from '@/lib/use-async';
import { savePreferences, usePreferences } from '@/lib/preferences';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { type Step, type WizardState } from '@/features/new-site/wizard-shared';
import { type Opened, STEP_ANSWERS, type Saved, UNNAMED, addressesFor, applyPreset, cleanAddress, draftOf, initial, networkFor, passStep, savedOf, stateFromDraft, titleOf, toInput } from '@/features/new-site/wizard-state';
import { StartStep } from '@/features/new-site/start-step';
import { ClaudeFill, ProjectStatus } from '@/features/new-site/claude-fill';
import { DomainsStep } from '@/features/new-site/domains-step';
import { WordPressStep } from '@/features/new-site/wordpress-step';
import { ReviewStep, RunScreen } from '@/features/new-site/review-step';
import { useModeText } from '@/lib/modes';

/**
 * The new site wizard. /sites/new starts an install; continuing from Start
 * makes its draft, and from then on the address names the draft and its step
 * (/sites/new/<draft>/domains), so Back and Forward move between steps, a
 * reload stays, and a link opens it again.
 */
export function NewSitePage({ draft: routeDraft, step: routeStep }: { draft?: string; step?: string }) {
  const text = useModeText();
  const [state, setState] = useState<WizardState>(initial);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const set = <K extends keyof WizardState>(key: K, value: WizardState[K]) => {
    setTouched(true);
    setState((s) => ({ ...s, [key]: value }));
  };
  const setOrgState = (update: (s: WizardState) => WizardState) => {
    setTouched(true);
    setState(update);
  };
  // The draft the answers are saved to: none until you continue from Start, so looking at the start cards keeps nothing.
  const draftId = useRef<string | null>(null);
  const [opened, setOpened] = useState<Opened>({ status: routeDraft ? 'loading' : 'new' });
  const [saved, setSaved] = useState<Saved | null>(null);
  // Create site starts the install here; it has no address of its own, so Back from its job never starts it again.
  const [running, setRunning] = useState(false);
  const [touched, setTouched] = useState(false);
  // Another start card picked in a draft past Start: asked before its answers go.
  const [switchTo, setSwitchTo] = useState<InstallKind | null>(null);
  const [discarding, setDiscarding] = useState<'ask' | 'busy' | null>(null);
  // The save that waits for a pause in your changes.
  const pending = useRef<(() => void) | null>(null);

  const cores = useAsync(() => api.cores(), []);
  const sites = useAsync(() => api.sites(), []);
  const nginx = useAsync(() => api.nginxState(), []);
  const { newSiteServer } = usePreferences();
  // Once it is known whether nginx runs: the default for new sites, Apache while it does not.
  useEffect(() => {
    if (nginx.data && state.server === null) set('server', nginx.data.setUp ? newSiteServer : 'apache');
  }, [nginx.data, state.server, newSiteServer]);
  const assistant = useAsync(() => api.assistant(), []);
  const orgStatus = useAsync(() => api.orgStatus(), []);

  function fresh() {
    draftId.current = null;
    setState({ ...initial, coreVersion: cores.data?.[0] ?? '' });
    setSaved(null);
    setTouched(false);
    setRunning(false);
    setSwitchTo(null);
    setDiscarding(null);
    setSubmitError(null);
    setOpened({ status: 'new' });
  }

  // The address names the draft: open it, or start again at /sites/new.
  useEffect(() => {
    // The draft this page made when you continued from Start is open already.
    if (routeDraft && routeDraft === draftId.current) return;
    // Another draft, or a new install: the last change to this one is saved first.
    pending.current?.();
    if (!routeDraft) {
      if (opened.status !== 'new') fresh();
      return;
    }
    let live = true;
    draftId.current = null;
    setOpened({ status: 'loading' });
    api.draft(routeDraft).then(
      (draft) => {
        if (!live) return;
        if (draft.status === 'installing') {
          setOpened({ status: 'installing', ...(draft.jobId ? { jobId: draft.jobId } : {}) });
          return;
        }
        const next = stateFromDraft(draft);
        draftId.current = draft.id;
        setState(next);
        // The dump as the panel reads it now: a draft from before a better dump scan gets the new facts, its answers stay.
        if (next.upload) {
          const id = next.upload.id;
          api.uploadInfo(id).then((upload) => live && setState((s) => (s.upload?.id === id ? { ...s, upload } : s)), () => undefined);
        }
        setSaved(savedOf(draft));
        setTouched(false);
        setRunning(false);
        setSwitchTo(null);
        setDiscarding(null);
        setSubmitError(null);
        setOpened({ status: 'ready' });
        // Without a step, or with one it cannot open yet, it opens where it stopped or as far as it got.
        const land = landingStep(stepsFor(next.source, Boolean(next.org?.useClaude)), routeStep ?? migrateStep(draft.step), next.passed);
        if (land !== routeStep) navigate(draftHref(draft.id, land), { replace: true });
      },
      (err: Error & { status?: number }) => {
        if (live) setOpened(err.status === 404 ? { status: 'gone' } : { status: 'error', message: err.message });
      },
    );
    return () => {
      live = false;
    };
  }, [routeDraft]);

  // The newest core is the default.
  useEffect(() => {
    const newest = cores.data?.[0];
    if (newest) setState((s) => (s.coreVersion ? s : { ...s, coreVersion: newest }));
  }, [cores.data]);

  const flow = stepsFor(state.source, Boolean(state.org?.useClaude));
  const inDraft = opened.status === 'ready';
  const step: Step = inDraft ? landingStep(flow, routeStep, state.passed) : 'start';
  // A step the draft's kind has not, or one it cannot open yet: the address moves to the one it opens.
  useEffect(() => {
    if (inDraft && draftId.current && step !== routeStep) navigate(draftHref(draftId.current, step), { replace: true });
  }, [inDraft, step, routeStep]);
  const index = flow.indexOf(step);
  const input = toInput(state);
  const kind = kindOf(state.source);
  const title = titleOf(state, input);

  /** Saves the draft and keeps what the header says about it. */
  const persist = (id: string, s: WizardState, at: Step) =>
    api.saveDraft(id, draftOf(s, at, toInput(s))).then((draft) => {
      if (draftId.current === id) setSaved(savedOf(draft));
      return draft;
    });
  // Right away, for a step whose job notes itself on the draft.
  const saveNow = () => (draftId.current ? persist(draftId.current, state, step) : Promise.resolve());
  // Saved a moment after each change, until the install starts.
  useEffect(() => {
    // Once the install starts the draft is the server's: nothing waits to be saved.
    if (running) pending.current = null;
    if (!touched || running || !draftId.current) return;
    const save = () => {
      pending.current = null;
      // Read when it runs: a discarded draft is not made again.
      if (draftId.current) void persist(draftId.current, state, step).catch(() => undefined);
    };
    pending.current = save;
    const timer = window.setTimeout(save, 800);
    return () => window.clearTimeout(timer);
  }, [state, step, touched]);
  // Leaving the page saves a change still waiting, so Back right after one keeps it.
  useEffect(() => () => pending.current?.(), []);

  // The browser tab names the install.
  useEffect(() => {
    const before = document.title;
    return () => {
      document.title = before;
    };
  }, []);
  useEffect(() => {
    document.title = inDraft && title !== UNNAMED ? `${title} · New site` : 'New site';
  }, [inDraft, title]);

  const goTo = (s: Step) => {
    if (draftId.current) navigate(draftHref(draftId.current, s));
  };
  // Claude Code reads the repo when it can and Settings says so: on by default, off when asked for, never offered when turned off.
  const { useClaude: claudePreference } = usePreferences();
  const claudeReady = Boolean(orgStatus.data?.claude.found && orgStatus.data.claude.signedIn);
  const claudeDefault = claudeReady && claudePreference === 'always';
  function applyKind(next: InstallKind) {
    setTouched(true);
    setSwitchTo(null);
    setState((s) => (next === 'repo' ? { ...s, source: 'repo', org: s.org ?? newOrgState(orgStatus.data?.settings.selected[0] ?? '', claudeDefault) } : { ...s, source: next, org: null }));
  }
  // A new install from a project: its Claude switch follows Settings once Claude Code's state is known.
  useEffect(() => {
    if (state.source !== 'repo') return;
    if (!state.org) setState((s) => (s.source === 'repo' && !s.org ? { ...s, org: newOrgState(orgStatus.data?.settings.selected[0] ?? '', claudeDefault) } : s));
    else if (!state.passed.code && !touchedClaude.current && state.org.useClaude !== claudeDefault) setState((s) => (s.org ? { ...s, org: { ...s.org, useClaude: claudeDefault } } : s));
  }, [state.source, Boolean(state.org), claudeDefault]);
  const touchedClaude = useRef(false);
  const setUseClaude = (on: boolean) => {
    touchedClaude.current = true;
    setOrgState((s) => (s.org ? { ...s, org: { ...s.org, useClaude: on } } : s));
  };
  // Past Start the draft has answers for its kind: switching asks first.
  const choose = (next: InstallKind) => (next === kind ? setSwitchTo(null) : state.passed.start !== undefined ? setSwitchTo(next) : applyKind(next));

  async function discard() {
    const id = draftId.current;
    if (!id) return;
    setDiscarding('busy');
    // Nothing saves it again once it goes.
    draftId.current = null;
    try {
      await api.discardDraft(id);
      toast({ tone: 'success', title: 'Install discarded' });
      navigate('/sites/new', { replace: true });
    } catch (err) {
      draftId.current = id;
      setDiscarding(null);
      toast({ tone: 'danger', title: 'Not discarded', detail: (err as Error).message });
    }
  }
  const taken = new Set((sites.data ?? []).flatMap((s) => [s.domain, ...s.aliases]));
  // The site the primary domain already belongs to: a reinstall archives it first and frees its names.
  const existing = state.source !== 'empty' && state.under ? undefined : (sites.data ?? []).find((s) => !s.path && s.domain === input.domain);
  const freed = new Set(existing && state.replaceExisting ? [existing.domain, ...existing.aliases] : []);
  // Two rows may share a local name: www.shop.com and shop.com both become local.shop.com.
  const network = networkFor(state);
  const domainErrors = state.domains.map((d) => {
    const local = cleanAddress(d.local, false);
    if (!local) return null;
    if (!isLocalName(local)) return 'Use local.*, *.test or *.localhost';
    if (taken.has(local) && !freed.has(local)) return existing && local === existing.domain ? 'Installed already: see below' : 'Another site already uses this domain';
    return null;
  });
  // A network site's own domain may be another site's already.
  const networkErrors = new Map((network?.rows ?? []).filter((r) => !r.main && taken.has(r.here.domain) && !freed.has(r.here.domain)).map((r) => [r.site.id, 'Another site already uses this domain']));
  const uploadsTyped = cleanAddress(state.uploadsFrom ?? '', false);
  const uploadsError =
    state.source !== 'repo' || state.uploadsFrom === null || uploadsTyped === ''
      ? null
      : isLocalName(uploadsTyped)
        ? 'A local name would load images from this site itself'
        : !hostname.safeParse(uploadsTyped).success
          ? 'A domain like www.example.com'
          : null;

  // A network needs a domain of its own: a dump that holds one drops "install under a path", from a draft too.
  const networkDump = state.source === 'repo' && Boolean(state.upload?.facts.multisite);
  useEffect(() => {
    if (networkDump && state.under) setState((s) => ({ ...s, under: null }));
  }, [networkDump, state.under]);

  // The main repo: its branches and what the panel remembers of it, read once per URL.
  const mainUrl = state.repoUrl.trim();
  const mainInvalid = mainUrl !== '' && !gitUrl.safeParse(mainUrl).success;
  useEffect(() => {
    if (state.source !== 'repo' || mainInvalid || !mainUrl || state.inspection.url === mainUrl) return;
    const timer = window.setTimeout(() => {
      // Another repo: its branches and helpers are read again; the branch a list gave stays.
      setState((s) => ({ ...s, branches: null, helpers: null, inspection: { status: 'reading', url: mainUrl } }));
      api.inspectRepo(mainUrl).then(
        (found) => setState((s) => (s.repoUrl.trim() === mainUrl ? applyPreset({ ...s, branch: s.branch || found.branch }, { ...found, branch: s.branch || found.branch }, cores.data ?? []) : s)),
        (err: Error) => setState((s) => (s.repoUrl.trim() === mainUrl ? { ...s, branches: [], inspection: { status: 'error', url: mainUrl, message: err.message } } : s)),
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [state.source, mainUrl, mainInvalid, state.inspection.url, cores.data]);
  useRepoLookups(state, setOrgState);

  // The local helpers the chosen branch has, read in the background so step 4 only offers those.
  const repoUrl = state.repoUrl.trim();
  const helpersKey = `${repoUrl}|${state.branch}`;
  useEffect(() => {
    if (state.source !== 'repo' || !gitUrl.safeParse(repoUrl).success || !branchName.safeParse(state.branch).success || state.helpers?.key === helpersKey) return;
    const timer = window.setTimeout(() => {
      setState((s) => ({ ...s, helpers: { key: helpersKey } }));
      api.repoHelpers(repoUrl, state.branch).then(
        ({ helpers: list, mediaPlugin, builds, nodes, kind, themeIn, pluginIn, header, core, uploads, plugins, themes }) =>
          // Nothing is ticked for you: you pick the helpers to turn on. A repo with core of its own uses it, unless you chose.
          setState((s) =>
            s.helpers?.key !== helpersKey
              ? s
              : {
                  ...s,
                  helpers: { key: helpersKey, list, media: mediaPlugin, builds, ...(nodes ? { nodes } : {}), ...(kind ? { kind } : {}), ...(themeIn ? { themeIn } : {}), ...(pluginIn ? { pluginIn } : {}), ...(header ? { header } : {}), ...(core ? { core } : {}), ...(uploads ? { uploads } : {}), ...(plugins ? { plugins } : {}), ...(themes ? { themes } : {}) },
                  activate: s.activate.filter((slug) => list.includes(slug)),
                  coreMode: core && !s.passed.wordpress ? 'repo' : !core && s.coreMode === 'repo' ? 'wpcore' : s.coreMode,
                },
          ),
        (err: Error) => setState((s) => (s.helpers?.key === helpersKey ? { ...s, helpers: { key: helpersKey, error: err.message } } : s)),
      );
    }, 400);
    return () => window.clearTimeout(timer);
  }, [state.source, repoUrl, state.branch, helpersKey, state.helpers?.key]);
  // Where a site under a path goes, and what stops it: no parent, an odd path, or one already served.
  const underFolder = input.path ? mountFolder(input.domain, input.path) : null;
  const underError = !state.under || state.source === 'empty'
    ? null
    : !state.under.domain
      ? 'Pick the site to put it under'
      : !mountPath.safeParse(input.path ?? '').success
        ? 'A path like /learn'
        : !underFolder
          ? 'This path gives no usable folder name'
          : (sites.data ?? []).some((s) => (s.domain === input.domain && (s.path === input.path || s.mounts?.some((m) => m.path === input.path))) || s.docroot.endsWith(`/${underFolder}`))
            ? `${input.domain}${input.path} or its folder is already taken`
            : null;
  const dbName = input.domain ? databaseNameFor(underFolder ?? input.domain, (sites.data ?? []).flatMap((s) => (s.db ? [s.db.name] : []))) : '';

  const canNext: Record<Step, boolean> = {
    start: true,
    code: codeProblem(state) === null,
    // The repo is read, and its links are checked, skipped or could not be checked: only a check still running holds the step.
    read: state.org?.read.status === 'done' && state.org.access.status !== 'checking' && state.org.access.status !== 'idle',
    database: state.upload !== null || state.noDump,
    domains: state.under && state.source !== 'empty'
      ? !underError && Boolean(input.path)
      : Boolean(input.domain) && domainErrors.every((e) => !e) && state.domains.every((d) => d.local.trim()) && !network?.rows.some((r) => r.error) && networkErrors.size === 0,
    wordpress: Boolean(input.admin?.user) && Boolean(input.admin?.email.includes('@')) && (state.coreMode === 'repo' || coreVersionSchema.safeParse(state.coreVersion).success) && !uploadsError,
    review: true,
  };

  function next() {
    if (step === 'review') {
      const parsed = actions['site.create'].input.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        setSubmitError(`${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}`);
        return;
      }
      setSubmitError(null);
      // The draft gets your last change before the install takes it over.
      pending.current?.();
      setRunning(true);
      return;
    }
    const n = flow[index + 1];
    if (!n) return;
    const passed = passStep(state, step);
    setTouched(true);
    setState(passed);
    if (!draftId.current) {
      // Continuing from Start makes the draft; Back comes back to Start with your choice.
      const id = crypto.randomUUID();
      draftId.current = id;
      setOpened({ status: 'ready' });
      void persist(id, passed, n).catch(() => undefined);
      navigate(draftHref(id, 'start'), { replace: true });
    }
    navigate(draftHref(draftId.current, n));
  }
  const back = () => {
    const p = flow[index - 1];
    if (p) goTo(p);
  };
  const views = stepViews(flow, step, state.passed, (s) => answersHash(STEP_ANSWERS[s](state)), (s) => canNext[s]);
  const stale = flow.some((s) => views[s].stale);

  const wizard = (opened.status === 'new' || inDraft) && !running;
  const named = inDraft && title !== UNNAMED;

  return (
    <div className="pt-2">
      <Breadcrumbs
        items={[
          { label: 'Sites', href: '/sites' },
          ...(inDraft ? [{ label: 'New site', href: '/sites/new' }, { label: named ? <span className="font-mono text-dense">{title}</span> : 'Draft' }] : [{ label: 'New site' }]),
        ]}
      />
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {/* A draft named by its domain keeps the domain's own face; before that the mode may say it its way. */}
        <h1 {...(named ? {} : { 'data-ui': 'page-title' })} className={cn('min-w-0 truncate text-2xl font-semibold tracking-tight', named && 'font-mono')}>{named ? title : text('newSite')}</h1>
        {inDraft && <Badge tone="primary">{KIND_LABEL[kind]}</Badge>}
      </div>
      {inDraft && saved && <SavedLine saved={saved} discarding={discarding} onDiscarding={setDiscarding} onDiscard={() => void discard()} />}

      {wizard && (
        <>
          <ol className="mt-5 flex flex-wrap items-center gap-1 text-sm" aria-label="Steps">
            {flow.map((s, i) => {
              const view = views[s];
              return (
                <li key={s} className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={!view.open || s === step}
                    onClick={() => goTo(s)}
                    aria-current={s === step ? 'step' : undefined}
                    title={view.stale ? 'An answer before this step changed: continue to check it again' : undefined}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-full border py-1 pr-3 pl-1.5 transition-colors',
                      s === step
                        ? 'border-primary/25 bg-secondary font-medium text-secondary-foreground'
                        : view.open
                          ? 'border-foreground/10 bg-foreground/4 text-foreground hover:border-foreground/20 hover:bg-foreground/10'
                          : 'cursor-not-allowed border-foreground/10 bg-foreground/4 text-muted-foreground opacity-60',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex size-5 items-center justify-center rounded-full text-2xs font-semibold',
                        view.done ? 'bg-primary text-primary-foreground' : s === step ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {view.done ? <Check className="size-3" /> : i + 1}
                    </span>
                    {/* The first step names the kind you picked, which sets the steps after it. */}
                    {s === 'start' ? KIND_LABEL[kind] : STEP_LABEL[s]}
                  </button>
                  {i < flow.length - 1 && <ChevronRight className="size-3.5 text-muted-foreground" />}
                </li>
              );
            })}
          </ol>
          {stale && <p className="mt-2 text-xs text-muted-foreground">An answer changed: continue to check the next steps again, or put it back to open them.</p>}
        </>
      )}

      <div className="mt-6">
        {opened.status === 'loading' && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" /> Opening the install...</p>}
        {(opened.status === 'gone' || opened.status === 'error') && <DraftGone {...(opened.status === 'error' ? { error: opened.message } : {})} />}
        {opened.status === 'installing' && <DraftInstalling {...(opened.jobId ? { jobId: opened.jobId } : {})} />}
        {wizard && step === 'start' && (
          <>
            {switchTo && (
              <Notice tone="warning" className="mb-4 max-w-3xl">
                <p className="font-medium">Switch this install to {KIND_LABEL[switchTo]}?</p>
                <p className="mt-1 text-muted-foreground">
                  {state.org ? 'Its organization, repo read and dump answers are dropped. ' : ''}Answers both kinds use, like the domains, stay.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => applyKind(switchTo)}>Switch</Button>
                  <Button size="sm" variant="soft" onClick={() => setSwitchTo(null)}>Keep {KIND_LABEL[kind]}</Button>
                </div>
              </Notice>
            )}
            <StartStep value={state.source} claude={claudeReady && claudePreference !== 'never'} onChange={choose} />
          </>
        )}
        {wizard && state.source === 'repo' && step !== 'start' && step !== 'code' && <div className="-mt-2 mb-5"><SitePlan state={state} compact /></div>}
        {wizard && step === 'code' && (
          <CodeStep
            state={state}
            setState={setOrgState}
            status={orgStatus.data ?? null}
            onRecheck={orgStatus.reload}
            sites={sites.data ?? []}
            mainExtras={
              <>
                <ProjectStatus inspection={state.inspection} />
                {assistant.data?.enabled === true && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-xs font-medium text-primary">Describe the site to Claude instead</summary>
                    <div className="mt-2"><ClaudeFill state={state} setState={setOrgState} cores={cores.data ?? []} /></div>
                  </details>
                )}
              </>
            }
            side={
              <ClaudeSwitch
                status={orgStatus.data ?? null}
                on={Boolean(state.org?.useClaude)}
                onChange={setUseClaude}
                preference={claudePreference}
                onPreference={(p) => void savePreferences({ useClaude: p })}
                run={state.org && orgStatus.data ? runFor(state.org, orgStatus.data) : undefined}
                own={Boolean(state.org && orgStatus.data && runSource(state.org.run, orgStatus.data.settings.run) === 'install')}
                onRun={(run) => setOrgState((s) => {
                  if (!s.org) return s;
                  const { run: _own, ...org } = s.org;
                  return { ...s, org: run ? { ...org, run } : org };
                })}
              />
            }
          />
        )}
        {wizard && step === 'read' && (
          <ProjectReadStep
            state={state}
            setState={setOrgState}
            status={orgStatus.data ?? null}
            draftId={draftId.current ?? ''}
            saveNow={saveNow}
          />
        )}
        {wizard && step === 'database' && <DatabaseStep state={state} setState={setOrgState} status={orgStatus.data ?? null} cores={cores.data ?? []} draftId={draftId.current ?? ''} saveNow={saveNow} />}
        {wizard && step === 'domains' && <DomainsStep state={state} set={set} nginx={nginx.data ?? null} errors={domainErrors} sites={sites.data ?? []} underError={underError} underFolder={underFolder} existing={existing} network={network} networkErrors={networkErrors} summary={state.upload ? addressSummary(addressesFor(input, state, network), input.network?.layout) : null} />}
        {wizard && step === 'wordpress' && <WordPressStep state={state} set={set} cores={cores.data ?? []} input={input} uploadsError={uploadsError} />}
        {wizard && step === 'review' && <ReviewStep state={state} set={set} input={input} dbName={dbName} cores={cores.data} />}
        {running && <RunScreen input={{ ...input, ...(draftId.current ? { draftId: draftId.current } : {}) }} onBack={() => setRunning(false)} />}
      </div>

      {wizard && submitError && <p role="alert" className="mt-4 text-sm text-danger">{submitError}</p>}

      {wizard && (
        <div className="mt-8 flex items-center justify-between gap-3 border-t pt-5">
          <Button variant="soft" onClick={back} disabled={index === 0}>
            <ArrowLeft />
            Back
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* While Claude Code reads, or after it failed: the step can be left out, next to Continue where the way on is. */}
            {step === 'read' && ['idle', 'reading', 'error'].includes(state.org?.read.status ?? '') && (
              <Button
                variant="outline"
                onClick={() => {
                  setOrgState((s) => passStep(s.org ? { ...s, org: { ...s.org, access: skipAccess(s.org.access) } } : s, 'read'));
                  goTo('database');
                }}
              >
                Go on without Claude
              </Button>
            )}
          <Button onClick={next} disabled={!canNext[step]}>
            {step === 'review' ? <Wand2 /> : null}
            {step === 'review' ? 'Create site' : 'Continue'}
            {step !== 'review' && <ArrowRight />}
          </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** When the draft was saved and when it goes, kept current while you stay on a step; Discard asks first. */
function SavedLine({ saved, discarding, onDiscarding, onDiscard }: { saved: Saved; discarding: 'ask' | 'busy' | null; onDiscarding: (v: 'ask' | null) => void; onDiscard: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((t) => t + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      {saved.failed && <span className="font-medium text-warning">The install failed: change what it needs and create it again ·</span>}
      <span>Draft, saved {timeAgo(saved.updatedAt)}{saved.expiresAt ? `, kept until ${keptUntil(saved.expiresAt)}` : ''}</span>
      <span aria-hidden>·</span>
      {discarding ? (
        <span role="group" aria-label="Discard this install" className="inline-flex flex-wrap items-center gap-x-2">
          Discard this install? Its answers and any dump it holds go.
          <Button size="xs" variant="danger" disabled={discarding === 'busy'} onClick={onDiscard}>Discard</Button>
          <Button size="xs" variant="soft" disabled={discarding === 'busy'} onClick={() => onDiscarding(null)}>Keep</Button>
        </span>
      ) : (
        <Button size="xs" variant="soft" onClick={() => onDiscarding('ask')}>Discard</Button>
      )}
    </p>
  );
}

/** A draft's address that opens nothing: it was installed, discarded or ran out, or the panel could not read it. */
function DraftGone({ error }: { error?: string }) {
  return (
    <Card className="max-w-xl p-5">
      <p className="font-medium">{error ? 'This install did not open' : 'This install is no longer here'}</p>
      <p className="mt-1 text-sm text-muted-foreground">{error ?? 'It was installed or discarded, or it ran out 24 hours after its last change.'}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => navigate('/sites/new', { replace: true })}><Plus />Start a new install</Button>
        <ButtonLink variant="outline" href="/sites">Sites</ButtonLink>
      </div>
    </Card>
  );
}

/** A draft whose install runs: its answers stay as they are until it ends. */
function DraftInstalling({ jobId }: { jobId?: string }) {
  return (
    <Card className="max-w-xl p-5">
      <p className="font-medium">This install is running</p>
      <p className="mt-1 text-sm text-muted-foreground">Its answers stay as they are while it runs. If it fails, the draft opens here again to change and run it once more.</p>
      {jobId && <ButtonLink className="mt-4" href={`/jobs/${encodeURIComponent(jobId)}`}>See progress<ArrowRight /></ButtonLink>}
    </Card>
  );
}
