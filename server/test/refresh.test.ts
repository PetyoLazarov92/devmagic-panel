import { join } from 'node:path';
import { actions, defaultLeftOut, knownLeftOut, productionSettings } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import type { JobStep } from '../src/jobs.js';
import { planRefresh, readProduction, replaceFor, saveProduction } from '../src/sites/refresh.js';
import { RunStore } from '../src/store.js';
import { fakeExec, wpSiteTree } from './helpers.js';

const job = () => ({ progress: () => undefined, onUndo: () => undefined, activity: () => undefined }) as unknown as Parameters<JobStep['run']>[0];

describe('tables a copy from production leaves the rows of', () => {
  it("knows the logs and the personal data by the site's prefix, on every site of a network, and nothing else", () => {
    const tables = ['sb_options', 'sb_posts', 'sb_actionscheduler_logs', 'sb_3_redirection_404', 'sb_wc_orders', 'sb_3_gf_entry', 'sb_wfhits_backup', 'wp_wc_orders'];
    expect(knownLeftOut(tables)).toEqual({ logs: ['sb_actionscheduler_logs', 'sb_3_redirection_404'], personal: ['sb_wc_orders', 'sb_3_gf_entry'] });
  });

  it('ticks the logs at first, the personal data too for a cleaned copy, and what you left out last time over both', () => {
    const found = { tables: [{ name: 'wp_actionscheduler_logs', bytes: 9 }, { name: 'wp_wc_orders', bytes: 5 }, { name: 'wp_posts', bytes: 3 }], logs: ['wp_actionscheduler_logs'], personal: ['wp_wc_orders'] };
    expect(defaultLeftOut(found, false)).toEqual(['wp_actionscheduler_logs']);
    expect(defaultLeftOut(found, true)).toEqual(['wp_actionscheduler_logs', 'wp_wc_orders']);
    // A table gone from the server since is not kept.
    expect(defaultLeftOut({ ...found, remembered: ['wp_posts', 'wp_gone'] }, true)).toEqual(['wp_posts']);
  });

  it('take only table names, so nothing reaches the export command but letters, digits, _ and $', () => {
    const parse = (excludeRows: string[]) => actions['dump.fromServer'].input.safeParse({ host: 'spellbook-prod', mode: 'export', path: '/var/www/spellbook/public', excludeRows }).success;
    expect(parse(['wp_actionscheduler_logs', 'wp$x'])).toBe(true);
    for (const bad of ['wp_logs,wp_users', 'wp logs', '--where=1', 'wp_`x`', 'a'.repeat(65)]) expect(parse([bad])).toBe(false);
  });
});

describe('Refresh from production', () => {
  it('keeps the settings per site with no secret, and remembers the tables for that server and folder', () => {
    const store = new RunStore(':memory:');
    expect(readProduction(store, 'local.spellbook.example', '/learn')).toBeNull();
    const settings = productionSettings.parse({ host: 'spellbook-prod', folder: '/var/www/spellbook/public/learn', excludeRows: ['wp_2_redirection_404'], clean: true, keep: 'alex' });
    saveProduction(store, 'local.spellbook.example', '/learn', settings);
    expect(readProduction(store, 'local.spellbook.example', '/learn')).toEqual(settings);
    expect(readProduction(store, 'local.spellbook.example')).toBeNull();
    expect(store.getMeta('server-export:spellbook-prod|/var/www/spellbook/public/learn')).toBe('["wp_2_redirection_404"]');
    for (const bad of [{ host: '-oProxyCommand=x', folder: '/var/www' }, { host: 'spellbook-prod', folder: '/var/www/$(id)' }, { host: 'spellbook-prod', folder: '/var/www', keep: 'alex;drop' }]) {
      expect(productionSettings.safeParse(bad).success).toBe(false);
    }
  });

  it("maps each production host to the site's local name for it when the site serves that, else to its main domain", () => {
    expect(replaceFor(['www.spellbook.example', 'shop.spellbook.example', 'local.spellbook.example'], { domain: 'local.spellbook.example', names: ['local.spellbook.example', 'local.shop.spellbook.example'] })).toEqual([
      { from: 'www.spellbook.example', to: 'local.spellbook.example' },
      { from: 'shop.spellbook.example', to: 'local.shop.spellbook.example' },
    ]);
  });

  it('needs its settings first, then exports over SSH reading only and hands the dump to the import, which refuses a dump on another prefix', async () => {
    const t = wpSiteTree();
    const store = new RunStore(':memory:');
    const uploadsDir = join(t.root, 'uploads');
    const sql = "-- MySQL dump\nCREATE TABLE `other_options` (x int);\nINSERT INTO `other_options` VALUES (1,'siteurl','https://www.shop.com','yes');\n-- Dump completed on 2026-11-09\n";
    const fake = fakeExec({ ssh: { stdout: sql } });
    const ctx = { config: t.config, exec: fake.exec, uploadsDir, dmpRoot: '/x', store, secrets: null };
    const input = actions['site.refreshFromProduction'].input.parse({ domain: 'local.shop.com', confirm: 'local.shop.com' });
    expect(() => planRefresh(ctx, input, () => undefined)).toThrow(/not set up/);
    saveProduction(store, 'local.shop.com', undefined, productionSettings.parse({ host: 'shop-prod', folder: '/var/www/shop', excludeRows: ['other_actionscheduler_logs'] }));
    let upload = '';
    const steps = planRefresh(ctx, input, (id) => (upload = id));
    expect(steps.map((s) => s.id)).toEqual(['export', 'copy']);
    const exported = await (steps[0] as JobStep).run(job());
    expect([exported].flat().every((r) => r.code === 0)).toBe(true);
    expect(upload).toMatch(/^[0-9a-f-]{36}$/);
    // Only wp db export ran on the server, its rows left out of one table and that table's structure taken on its own.
    const remote = fake.calls.filter((c) => c.file === 'ssh').map((c) => c.args.join(' '));
    expect(remote).toHaveLength(2);
    expect(remote.every((r) => r.includes('db export -') && r.includes('--path=/var/www/shop'))).toBe(true);
    expect(remote[0]).toContain('--exclude_tables=other_actionscheduler_logs');
    expect(remote[1]).toContain('--tables=other_actionscheduler_logs --no-data');
    const copied = [await (steps[1] as JobStep).run(job())].flat();
    expect(copied.at(-1)).toMatchObject({ code: 1, stderr: expect.stringContaining('table prefix other_') });
  });
});
