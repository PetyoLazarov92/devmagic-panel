import type { DumpPlugin, ProductionSettings, ServerFiles, Site, WporgPlugin } from '@devmagic-panel/shared';
import { Check, ChevronDown, Download, LoaderCircle, PackageX, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { JobFooter } from '@/components/job-box';
import { useJob } from '@/components/job-steps';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { askWporg, onServer, pluginItem, pluginSlug } from '@/lib/missing-plugins';
import { siteTarget } from '@/lib/site-ref';
import { cn } from '@/lib/utils';
import { ServerPassword } from '@/pages/new-site-database';

/**
 * Plugins the site's database names that its files lack, after a database
 * import or a pull: active ones, network-wide ones, and ones production had
 * installed. One row under the search and filters, always there and always
 * the same height, so the list never moves: it says it is checking, then
 * that nothing is missing, or how many are, and opens when you ask. The ones
 * on WordPress.org install from there; the ones it does not have can be
 * copied from the site's own server, when Refresh from production is set up.
 * Each is tried on its own, a failure noted and the rest done; Undo removes
 * them.
 */
export function MissingPluginsCard({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const [missing, setMissing] = useState<DumpPlugin[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [wporg, setWporg] = useState<Record<string, WporgPlugin | null>>({});
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [production, setProduction] = useState<ProductionSettings | null>(null);
  const [server, setServer] = useState<ServerFiles | null>(null);
  const [secret, setSecret] = useState('');
  const [asking, setAsking] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const install = useJob();
  const copy = useJob();
  const read = () => {
    setFailed(false);
    return api.missingPlugins(site.domain, site.path).then(async (list) => {
      const answers = list.length ? (await askWporg(list.map(pluginSlug), api.wporgPlugins)).answers : ({} as Record<string, WporgPlugin | null>);
      setWporg(answers);
      setMissing(list);
      // Active ones on WordPress.org start ticked; ones production only had installed, not.
      setTicked(new Set(list.filter((p) => p.active && answers[pluginSlug(p)]).map((p) => p.file)));
    }, () => {
      setMissing([]);
      setFailed(true);
    });
  };
  useEffect(() => {
    setMissing(null);
    setOpen(false);
    setServer(null);
    void read();
    void api.productionSettings(site.domain, site.path).then(setProduction, () => setProduction(null));
  }, [site.domain, site.path]);
  const done = `${install.job?.status}|${copy.job?.status}`;
  useEffect(() => {
    if (install.job?.status === 'done' || copy.job?.status === 'done') {
      void read();
      onChanged();
    }
  }, [done]);

  const row = 'flex min-h-11 items-center gap-2.5 rounded-xl border bg-card px-4 py-2 text-sm';
  if (missing === null) {
    return (
      <p className={cn(row, 'text-muted-foreground')} role="status" aria-busy="true">
        <LoaderCircle className="size-4 shrink-0 animate-spin" />
        Checking the database for plugins the files lack...
      </p>
    );
  }
  const running = install.job?.status === 'running' || copy.job?.status === 'running';
  if (missing.length === 0 && !install.job && !copy.job) {
    return (
      <p className={cn(row, 'text-muted-foreground')}>
        {failed ? <PackageX className="size-4 shrink-0" /> : <Check className="size-4 shrink-0 text-success" />}
        {failed ? 'Could not check the database for missing plugins.' : 'No plugin is missing: the files have every plugin the database names.'}
        {failed && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { setMissing(null); void read(); }}>Check again</Button>}
      </p>
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
  const others = missing.filter((p) => !wporg[pluginSlug(p)]);
  const ask = () => {
    if (!production) return;
    setAsking(true);
    setServerError(null);
    void api.serverFiles(production.host, production.folder, secret || undefined, production.wpCli)
      .then((has) => {
        setServer(has);
        // The active ones the server has start ticked.
        setTicked((t) => new Set([...t, ...missing.filter((p) => p.active && !wporg[pluginSlug(p)] && onServer(p, has)).map((p) => p.file)]));
      }, (error: Error) => setServerError(error.message))
      .finally(() => setAsking(false));
  };
  const active = missing.filter((p) => p.active).length;
  return (
    <section className="overflow-hidden rounded-xl border bg-card text-sm" aria-label="Missing plugins">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-muted/50">
        <PackageX className={cn('size-4 shrink-0', missing.length > 0 ? 'text-warning' : 'text-muted-foreground')} />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{missing.length === 0 ? 'No plugin is missing any more' : `${missing.length} plugin${missing.length === 1 ? ' is' : 's are'} missing`}</span>
          {missing.length > 0 && <span className="text-muted-foreground">: in the database, not in the files{active > 0 ? `, ${active} of them active` : ''}</span>}
        </span>
        {running && <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">{open ? 'Hide' : 'Review'}<ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} /></span>
      </button>
      {open && (
        <div className="grid gap-3 border-t p-4">
          <p className="text-xs text-muted-foreground">
            WordPress turns a missing active plugin off on its own. Ones on WordPress.org install from there at production's version when the database says it, checked against WordPress.org's checksums. Ones it does not have can be copied from the site's own server. Both are kept out of git locally.
          </p>
          <ul className="grid gap-1.5">
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
                      <code className="font-mono text-[12px] text-muted-foreground">{p.file}</code>
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
          </ul>
          {others.length > 0 && !server && (
            production ? (
              <div className="grid gap-2 rounded-lg border bg-background px-3 py-2.5">
                <p className="text-xs text-muted-foreground">
                  {others.length === 1 ? 'One is' : `${others.length} are`} not on WordPress.org. {production.host}, the server saved for Refresh from production, may have {others.length === 1 ? 'it' : 'them'}: asking only reads its list of plugins.
                </p>
                <ServerPassword id="missing-server-secret" host={production.host} value={secret} onChange={setSecret} />
                <Button variant="outline" className="w-fit" disabled={asking} onClick={ask}>
                  {asking ? <LoaderCircle className="animate-spin" /> : <Server />}
                  See what {production.host} has
                </Button>
                {serverError && <p role="alert" className="text-xs text-danger">{serverError}</p>}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {others.length === 1 ? 'One is' : `${others.length} are`} not on WordPress.org. To copy {others.length === 1 ? 'it' : 'them'} from the site's server, save the server under Refresh from production on the Database tab first.
              </p>
            )
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={fromWporg.length === 0 || running} onClick={() => void install.follow(api.startJob('site.installPlugins', { ...siteTarget(site), plugins: fromWporg.map((p) => ({ slug: pluginSlug(p), ...(p.version ? { version: p.version } : {}) })) }))}>
              {install.job?.status === 'running' ? <LoaderCircle className="animate-spin" /> : <Download />}
              Install {fromWporg.length || ''} from WordPress.org
            </Button>
            {server && production && (
              <Button
                variant="outline"
                disabled={fromServer.length === 0 || running}
                onClick={() => void copy.follow(api.startJob('site.copyFromServer', {
                  ...siteTarget(site),
                  host: production.host,
                  folder: production.folder,
                  ...(production.wpCli ? { wpCli: production.wpCli } : {}),
                  plugins: [...new Set(fromServer.map((p) => pluginItem(p.file)))],
                  themes: [],
                  ...(secret ? { password: secret } : {}),
                }))}
              >
                {copy.job?.status === 'running' ? <LoaderCircle className="animate-spin" /> : <Server />}
                Copy {fromServer.length || ''} from {production.host}
              </Button>
            )}
          </div>
        </div>
      )}
      <JobFooter job={install.job} error={install.error} onRetry={() => void install.retry()} />
      <JobFooter job={copy.job} error={copy.error} onRetry={() => void copy.retry()} />
    </section>
  );
}
