import type { MissingScanState, Site, SitePlugins, SiteThemes } from '@devmagic-panel/shared';
import { Palette, Plug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Link } from '@/lib/router';
import { siteHref } from '@/lib/site-ref';
import { cn } from '@/lib/utils';

/**
 * The site's plugins and themes in two lines on the Overview's WordPress
 * card, read after the card shows: how many, how many on, updates WordPress
 * already found, and what the last missing scan found (it never starts one
 * from here). Each line goes to its view on the Plugins tab. A read that
 * fails leaves its line out.
 */
export function WordPressSummary({ site }: { site: Site }) {
  const [plugins, setPlugins] = useState<SitePlugins | null | undefined>(undefined);
  const [themes, setThemes] = useState<SiteThemes | null | undefined>(undefined);
  const [missing, setMissing] = useState<MissingScanState | null>(null);
  useEffect(() => {
    let live = true;
    setPlugins(undefined);
    setThemes(undefined);
    void api.plugins(site.domain, site.path).then((p) => live && setPlugins(p), () => live && setPlugins(null));
    void api.themes(site.domain, site.path).then((t) => live && setThemes(t), () => live && setThemes(null));
    void api.missing(site.domain, site.path, true).then((m) => live && setMissing(m), () => undefined);
    return () => {
      live = false;
    };
  }, [site.domain, site.path]);

  const scan = missing?.scan;
  const base = `${siteHref(site)}?tab=plugins`;
  const lines: Array<{ key: string; href: string; icon: typeof Plug; loading: boolean; parts: Array<{ text: string; tone?: 'warning' }> } | null> = [
    plugins === null
      ? null
      : {
          key: 'plugins',
          // With updates, straight to them on the Plugins view.
          href: plugins?.plugins.some((p) => p.update) ? `${base}&show=updates` : base,
          icon: Plug,
          loading: plugins === undefined,
          parts: plugins
            ? [
                ...count(plugins.plugins.filter((p) => p.status !== 'must-use' && p.status !== 'dropin').length, 'plugin', 'plugins', undefined, true),
                { text: `${plugins.plugins.filter((p) => p.status === 'active' || p.status === 'active-network').length} on` },
                ...count(plugins.plugins.filter((p) => p.status === 'must-use').length, 'must-use'),
                ...count(plugins.plugins.filter((p) => p.update).length, 'update', 'updates', 'warning'),
                ...count(scan?.plugins.length ?? 0, 'missing', 'missing', 'warning'),
              ]
            : [],
        },
    themes === null
      ? null
      : {
          key: 'themes',
          href: `${base}&view=themes`,
          icon: Palette,
          loading: themes === undefined,
          parts: themes
            ? [
                { text: `${themes.themes.length} theme${themes.themes.length === 1 ? '' : 's'}` },
                { text: themes.themes.find((t) => t.status === 'active') ? `${themes.themes.find((t) => t.status === 'active')?.title} on` : 'none on' },
                ...count(themes.themes.filter((t) => t.update).length, 'update', 'updates', 'warning'),
                ...count(scan?.themes.length ?? 0, 'missing', 'missing', 'warning'),
              ]
            : [],
        },
  ];
  const shown = lines.filter((l) => l !== null);
  if (shown.length === 0) return null;
  return (
    <ul className="grid gap-1.5 text-sm" aria-label="Plugins and themes">
      {shown.map(({ key, href, icon: Icon, loading, parts }) => (
        <li key={key}>
          <Link href={href} className="group flex items-start gap-2 rounded-md">
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            {loading ? (
              <span className="mt-1 h-3.5 w-48 max-w-full animate-pulse rounded bg-muted" aria-label={`Reading the ${key}`} />
            ) : (
              <span className="min-w-0 group-hover:underline">
                {parts.map((p, i) => (
                  <span key={p.text} className={cn(i > 0 && 'text-muted-foreground', p.tone === 'warning' && 'text-warning')}>
                    {i > 0 ? ', ' : ''}
                    {p.text}
                  </span>
                ))}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** "3 updates", or nothing for none, unless it is the line's first count. */
const count = (n: number, one: string, many = one, tone?: 'warning', always = false) => (n > 0 || always ? [{ text: `${n} ${n === 1 ? one : many}`, ...(tone ? { tone } : {}) }] : []);
