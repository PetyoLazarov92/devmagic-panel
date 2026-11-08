import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { Jobs } from '../src/jobs.js';
import { discoverSites } from '../src/sites/discover.js';
import { dismissHtaccessChange, htaccessDismissed, HtaccessWatcher } from '../src/sites/htaccess-watch.js';
import { readHtaccessReport, reportSums } from '../src/sites/htaccess-rules.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, wpSiteTree } from './helpers.js';

const MARKER = '# Managed by devmagic-panel. Edits here are overwritten.';

/** The WordPress site of the temp tree on nginx alone, its nginx file with the given rules, and its .htaccess. */
function onNginx(htaccess: string, rules: string[] = []) {
  const t = wpSiteTree();
  const domain = 'local.shop.com';
  const docroot = t.docroot;
  mkdirSync(docroot, { recursive: true });
  writeFileSync(join(docroot, '.htaccess'), htaccess);
  const file = join(t.config.NGINX_SITES_AVAILABLE, `${domain}.conf`);
  writeFileSync(file, `${MARKER}\n# kind: single\n${rules.map((r) => `# rule: ${r}\n`).join('')}server {\n    server_name ${domain};\n    root ${docroot};\n}\n`);
  symlinkSync(file, join(t.config.NGINX_SITES_ENABLED, `${domain}.conf`));
  // Only nginx has the site now.
  rmSync(join(t.config.APACHE_SITES_ENABLED, `${domain}-ssl.conf`), { force: true });
  return { t, domain, docroot };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('noticing .htaccess changes on nginx', () => {
  it('says what a change is: rules for nginx, rules nginx does nothing with, or quiet', () => {
    const { t, domain, docroot } = onNginx('Redirect 301 /old /new\n', ['redirect 301 ^/old(/.*)?$ /new$1']);
    let clock = Date.parse('2026-11-08T10:00:00Z');
    const watcher = new HtaccessWatcher(t.config, () => clock);
    watcher.refresh();
    try {
      expect(watcher.check(domain)).toBeUndefined();
      clock += 1000;
      writeFileSync(join(docroot, '.htaccess'), 'Redirect 301 /old /new\n# BEGIN W3TC Browser Cache\nExpiresActive On\n# END W3TC Browser Cache\n');
      expect(watcher.check(domain)).toMatchObject({ kind: 'quiet', added: 0, removed: 0 });
      clock += 1000;
      writeFileSync(join(docroot, '.htaccess'), 'Redirect 301 /old /new\nSetEnv WANDWORKS 1\n');
      expect(watcher.check(domain)).toMatchObject({ kind: 'manual' });
      clock += 1000;
      writeFileSync(join(docroot, '.htaccess'), 'Redirect 301 /old /newer\nSetEnv WANDWORKS 1\n');
      expect(watcher.check(domain)).toMatchObject({ kind: 'rules', added: 1, removed: 1 });
      expect(watcher.changes('2026-11-08T10:00:01.500Z').changes.map((c) => c.kind)).toEqual(['manual', 'rules']);
      expect(watcher.changes().changes).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it('notices a write through the kernel, once for a burst', async () => {
    const { t, domain, docroot } = onNginx('Redirect 301 /old /new\n');
    const watcher = new HtaccessWatcher(t.config, Date.now, 50);
    watcher.refresh();
    try {
      const since = new Date(Date.now() - 1).toISOString();
      writeFileSync(join(docroot, '.htaccess'), 'Redirect 301 /old /a\n');
      writeFileSync(join(docroot, '.htaccess'), 'Redirect 301 /old /b\n');
      for (let i = 0; i < 40 && watcher.changes(since).changes.length === 0; i++) await wait(50);
      expect(watcher.changes(since).changes).toEqual([expect.objectContaining({ domain, kind: 'rules', added: 1 })]);
    } finally {
      watcher.close();
    }
  });

  it('keeps a change quiet on Aura once you put it off, until a file changes again', async () => {
    const { t, domain, docroot } = onNginx('Redirect 301 /old /new\n');
    const store = new RunStore(':memory:');
    const c: ActionContext = {
      config: t.config, exec: fakeExec().exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
      jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
    };
    const ids = async () => {
      const sites = await discoverSites({ config: t.config, exec: fakeExec().exec, secrets: null, wpcoreConf: t.wpcoreConf, htaccessDismissed: (d) => htaccessDismissed(store, d) });
      return sites.find((s) => s.domain === domain)?.issues.map((i) => i.id) ?? [];
    };
    expect(await ids()).toContain('nginx.htaccess.changed');
    const sums = reportSums(readHtaccessReport(docroot, undefined, 0, true));
    await runAction(c, 'site.dismissHtaccessChange', { domain, sums });
    expect(htaccessDismissed(store, domain)).toEqual(sums);
    expect(await ids()).not.toContain('nginx.htaccess.changed');
    expect(readHtaccessReport(docroot, { rules: [], sums: {} }, 0, true, sums)).toMatchObject({ pending: true, dismissed: true });
    writeFileSync(join(docroot, '.htaccess'), 'Redirect 301 /old /newer\n');
    expect(await ids()).toContain('nginx.htaccess.changed');
    dismissHtaccessChange(store, domain, {});
  });
});
