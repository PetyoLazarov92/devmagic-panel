import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Site } from '@devmagic-panel/shared';
import { headerUrl, readPlugins } from '../src/sites/plugins.js';
import { siteFor } from '../src/sites/site-actions.js';
import { RunStore } from '../src/store.js';
import { affects, checkSite, compareVersions, parseVulnerabilities, vulnerabilitiesOf, vulnerabilityItems, VulnerabilityWatch } from '../src/vulnerabilities.js';
import { fakeExec, wpSiteTree } from './helpers.js';

const base = (docroot: string) => `wp --path=${docroot} --url=https://local.shop.com/`;
const entry = (min: string | null, max: string, maxOp = 'lt', extra: Record<string, unknown> = {}) => ({
  name: `Hello Wands < ${max}: cross-site scripting`,
  operator: { min_version: min, min_operator: min ? 'ge' : null, max_version: max, max_operator: maxOp, unfixed: '0', closed: '0' },
  source: [{ id: 'CVE-2026-0001', link: 'https://www.cve.org/CVERecord?id=CVE-2026-0001' }],
  impact: { cvss3: { score: '6.1', severity: 'medium' } },
  ...extra,
});
const answer = (list: unknown[]) => ({ error: 0, data: { name: 'Hello Wands', vulnerability: list } });

describe('known vulnerabilities', () => {
  it('compares versions part by part and reads version ranges', () => {
    expect(compareVersions('5.10', '5.9')).toBe(1);
    expect(compareVersions('6.2', '6.2.0')).toBe(0);
    expect(compareVersions('6.2-beta1', '6.2')).toBe(-1);
    const [r] = parseVulnerabilities(answer([entry('1.0', '1.7.3')]));
    expect(r).toMatchObject({ fixedIn: '1.7.3', severity: 'medium', score: 6.1, link: 'https://www.cve.org/CVERecord?id=CVE-2026-0001' });
    expect(affects(r!, '1.7.2')).toBe(true);
    expect(affects(r!, '1.7.3')).toBe(false);
    expect(affects(r!, '0.9')).toBe(false);
    // Closed ones are left out; unfixed ones say so; a link that is not https is dropped.
    const parsed = parseVulnerabilities(answer([entry(null, '2.0', 'le', { operator: { max_version: '2.0', max_operator: 'le', unfixed: '1', closed: '0' }, source: [{ link: 'javascript:x' }] }), entry(null, '1.0', 'lt', { operator: { max_version: '1.0', max_operator: 'lt', closed: '1' } })]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ unfixed: true });
    expect(parsed[0]?.link).toBeUndefined();
    expect(parseVulnerabilities({ error: 1 })).toEqual([]);
  });

  it('asks once a day per slug, never for a name that is not a slug, and keeps nothing from a failed request', async () => {
    const store = new RunStore(':memory:');
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      asked.push(url);
      if (url.includes('down')) throw new Error('timeout');
      return { status: 200, body: answer([entry(null, '1.7.3')]) };
    };
    const now = Date.parse('2026-11-11T10:00:00Z');
    expect(await vulnerabilitiesOf('plugin', 'hello-wands', store, fetcher, now)).toHaveLength(1);
    await vulnerabilitiesOf('plugin', 'hello-wands', store, fetcher, now + 3_600_000);
    expect(await vulnerabilitiesOf('plugin', 'down', store, fetcher, now)).toBeNull();
    expect(await vulnerabilitiesOf('plugin', '../x', store, fetcher, now)).toEqual([]);
    expect(asked).toEqual(['https://www.wpvulnerability.net/plugin/hello-wands/', 'https://www.wpvulnerability.net/plugin/down/']);
  });

  it('asks again on Check now about an answer older than an hour, not one just read', async () => {
    const store = new RunStore(':memory:');
    const asked: string[] = [];
    const fetcher = async (url: string) => (asked.push(url), { status: 200, body: answer([]) });
    const now = Date.parse('2026-11-11T10:00:00Z');
    await vulnerabilitiesOf('plugin', 'hello-wands', store, fetcher, now);
    await vulnerabilitiesOf('plugin', 'hello-wands', store, fetcher, now + 10 * 60_000, 3_600_000);
    expect(asked).toHaveLength(1);
    await vulnerabilitiesOf('plugin', 'hello-wands', store, fetcher, now + 2 * 3_600_000, 3_600_000);
    expect(asked).toHaveLength(2);
  });

  it('checks only plugins and themes WordPress.org has, at the version installed, and only when switched on', async () => {
    const t = wpSiteTree();
    mkdirSync(join(t.docroot, 'wp-content/plugins/hello-wands'), { recursive: true });
    writeFileSync(join(t.docroot, 'wp-content/plugins/hello-wands/hello-wands.php'), '<?php\n/*\n * Plugin Name: Hello Wands\n * Plugin URI: https://wandworks.example/hello-wands/\n * Author URI: javascript:alert(1)\n */');
    const b = base(t.docroot);
    const fake = fakeExec({
      [`${b} plugin list`]: { stdout: JSON.stringify([{ name: 'hello-wands', title: 'Hello Wands', status: 'active', version: '1.7.2', update: 'none', update_version: '', file: 'hello-wands/hello-wands.php' }, { name: 'wandworks-pro', title: 'Wandworks Pro', status: 'active', version: '2.0.0', update: 'none', update_version: '', file: 'wandworks-pro/wandworks-pro.php' }]) },
      [`${b} transient get update_plugins`]: { stdout: JSON.stringify({ no_update: { 'hello-wands/hello-wands.php': { slug: 'hello-wands' } } }) },
      [`${b} theme list`]: { stdout: '[]' },
      [`${b} transient get update_themes`]: { stdout: '{}' },
    });
    const asked: string[] = [];
    const fetcher = async (url: string) => (asked.push(url), { status: 200, body: answer([entry('1.0', '1.7.3')]) });
    const store = new RunStore(':memory:');
    const site = siteFor(t.config, 'local.shop.com');
    // The list links out only to http(s) addresses, and knows the WordPress.org slug from WordPress's own update check.
    const listed = (await readPlugins(fake.exec, site)).plugins.find((p) => p.name === 'hello-wands');
    expect(listed).toMatchObject({ pluginUri: 'https://wandworks.example/hello-wands/', wporg: 'hello-wands' });
    expect(listed?.authorUri).toBeUndefined();
    expect(headerUrl(' * Author URI: https://user:pw@wandworks.example/', 'Author URI')).toBe('');
    const found = await checkSite(fake.exec, site, store, fetcher);
    // The custom plugin is never named outside.
    expect(asked).toEqual(['https://www.wpvulnerability.net/plugin/hello-wands/']);
    expect(found.checked).toBe(1);
    expect(found.hits).toEqual([{ kind: 'plugin', slug: 'hello-wands', title: 'Hello Wands', version: '1.7.2', name: 'hello-wands', vulnerabilities: [expect.objectContaining({ fixedIn: '1.7.3', severity: 'medium' })] }]);

    const items = vulnerabilityItems([{ domain: 'local.shop.com' } as Site], () => found);
    expect(items[0]).toMatchObject({ id: 'site.vulnerable', status: 'warn', domain: 'local.shop.com', text: 'Hello Wands 1.7.2 has 1 known vulnerability, the worst medium: fixed in 1.7.3' });
    // A fixed version and a plugin folder: Update, a snapshot first, asked first.
    expect(items[0]?.fix).toMatchObject({ action: 'site.updatePlugins', input: { domain: 'local.shop.com', plugins: ['hello-wands'], themes: [], snapshot: true }, label: 'Update Hello Wands' });
    expect(items[0]?.fix?.confirm).toContain('Undo on the job puts 1.7.2 back');
    // Nothing fixed yet, or no folder the panel updates (a must-use plugin, a theme in a repo): no Update.
    const unfixed = { ...found, hits: found.hits.map((h) => ({ ...h, vulnerabilities: h.vulnerabilities.map(({ fixedIn: _f, ...v }) => ({ ...v, unfixed: true as const })) })) };
    expect(vulnerabilityItems([{ domain: 'local.shop.com' } as Site], () => unfixed)[0]?.fix).toBeUndefined();
    const noFolder = { ...found, hits: found.hits.map(({ name: _n, ...h }) => h) };
    expect(vulnerabilityItems([{ domain: 'local.shop.com' } as Site], () => noFolder)[0]?.fix).toBeUndefined();

    const watch = new VulnerabilityWatch(store, fake.exec, t.config, fetcher);
    const sites = async () => [{ domain: 'local.shop.com', core: { kind: 'wpcore' } } as unknown as Site];
    watch.maybeStart(sites);
    expect(watch.running()).toBe(false);
    store.setMeta('preferences', JSON.stringify({ checkVulnerabilities: true }));
    watch.maybeStart(sites);
    expect(watch.running()).toBe(true);
    await watch.settled();
    expect(watch.kept('local.shop.com')?.hits).toHaveLength(1);
    // Once a day, unless asked.
    watch.maybeStart(sites);
    expect(watch.running()).toBe(false);
    // A result kept by an older release (without each hit's folder) is checked again at once.
    store.setMeta('vulns-format', '1');
    watch.maybeStart(sites);
    expect(watch.running()).toBe(true);
    await watch.settled();
    watch.maybeStart(sites);
    expect(watch.running()).toBe(false);
  });
});
