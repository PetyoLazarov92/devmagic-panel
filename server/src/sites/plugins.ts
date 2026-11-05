import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionInput, SitePlugin, SitePlugins } from '@devmagic-panel/shared';
import { LOCAL_HELPER_PLUGINS, repoKey, repoPreset } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from '../exec.js';
import type { RunStore } from '../store.js';
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
