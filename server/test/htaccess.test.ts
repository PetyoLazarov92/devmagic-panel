import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { Jobs } from '../src/jobs.js';
import { discoverSites } from '../src/sites/discover.js';
import { ensureHtaccess, hasNetworkRules, htaccessFor } from '../src/sites/htaccess.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, wpSiteTree } from './helpers.js';

describe('htaccessFor', () => {
  it('writes WordPress\'s rules for a single site and both kinds of network', () => {
    expect(htaccessFor('single')).toContain('RewriteRule . /index.php [L]');
    const sub = htaccessFor('subdirectory');
    expect(sub).toContain('RewriteRule ^([_0-9a-zA-Z-]+/)?wp-admin$ $1wp-admin/ [R=301,L]');
    expect(sub).toContain('RewriteRule ^([_0-9a-zA-Z-]+/)?(.*\\.php)$ $2 [L]');
    const dom = htaccessFor('subdomain');
    expect(dom).toContain('RewriteRule ^wp-admin$ wp-admin/ [R=301,L]');
    expect(dom).toContain('RewriteRule ^(wp-(content|admin|includes).*) $1 [L]');
    for (const text of [htaccessFor('single'), sub, dom]) expect(text).toMatch(/^# BEGIN WordPress[\s\S]*# END WordPress\n$/);
  });
});

describe('hasNetworkRules', () => {
  it("finds the network rules in WordPress's order and in any other", () => {
    expect(hasNetworkRules(htaccessFor('subdirectory'))).toBe(true);
    expect(hasNetworkRules(htaccessFor('subdomain'))).toBe(true);
    // As a repo may have it: the folders in another order, after a plugin's own block.
    const byHand = [
      '# BEGIN Acme Images',
      'AddType image/webp .webp',
      '# END Acme Images',
      '# BEGIN WordPress',
      'RewriteEngine On',
      'RewriteBase /',
      'RewriteRule ^index\\.php$ - [L]',
      'RewriteRule ^([[_0-9a-zA-Z-]+/]*)?wp-admin$ $1wp-admin/ [R=301,L]',
      'RewriteRule ^(.+)?/(wp-(includes|admin|content)(/.*)?) $2 [L]',
      'RewriteRule . index.php [L]',
      '# END WordPress',
    ].join('\n');
    expect(hasNetworkRules(byHand)).toBe(true);
  });

  it('finds none in single-site rules, or in a rule that is commented out', () => {
    expect(hasNetworkRules(htaccessFor('single'))).toBe(false);
    expect(hasNetworkRules(`${htaccessFor('single')}\n# RewriteRule ^(.+)?/(wp-(includes|admin|content)(/.*)?) $2 [L]\n`)).toBe(false);
    expect(hasNetworkRules('RewriteRule ^(wp-(content|includes).*) $1 [L]\n')).toBe(false);
  });
});

describe('ensureHtaccess', () => {
  it('writes the file when missing and keeps it out of git locally', async () => {
    const t = wpSiteTree();
    mkdirSync(join(t.docroot, '.git/info'), { recursive: true });
    const { exec } = fakeExec({
      [`git -C ${t.docroot} rev-parse --show-toplevel`]: { stdout: `${t.docroot}\n` },
      [`git -C ${t.docroot} rev-parse --git-path info/exclude`]: { stdout: '.git/info/exclude\n' },
    });
    expect((await ensureHtaccess(exec, t.docroot, 'single')).stdout).toContain('single site rules');
    expect(readFileSync(join(t.docroot, '.git/info/exclude'), 'utf8')).toContain('/.htaccess');
  });

  it('never touches an existing file, tracked or not', async () => {
    const t = wpSiteTree();
    writeFileSync(join(t.docroot, '.htaccess'), '# mine\n');
    const fake = fakeExec();
    await ensureHtaccess(fake.exec, t.docroot, 'subdirectory');
    expect(readFileSync(join(t.docroot, '.htaccess'), 'utf8')).toBe('# mine\n');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('the .htaccess Aura checks and fix', () => {
  const certFor = (cert: string) => ({ [`openssl x509 -in ${cert}`]: { stdout: 'notAfter=Jan 26 09:00:00 2029 GMT\nissuer=O = devmagic-panel\nX509v3 Subject Alternative Name: \n    DNS:local.shop.com, DNS:local.shop.de, DNS:www.local.shop.com\n' } });

  it('flags single-site rules on a subdirectory network, and nothing once network rules are there', async () => {
    const t = wpSiteTree({ multisite: true });
    writeFileSync(join(t.docroot, '.htaccess'), htaccessFor('single'));
    const ids = async () => (await discoverSites({ config: t.config, exec: fakeExec(certFor(t.cert)).exec, secrets: null, wpcoreConf: t.wpcoreConf }))[0]?.issues.map((i) => i.id);
    expect(await ids()).toContain('htaccess.single');
    writeFileSync(join(t.docroot, '.htaccess'), htaccessFor('subdirectory'));
    expect(await ids()).not.toContain('htaccess.single');
  });

  it('writes the missing file for the site kind wp-config.php says', async () => {
    const t = wpSiteTree({ multisite: true });
    const store = new RunStore(':memory:');
    const ctx: ActionContext = {
      config: t.config, exec: fakeExec().exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
      jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
    };
    expect((await runAction(ctx, 'site.writeHtaccess', { domain: 'local.shop.com' })).ok).toBe(true);
    expect(readFileSync(join(t.docroot, '.htaccess'), 'utf8')).toBe(htaccessFor('subdirectory'));
  });
});
