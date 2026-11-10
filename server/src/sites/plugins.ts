import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionInput, SitePlugin, SitePlugins, SiteTheme, SiteThemes } from '@devmagic-panel/shared';
import { LOCAL_HELPER_PLUGINS, repoKey, repoPreset } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from '../exec.js';
import type { RunStore } from '../store.js';
import { themeFolders } from './local-mode.js';
import { siteFor, SiteActionRefused, type HandlerOutcome, type SiteActionContext, type SiteRef } from './site-actions.js';

interface WpPluginRow {
  name: string;
  title: string;
  status: string;
  version: string;
  update: string;
  update_version: string;
  file: string;
}

const STATUSES = new Set<SitePlugin['status']>(['active', 'inactive', 'active-network', 'must-use', 'dropin']);

/** The plugins the last install of a site's repo turned off as production-only, from the wizard's answers kept for that repo. */
export function productionOnlyFor(store: RunStore, host: string): string[] {
  const repo = store.installs().get(host)?.repo;
  const key = repo ? repoKey(repo) : null;
  const preset = key ? repoPreset.safeParse(store.preset(key)) : undefined;
  return preset?.success ? preset.data.deactivate : [];
}

/** The plugins another one needs, from its Requires Plugins header (WordPress 6.5). */
export function requiredPlugins(header: string): string[] {
  const line = /^[ \t/*#@]*Requires Plugins:(.*)$/im.exec(header)?.[1] ?? '';
  return line.split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9_-]{1,100}$/.test(s));
}

/** The first 8 KB of a plugin's main file, where WordPress reads its headers too; empty when it cannot be read. */
function headerOf(file: string): string {
  try {
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(8192);
      return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Every plugin of a site as WP-CLI lists it, with what the panel knows about
 * each: what it needs and what needs it, an update WordPress already found
 * (no check is made, so nothing goes out), and whether the install turned it
 * off as production-only or it is a local helper. Plugins and the theme are
 * not loaded, so a broken one cannot stop the list.
 */
export async function readPlugins(exec: Executor, site: SiteRef, productionOnly: readonly string[] = []): Promise<SitePlugins> {
  const result = await exec(
    'wp',
    [`--path=${site.docroot}`, `--url=https://${site.host}/`, 'plugin', 'list', '--format=json', '--fields=name,title,status,version,update,update_version,file', '--skip-update-check', '--skip-plugins', '--skip-themes'],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) throw new SiteActionRefused(`WP-CLI could not list the plugins: ${(result.stderr || result.stdout).trim().split('\n').at(-1) ?? ''}`);
  let rows: WpPluginRow[];
  try {
    rows = JSON.parse(result.stdout) as WpPluginRow[];
  } catch {
    throw new SiteActionRefused('WP-CLI listed the plugins in a form the panel cannot read');
  }
  const pluginDir = join(site.docroot, 'wp-content', 'plugins');
  const plugins = rows
    .filter((r) => STATUSES.has(r.status as SitePlugin['status']))
    .map((r): SitePlugin => {
      const status = r.status as SitePlugin['status'];
      const requires = status === 'must-use' || status === 'dropin' ? [] : requiredPlugins(headerOf(join(pluginDir, r.file)));
      return {
        name: r.name,
        title: r.title || r.name,
        status,
        version: r.version,
        ...(r.update === 'available' && r.update_version ? { update: r.update_version } : {}),
        ...(requires.length ? { requires } : {}),
        ...(productionOnly.includes(r.name) ? { productionOnly: true as const } : {}),
        ...(r.name in LOCAL_HELPER_PLUGINS ? { localHelper: true as const } : {}),
      };
    });
  const on = (p: SitePlugin) => p.status === 'active' || p.status === 'active-network';
  for (const p of plugins) {
    const by = plugins.filter((other) => on(other) && other.requires?.includes(p.name)).map((other) => other.title);
    if (by.length) p.requiredBy = by;
  }
  return { plugins, network: site.wp.multisite };
}

/**
 * Turns one plugin on or off, like its link in wp-admin: its activation or
 * deactivation hook runs with the other plugins loaded. On a network it is
 * network-activated, and one active on the main site only is deactivated there.
 */
export async function setPlugin(ctx: SiteActionContext, { domain, path, plugin, active }: ActionInput<'site.pluginSet'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  const current = (await readPlugins(ctx.exec, site)).plugins.find((p) => p.name === plugin);
  if (!current) throw new SiteActionRefused(`${site.host} has no plugin called ${plugin}`);
  if (current.status === 'must-use' || current.status === 'dropin') throw new SiteActionRefused(`${current.title} is ${current.status === 'dropin' ? 'a drop-in' : 'a must-use plugin'}: WordPress always loads it, so it cannot be turned on or off`);
  const isOn = current.status === 'active' || current.status === 'active-network';
  if (isOn === active) return { results: [{ code: 0, stdout: `${current.title} is already ${active ? 'on' : 'off'}`, stderr: '' }] };
  const network = site.wp.multisite && (active || current.status === 'active-network');
  const result: ExecResult = await ctx.exec(
    'wp',
    [`--path=${site.docroot}`, `--url=https://${site.host}/`, 'plugin', active ? 'activate' : 'deactivate', plugin, ...(network ? ['--network'] : [])],
    { timeoutMs: 120_000 },
  );
  return { results: [result] };
}

interface WpThemeRow {
  name: string;
  title?: string;
  status: string;
  version?: string;
  update?: string;
  update_version?: string;
}

/**
 * Every theme of a site, read with WP-CLI and nothing of the site loaded,
 * plus the themes in repos under wp-content/repos, which WordPress finds
 * through Local mode and WP-CLI therefore does not list here: those are read
 * from their folders, with the name and version style.css gives.
 */
export async function readThemes(exec: Executor, site: SiteRef): Promise<SiteThemes> {
  const wp = (args: string[]) => exec('wp', [`--path=${site.docroot}`, `--url=https://${site.host}/`, ...args, '--skip-plugins', '--skip-themes'], { timeoutMs: 60_000 });
  const result = await wp(['theme', 'list', '--format=json', '--fields=name,title,status,version,update,update_version', '--skip-update-check']);
  if (result.code !== 0) throw new SiteActionRefused(`WP-CLI could not list the themes: ${(result.stderr || result.stdout).trim().split('\n').at(-1) ?? ''}`);
  let rows: WpThemeRow[];
  try {
    rows = JSON.parse(result.stdout) as WpThemeRow[];
  } catch {
    throw new SiteActionRefused('WP-CLI listed the themes in a form the panel cannot read');
  }
  const themes = rows
    .filter((r) => typeof r.name === 'string' && ['active', 'parent', 'inactive'].includes(r.status))
    .map((r): SiteTheme => ({
      name: r.name,
      title: r.title || r.name,
      status: r.status as SiteTheme['status'],
      version: r.version ?? '',
      ...(r.update === 'available' && r.update_version ? { update: r.update_version } : {}),
      folder: `wp-content/themes/${r.name}`,
    }));
  // Themes in a repo of their own: by folder, with what style.css says.
  const inRepos: SiteTheme[] = [];
  for (const folder of themeFolders(site.docroot)) {
    let names: string[] = [];
    try {
      names = readdirSync(join(site.docroot, 'wp-content', folder), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'node_modules' && d.name !== 'vendor').map((d) => d.name);
    } catch {
      // Gone since: nothing to list.
    }
    for (const name of names) {
      const dir = join(site.docroot, 'wp-content', folder, name);
      if (!existsSync(join(dir, 'functions.php')) && !existsSync(join(dir, 'style.css'))) continue;
      if (themes.some((t) => t.name === name) || inRepos.some((t) => t.name === name)) continue;
      const header = headerOf(join(dir, 'style.css'));
      const field = (label: string) => new RegExp(`^[ \\t/*#@]*${label}:(.*)$`, 'mi').exec(header)?.[1]?.trim();
      inRepos.push({ name, title: field('Theme Name') || name, status: 'inactive', version: field('Version') ?? '', folder: `wp-content/${folder}/${name}`, inRepo: true });
    }
  }
  if (inRepos.length) {
    const option = async (name: string) => {
      const r = await wp(['option', 'get', name]);
      return r.code === 0 ? r.stdout.trim() : '';
    };
    const own = await option('stylesheet');
    const template = await option('template');
    for (const t of inRepos) t.status = t.name === own ? 'active' : t.name === template ? 'parent' : 'inactive';
  }
  const order = { active: 0, parent: 1, inactive: 2 } as const;
  return { themes: [...themes, ...inRepos].sort((a, b) => order[a.status] - order[b.status] || a.title.localeCompare(b.title)), network: site.wp.multisite };
}
