import type { DumpPlugin, Site, WporgPlugin } from '@devmagic-panel/shared';
import { Download, LoaderCircle, PackageX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { JobFooter } from '@/components/job-box';
import { useJob } from '@/components/job-steps';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { pluginSlug } from '@/lib/missing-plugins';
import { siteTarget } from '@/lib/site-ref';

/**
 * Plugins the site's database names that its files lack, after a database
 * import or a pull: active ones, network-wide ones, and ones production had
 * installed. The ones on WordPress.org install from there, each on its own,
 * a failure noted and the rest installed; Undo removes them. Nothing shows
 * while every plugin is there.
 */
export function MissingPluginsCard({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const [missing, setMissing] = useState<DumpPlugin[] | null>(null);
  const [wporg, setWporg] = useState<Record<string, WporgPlugin | null>>({});
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const job = useJob();
  const read = () =>
    api.missingPlugins(site.domain, site.path).then(async (list) => {
      setMissing(list);
      const answers = list.length ? await api.wporgPlugins([...new Set(list.map(pluginSlug))]).catch((): Record<string, WporgPlugin | null> => ({})) : ({} as Record<string, WporgPlugin | null>);
      setWporg(answers);
      // Active ones on WordPress.org start ticked; ones production only had installed, not.
      setTicked(new Set(list.filter((p) => p.active && answers[pluginSlug(p)]).map((p) => p.file)));
    }, () => setMissing([]));
  useEffect(() => {
    void read();
  }, [site.domain, site.path]);
  useEffect(() => {
    if (job.job?.status === 'done') {
      void read();
      onChanged();
    }
  }, [job.job?.status]);

  if (!missing || (missing.length === 0 && !job.job)) return null;
  const chosen = missing.filter((p) => ticked.has(p.file) && wporg[pluginSlug(p)]);
  const install = () =>
    void job.follow(api.startJob('site.installPlugins', { ...siteTarget(site), plugins: chosen.map((p) => ({ slug: pluginSlug(p), ...(p.version ? { version: p.version } : {}) })) }));
  return (
    <Card>
      <CardHeader><CardTitle>Missing plugins</CardTitle><PackageX className="size-4 text-muted-foreground" /></CardHeader>
      <div className="grid gap-3 p-5 text-sm">
        <p className="text-xs text-muted-foreground">
          The database names {missing.length === 1 ? 'this plugin' : `these ${missing.length} plugins`}, but the site's files lack {missing.length === 1 ? 'it' : 'them'}. WordPress turns a missing active plugin off on its own. Ones on WordPress.org install from there at production's version when the database says it, checked against WordPress.org's checksums and kept out of git locally.
        </p>
        <ul className="grid gap-1.5">
          {missing.map((p) => {
            const slug = pluginSlug(p);
            const wp = wporg[slug];
            const id = `missing-${p.file.replace(/[^\w-]/g, '-')}`;
            return (
              <li key={p.file} className="flex items-start gap-2.5">
                <input
                  id={id}
                  type="checkbox"
                  disabled={!wp}
                  checked={ticked.has(p.file) && Boolean(wp)}
                  onChange={(e) => setTicked((t) => {
                    const next = new Set(t);
                    if (e.target.checked) next.add(p.file);
                    else next.delete(p.file);
                    return next;
                  })}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                />
                <label htmlFor={id} className="grid min-w-0 gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{wp?.name ?? slug}</span>
                    <code className="font-mono text-[12px] text-muted-foreground">{p.file}</code>
                    {p.active ? <Badge tone="warning">active{p.network ? ', network' : p.sites && p.sites > 1 ? ` on ${p.sites} sites` : ''}</Badge> : <Badge>installed on production</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {wp ? `On WordPress.org${p.version ? `: installs ${p.version} (latest ${wp.version})` : `, latest ${wp.version}`}` : 'Not on WordPress.org: get it from its vendor or from production'}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <Button className="w-fit" disabled={chosen.length === 0 || (job.job !== null && job.job.status === 'running')} onClick={install}>
          {job.job?.status === 'running' ? <LoaderCircle className="animate-spin" /> : <Download />}
          Install {chosen.length || ''} from WordPress.org
        </Button>
      </div>
      <JobFooter job={job.job} error={job.error} onRetry={() => void job.retry()} />
    </Card>
  );
}
