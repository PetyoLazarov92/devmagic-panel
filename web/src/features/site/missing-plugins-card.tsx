import type { DumpPlugin, DumpTheme, MissingScanState, ProductionSettings, ServerFiles, Site, WporgPlugin } from '@devmagic-panel/shared';
import { isWpCliCommand, splitSshHost } from '@devmagic-panel/shared';
import { Check, ChevronDown, Download, PackageX, RefreshCw, Server } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { JobFooter } from '@/features/jobs/job-box';
import { useJob } from '@/features/jobs/job-steps';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { forgetProduction } from '@/lib/production';
import { dateTime, timeAgo } from '@/lib/format';
import { askWporg, onServer, pluginItem, pluginSlug } from '@/lib/missing-plugins';
import { siteTarget } from '@/lib/site-ref';
import { cn } from '@/lib/utils';
import { ServerPassword } from '@/features/new-site/database';
import { Spinner } from '@/components/ui/spinner';

/**
 * Plugins the site's database names that its files lack, after a database
 * import or a pull: active ones, network-wide ones, and ones production had
 * installed; and the themes its sites use, with the parent a child theme
 * needs. One row under the search and filters, always there and always
 * the same height, so the list never moves: it says it is checking, then
 * that nothing is missing, or how many are, and opens when you ask. The ones
 * on WordPress.org install from there; the ones it does not have can be
 * copied from the site's own server, named right here: the same server and
 * folder Refresh from production uses, saved once for the site.
 * Each is tried on its own, a failure noted and the rest done; Undo removes
 * them.
 */
/** A theme's tick, kept apart from a plugin file of the same name. */
const themeKey = (name: string) => `theme:${name}`;

export function MissingPluginsCard({ site, show, onChanged }: { site: Site; /** Which view it sits in: each lists its own. */ show: 'plugins' | 'themes'; onChanged: () => void }) {
  const [missing, setMissing] = useState<DumpPlugin[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [wporg, setWporg] = useState<Record<string, WporgPlugin | null>>({});
  const [themes, setThemes] = useState<DumpTheme[]>([]);
  const [wporgThemes, setWporgThemes] = useState<Record<string, WporgPlugin | null>>({});
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  // The server's form: open while none is saved, or on Change.
  const [editing, setEditing] = useState(false);
  const [hostField, setHostField] = useState('');
  const [folderField, setFolderField] = useState('');
  const [wpCliField, setWpCliField] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [production, setProduction] = useState<ProductionSettings | null>(null);
  const [server, setServer] = useState<ServerFiles | null>(null);
  const [secret, setSecret] = useState('');
  const [asking, setAsking] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const install = useJob();
  const copy = useJob();
  // The scan runs on the server: the last result shows at once, a running one is asked about again until it ends.
  const [state, setState] = useState<MissingScanState | null>(null);
  const shown = useRef<string | null>(null);
  const askScan = (force = false) =>
    (force ? api.checkMissing : api.missing)(site.domain, site.path).then(setState, (error: Error) => setState({ error: error.message }));
  useEffect(() => {
    if (!state?.running) return;
    const timer = setTimeout(() => void askScan(), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  // A new result: WordPress.org is asked about the ones this view lists (kept a day on the server), then they show.
  useEffect(() => {
    const scan = state?.scan;
    if (!scan) {
      if (state?.error && !state.running) {
        setMissing([]);
        setThemes([]);
        setFailed(true);
      }
      return;
    }
    if (shown.current === scan.checkedAt) return;
    shown.current = scan.checkedAt;
    const list = show === 'plugins' ? scan.plugins : [];
    const themeList = show === 'themes' ? scan.themes : [];
    void (async () => {
      const answers = list.length ? (await askWporg(list.map(pluginSlug), api.wporgPlugins)).answers : ({} as Record<string, WporgPlugin | null>);
      const themeAnswers = themeList.length ? (await askWporg(themeList.map((t) => t.name), api.wporgThemes)).answers : ({} as Record<string, WporgPlugin | null>);
      setWporg(answers);
      setWporgThemes(themeAnswers);
      setThemes(themeList);
      setMissing(list);
      setFailed(false);
      // Active ones on WordPress.org start ticked, and every theme there: a site without its theme shows nothing. Ones production only had installed, not.
      setTicked(new Set([...list.filter((p) => p.active && answers[pluginSlug(p)]).map((p) => p.file), ...themeList.filter((t) => themeAnswers[t.name]).map((t) => themeKey(t.name))]));
    })();
  }, [state?.scan?.checkedAt, state?.error, state?.running]);
  const checkAgain = () => {
    setFailed(false);
    void askScan(true);
  };
  useEffect(() => {
    setMissing(null);
    setState(null);
    shown.current = null;
    setOpen(false);
    setServer(null);
    void askScan();
    setEditing(false);
    void api.productionSettings(site.domain, site.path).then(setProduction, () => setProduction(null));
  }, [site.domain, site.path, show]);
  const done = `${install.job?.status}|${copy.job?.status}`;
  useEffect(() => {
    if (install.job?.status === 'done' || copy.job?.status === 'done') {
      // The job's end made the server forget the last scan: this starts the next.
      checkAgain();
      onChanged();
    }
  }, [done]);
  const scanning = state?.running;
  const checked = state?.scan && (
    <span className="shrink-0 text-xs text-muted-foreground" title={dateTime(state.scan.checkedAt)}>Checked {timeAgo(state.scan.checkedAt)}</span>
  );
  const again = (
    <Button size="sm" variant="ghost" className="shrink-0" disabled={Boolean(scanning)} onClick={checkAgain} aria-label={`Check the database for missing ${show} again`}>
      <RefreshCw className={cn(scanning && 'animate-spin')} />{scanning ? 'Checking' : 'Check again'}
    </Button>
  );

  const row = 'flex min-h-11 items-center gap-2.5 px-4 py-2 text-sm';
  if (missing === null) {
    const r = state?.running;
    return (
      <Card className={cn(row, 'text-muted-foreground')} role="status" aria-busy="true">
        <Spinner className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          Checking the database for {show} the files lack{r && r.step !== 'Starting' ? `: ${r.step.charAt(0).toLowerCase()}${r.step.slice(1)}${r.total > 1 ? ` (${r.done} of ${r.total})` : ''}` : ''}...
          <span className="block text-xs">It goes on while you look elsewhere; the result is kept for half an hour.</span>
        </span>
      </Card>
    );
  }
  const running = install.job?.status === 'running' || copy.job?.status === 'running';
  const total = missing.length + themes.length;
  if (total === 0 && !install.job && !copy.job) {
    return (
      <Card className={cn(row, 'text-muted-foreground')}>
        {failed ? <PackageX className="size-4 shrink-0" /> : <Check className="size-4 shrink-0 text-success" />}
        <span className="min-w-0 flex-1">
          {failed ? `Could not check the database for missing ${show}${state?.error ? `: ${state.error}` : '.'}` : show === 'plugins' ? 'No plugin is missing: the files have every plugin the database names.' : 'No theme is missing: the files have the theme of every site, and its parent.'}
        </span>
        {checked}
        {again}
      </Card>
    );
  }

  const toggle = (file: string, on: boolean) => setTicked((t) => {
    const next = new Set(t);
    if (on) next.add(file);
    else next.delete(file);
    return next;
  });
  const fromWporg = missing.filter((p) => ticked.has(p.file) && wporg[pluginSlug(p)]);
  const fromServer = missing.filter((p) => ticked.has(p.file) && !wporg[pluginSlug(p)] && onServer(p, server));
  const themeThere = (t: DumpTheme) => server?.themes.find((x) => x.name === t.name);
  const themesFromWporg = themes.filter((t) => ticked.has(themeKey(t.name)) && wporgThemes[t.name]);
  const themesFromServer = themes.filter((t) => ticked.has(themeKey(t.name)) && !wporgThemes[t.name] && themeThere(t));
  const others = missing.filter((p) => !wporg[pluginSlug(p)]).length + themes.filter((t) => !wporgThemes[t.name]).length;
  const ask = () => {
    if (!production) return;
    setAsking(true);
    setServerError(null);
    void api.serverFiles(production.host, production.folder, secret || undefined, production.wpCli)
      .then((has) => {
        setServer(has);
        // The active plugins and the themes the server has start ticked.
        setTicked((t) => new Set([
          ...t,
          ...missing.filter((p) => p.active && !wporg[pluginSlug(p)] && onServer(p, has)).map((p) => p.file),
          ...themes.filter((x) => !wporgThemes[x.name] && has.themes.some((y) => y.name === x.name)).map((x) => themeKey(x.name)),
        ]));
      }, (error: Error) => setServerError(error.message))
      .finally(() => setAsking(false));
  };
  const showForm = editing || !production;
  const hostOk = splitSshHost(hostField.trim()) !== null;
  const folderOk = /^\/[A-Za-z0-9._/-]+$/.test(folderField.trim()) && !folderField.split('/').includes('..');
  const wpCliOk = wpCliField.trim() === '' || isWpCliCommand(wpCliField.trim());
  const edit = () => {
    setHostField(production?.host ?? '');
    setFolderField(production?.folder ?? '');
    setWpCliField(production?.wpCli ?? '');
    setSaveError(null);
    setEditing(true);
  };
  const save = () => {
    setSaving(true);
    setSaveError(null);
    // The other settings Refresh from production keeps for the site stay as they are.
    const { wpCli: _was, ...kept } = production ?? { excludeRows: [], clean: false };
    void api.saveProductionSettings(site.domain, site.path, { ...kept, host: hostField.trim(), folder: folderField.trim(), ...(wpCliField.trim() ? { wpCli: wpCliField.trim() } : {}) } as ProductionSettings)
      .then((settings) => {
        setProduction(settings);
        setServer(null);
        setSecret('');
        setEditing(false);
      }, (error: Error) => setSaveError(error.message))
      .finally(() => setSaving(false));
  };
  const active = missing.filter((p) => p.active).length;
  return (
    <Card role="region" className="overflow-hidden text-sm" aria-label={`Missing ${show}`}>
      <div className="flex items-center gap-2 pr-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 px-4 py-2 text-left hover:bg-muted/50">
        <PackageX className={cn('size-4 shrink-0', total > 0 ? 'text-warning' : 'text-muted-foreground')} />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{total === 0 ? 'Nothing is missing any more' : `${[missing.length ? `${missing.length} plugin${missing.length === 1 ? '' : 's'}` : '', themes.length ? `${themes.length} theme${themes.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')} ${total === 1 ? 'is' : 'are'} missing`}</span>
          {total > 0 && <span className="text-muted-foreground">: in the database, not in the files{active > 0 ? `, ${active} plugin${active === 1 ? '' : 's'} active` : ''}</span>}
        </span>
        {running && <Spinner className="size-4 shrink-0 text-muted-foreground" />}
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">{open ? 'Hide' : 'Review'}<ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} /></span>
      </button>
      <span className="hidden sm:inline">{checked}</span>
      {again}
      </div>
      {open && (
        <div className="grid gap-3 border-t p-4">
          <p className="text-xs text-muted-foreground">
            {show === 'plugins'
              ? "WordPress turns a missing active plugin off on its own. Ones on WordPress.org install from there at production's version when the database says it, checked against WordPress.org's checksums."
              : "A site without its theme shows a blank page or falls back to a default theme. Ones on WordPress.org install from there at production's version when the database says it."}{' '}
            Ones it does not have can be copied from the site's own server. Both are kept out of git locally, and nothing is activated.
          </p>
          {missing.length > 0 && <ul className="grid gap-1.5">
            {missing.map((p) => {
              const slug = pluginSlug(p);
              const wp = wporg[slug];
              const there = onServer(p, server);
              const can = Boolean(wp || there);
              const id = `missing-${p.file.replace(/[^\w-]/g, '-')}`;
              return (
                <li key={p.file} className="flex items-start gap-2.5">
                  <input id={id} type="checkbox" disabled={!can} checked={ticked.has(p.file) && can} onChange={(e) => toggle(p.file, e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
                  <label htmlFor={id} className="grid min-w-0 gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{wp?.name ?? slug}</span>
                      <code className="font-mono text-xs text-muted-foreground">{p.file}</code>
                      {p.active ? <Badge tone="warning">active{p.network ? ', network' : p.sites && p.sites > 1 ? ` on ${p.sites} sites` : ''}</Badge> : <Badge>installed on production</Badge>}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {wp
                        ? `On WordPress.org${p.version ? `: installs ${p.version} (latest ${wp.version})` : `, latest ${wp.version}`}`
                        : there
                          ? `Not on WordPress.org. ${production?.host} has it${there.version ? `, version ${there.version}` : ''}: copied from there, reading only`
                          : server
                            ? `Not on WordPress.org, and ${production?.host} does not have ${pluginItem(p.file)} either: get it from its vendor`
                            : 'Not on WordPress.org: a premium or custom plugin'}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>}
          {themes.length > 0 && (
            <ul className="grid gap-1.5">
              {themes.map((t) => {
                const wp = wporgThemes[t.name];
                const there = themeThere(t);
                const can = Boolean(wp || there);
                const id = `missing-theme-${t.name.replace(/[^\w-]/g, '-')}`;
                return (
                  <li key={t.name} className="flex items-start gap-2.5">
                    <input id={id} type="checkbox" disabled={!can} checked={ticked.has(themeKey(t.name)) && can} onChange={(e) => toggle(themeKey(t.name), e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
                    <label htmlFor={id} className="grid min-w-0 gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{wp?.name ?? t.name}</span>
                        <code className="font-mono text-xs text-muted-foreground">wp-content/themes/{t.name}</code>
                        <Badge tone="primary">theme</Badge>
                        {t.parent ? <Badge>parent of the active theme</Badge> : <Badge tone="warning">active{t.sites && t.sites > 1 ? ` on ${t.sites} sites` : ''}</Badge>}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {wp
                          ? `On WordPress.org${t.version ? `: installs ${t.version} (latest ${wp.version})` : `, latest ${wp.version}`}`
                          : there
                            ? `Not on WordPress.org. ${production?.host} has it${there.version ? `, version ${there.version}` : ''}: copied from there, reading only`
                            : server
                              ? `Not on WordPress.org, and ${production?.host} does not have it either: add its repo, or get it from its vendor`
                              : 'Not on WordPress.org: a paid or custom theme'}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {others > 0 && (
            <div className="grid gap-2.5 rounded-lg border bg-background px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Server className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium">The site's server</span>
                {production && !showForm && (
                  <>
                    <code className="font-mono text-xs text-muted-foreground">{production.host}:{production.folder}</code>
                    <Button size="sm" variant="soft" className="ml-auto" onClick={edit}>Change</Button>
                    <Button size="sm" variant="soft" title={`Forget ${production.host}: the site has no saved server again`} onClick={() => void forgetProduction(site, (now) => { setProduction(now); setServer(null); setSecret(''); })}>Forget</Button>
                  </>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {others === 1 ? 'One is' : `${others} are`} not on WordPress.org: paid or custom. The server production runs on may have {others === 1 ? 'it' : 'them'}, and the panel can copy {others === 1 ? 'it' : 'them'} from there over SSH. It only reads: nothing is written on the server.
              </p>
              {showForm ? (
                <div className="grid gap-2.5">
                  <div className="grid gap-1.5">
                    <label htmlFor="missing-server-host" className="text-xs font-medium">SSH host</label>
                    <Input id="missing-server-host" value={hostField} onChange={(e) => setHostField(e.target.value)} placeholder="deploy@www.spellbook.example, or an alias from ~/.ssh/config" className="font-mono text-dense" autoComplete="off" spellCheck={false} aria-invalid={hostField.trim() !== '' && !hostOk ? true : undefined} />
                  </div>
                  <div className="grid gap-1.5">
                    <label htmlFor="missing-server-folder" className="text-xs font-medium">WordPress folder on the server</label>
                    <Input id="missing-server-folder" value={folderField} onChange={(e) => setFolderField(e.target.value)} placeholder="/var/www/spellbook" className="font-mono text-dense" autoComplete="off" spellCheck={false} aria-invalid={folderField.trim() !== '' && !folderOk ? true : undefined} />
                  </div>
                  <details className="text-xs">
                    <summary className="cursor-pointer font-medium text-primary">WP-CLI has another name on the server?</summary>
                    <Input aria-label="WP-CLI command on the server" value={wpCliField} onChange={(e) => setWpCliField(e.target.value)} placeholder="wp" className="mt-2 font-mono text-dense" autoComplete="off" spellCheck={false} aria-invalid={!wpCliOk ? true : undefined} />
                  </details>
                  <p className="text-xs text-muted-foreground">Saved for this site, with no password. Refresh from production on the Database tab uses the same server and folder.</p>
                  {saveError && <p role="alert" className="text-xs text-danger">{saveError}</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={!hostOk || !folderOk || !wpCliOk || saving} onClick={save}>{saving && <Spinner />}Save the server</Button>
                    {production && <Button variant="soft" onClick={() => setEditing(false)}>Cancel</Button>}
                  </div>
                </div>
              ) : production && (
                <>
                  <ServerPassword id="missing-server-secret" host={production.host} value={secret} onChange={setSecret} />
                  <Button variant="outline" className="w-fit" disabled={asking} onClick={ask}>
                    {asking ? <Spinner /> : <Server />}
                    {server ? `Ask ${production.host} again` : `See what ${production.host} has`}
                  </Button>
                  {serverError && <p role="alert" className="text-xs text-danger">{serverError}</p>}
                </>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={fromWporg.length + themesFromWporg.length === 0 || running}
              onClick={() => void install.follow(api.startJob('site.installPlugins', {
                ...siteTarget(site),
                plugins: fromWporg.map((p) => ({ slug: pluginSlug(p), ...(p.version ? { version: p.version } : {}) })),
                themes: themesFromWporg.map((t) => ({ slug: t.name, ...(t.version ? { version: t.version } : {}) })),
              }))}
            >
              {install.job?.status === 'running' ? <Spinner /> : <Download />}
              Install {fromWporg.length + themesFromWporg.length || ''} from WordPress.org
            </Button>
            {server && production && !showForm && (
              <Button
                variant="outline"
                disabled={fromServer.length + themesFromServer.length === 0 || running}
                onClick={() => void copy.follow(api.startJob('site.copyFromServer', {
                  ...siteTarget(site),
                  host: production.host,
                  folder: production.folder,
                  ...(production.wpCli ? { wpCli: production.wpCli } : {}),
                  plugins: [...new Set(fromServer.map((p) => pluginItem(p.file)))],
                  themes: themesFromServer.map((t) => t.name),
                  ...(secret ? { password: secret } : {}),
                }))}
              >
                {copy.job?.status === 'running' ? <Spinner /> : <Server />}
                Copy {fromServer.length + themesFromServer.length || ''} from {production.host}
              </Button>
            )}
          </div>
        </div>
      )}
      <JobFooter job={install.job} error={install.error} onRetry={() => void install.retry()} />
      <JobFooter job={copy.job} error={copy.error} onRetry={() => void copy.retry()} />
    </Card>
  );
}
