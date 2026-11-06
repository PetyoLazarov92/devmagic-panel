import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobStep } from '../src/jobs.js';
import { discoverSites } from '../src/sites/discover.js';
import { htaccessIgnored } from '../src/sites/htaccess.js';
import { hostsBlockAddress, hostsOutsideBlock, HOSTS_BEGIN, HOSTS_END } from '../src/sites/hosts-block.js';
import { moveRefusal, planSetServer, planSetServerAll } from '../src/sites/server-switch.js';
import { planNginxTeardown } from '../src/nginx.js';
import { parseNginxSite, readSiteVhosts } from '../src/sites/vhost.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, wpSiteTree } from './helpers.js';

const MARKER = '# Managed by devmagic-panel. Edits here are overwritten.';

/** The panel's nginx file for a site, as dmp_nginx_site_render writes it. */
const nginxFile = (root: string, domain: string, names: string, kind = 'single', proxy = '') => `${MARKER}
# kind: ${kind}
server {
    listen 127.0.0.2:80;
    server_name ${names};
    return 301 https://$host$request_uri;
}

server {
    listen 127.0.0.2:443 ssl http2;
    server_name ${names};
    root ${root}/www/${domain};
    ssl_certificate ${root}/certs/${domain}/${domain}.crt;
    ssl_certificate_key ${root}/certs/${domain}/${domain}.key;
    error_log ${root}/nginx/log/${domain}-error.log;
${proxy ? `    location @dmp_uploads {\n        return 302 https://${proxy}$request_uri;\n    }\n` : ''}    location ~ \\.php$ {
        fastcgi_pass dmp-php-${domain};
    }
}
`;

/** local.shop.com with the panel's Apache vhost, mod_php 8.3 and its PHP-FPM, and nginx set up. */
function tree({ nginxSetUp = true, fpm = true } = {}) {
  const t = wpSiteTree();
  const vhost = join(t.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
  writeFileSync(vhost, `${MARKER}\n<VirtualHost *:443>\n ServerName local.shop.com\n ServerAlias local.shop.de\n DocumentRoot ${t.docroot}\n SSLCertificateFile ${t.cert}\n</VirtualHost>\n`);
  t.write('mods-enabled/php8.3.load');
  mkdirSync(join(t.config.PHP_LIB_DIR, '8.3/sapi'), { recursive: true });
  if (fpm) t.write('php-lib/8.3/sapi/fpm');
  if (nginxSetUp) t.write('nginx/conf.d/devmagic-panel.conf', `${MARKER}\n`);
  t.write('hosts', `127.0.0.1 localhost\n${HOSTS_BEGIN}\n127.0.0.1 local.shop.com local.shop.de\n${HOSTS_END}\n`);
  return t;
}

/** The site moved to nginx: its nginx file enabled and its hosts line there; the Apache vhost gone unless kept. */
function onNginx(t: ReturnType<typeof tree>, { keepApache = false, kind = 'single' } = {}) {
  const file = join(t.config.NGINX_SITES_AVAILABLE, 'local.shop.com.conf');
  writeFileSync(file, nginxFile(t.root, 'local.shop.com', 'local.shop.com local.shop.de', kind));
  symlinkSync(file, join(t.config.NGINX_SITES_ENABLED, 'local.shop.com.conf'));
  t.write('hosts', `127.0.0.1 localhost\n${HOSTS_BEGIN}\n127.0.0.2 local.shop.com local.shop.de\n${HOSTS_END}\n`);
  if (!keepApache) rmSync(join(t.config.APACHE_SITES_ENABLED, 'local.shop.com-ssl.conf'));
}

function ctx(t: ReturnType<typeof tree>) {
  const fake = fakeExec({ [`sudo -n ${DMP}`]: { stdout: 'ok' }, curl: { stdout: '<html>\n200' } });
  const store = new RunStore(':memory:');
  const c: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
  };
  return { c, fake, lines: () => fake.calls.filter((x) => x.file === 'sudo').map((x) => x.args.slice(2).join(' ')) };
}

/** Runs a plan's steps in order like a job, collecting the Undo labels. */
async function runSteps(steps: JobStep[]) {
  const undos: string[] = [];
  const job = { onUndo: (label: string) => undos.push(label) } as unknown as Parameters<JobStep['run']>[0];
  for (const step of steps) {
    const out = await step.run(job);
    for (const r of Array.isArray(out) ? out : [out]) if (r.code !== 0) throw new Error(`${step.id}: ${r.stderr}`);
  }
  return undos;
}

describe('nginx sites read from the system', () => {
  it('parses the panel nginx file: names, folder, certificate, log, kind and uploads redirect', () => {
    const info = parseNginxSite(nginxFile('/srv', 'local.acme.com', 'local.acme.com www.local.acme.com', 'subdirectory', 'www.acme.com'), '/x/local.acme.com.conf');
    expect(info).toMatchObject({
      server: 'nginx', managed: true, names: ['local.acme.com', 'www.local.acme.com'], docroot: '/srv/www/local.acme.com',
      certFile: '/srv/certs/local.acme.com/local.acme.com.crt', errorLog: '/srv/nginx/log/local.acme.com-error.log', kind: 'subdirectory', uploadsProxy: 'www.acme.com', mounts: [],
    });
  });

  it('lists a site on nginx once, where its hosts line points, also halfway through a move', () => {
    const t = tree();
    onNginx(t, { keepApache: true });
    expect(readSiteVhosts(t.config).map((v) => [v.names[0], v.server])).toEqual([['local.shop.com', 'nginx']]);
    t.write('hosts', `${HOSTS_BEGIN}\n127.0.0.1 local.shop.com local.shop.de\n${HOSTS_END}\n`);
    expect(readSiteVhosts(t.config).map((v) => [v.names[0], v.server])).toEqual([['local.shop.com', 'apache']]);
  });

  it('reads the hosts block address and the names a line outside the block takes', () => {
    const text = `127.0.0.1 local.shop.de # by hand\n${HOSTS_BEGIN}\n127.0.0.2 local.shop.com local.shop.de\n${HOSTS_END}\n`;
    expect(hostsBlockAddress(text, 'local.shop.com')).toBe('127.0.0.2');
    expect(hostsBlockAddress(text, 'local.shop.de')).toBeUndefined();
    expect(hostsOutsideBlock(text, ['local.shop.com', 'local.shop.de'])).toEqual(['local.shop.de']);
  });

  it('names what nginx leaves out of an .htaccess, never WordPress own rules or comments', () => {
    expect(htaccessIgnored('# BEGIN WordPress\nRewriteEngine On\n# END WordPress\n')).toEqual([]);
    expect(htaccessIgnored('# a note\nRedirect 301 /old /new\nHeader set X-Acme 1\n# BEGIN W3TC Browser Cache\nExpiresActive On\n# END W3TC Browser Cache\n# BEGIN WordPress\n# END WordPress\n')).toEqual(['W3TC Browser Cache', '2 lines of your own']);
  });
});

describe('site.setServer', () => {
  it('moves a site to nginx: its nginx file, the hosts line, a check through nginx, then the Apache vhost goes', async () => {
    const t = tree();
    const { c, fake, lines } = ctx(t);
    const steps = planSetServer(c, { domain: 'local.shop.com', server: 'nginx', acceptIgnored: false });
    expect(steps.map((s) => s.id)).toEqual(['nginx', 'hosts', 'check', 'apache']);
    expect(steps[0]?.label).toContain('PHP-FPM 8.3');
    const undos = await runSteps(steps);
    expect(lines()).toEqual([
      'nginx-site-write local.shop.com --kind single local.shop.de',
      'hosts-add local.shop.com local.shop.de',
      'vhost-remove local.shop.com',
    ]);
    expect(undos).toEqual(['Take the site off nginx and point its hosts line at Apache', 'Write the Apache vhost again']);
    expect(fake.calls.find((x) => x.file === 'curl')?.args).toContain('local.shop.com:443:127.0.0.1');
  });

  it('checks the site through nginx once its hosts line points there', async () => {
    const t = tree();
    onNginx(t, { keepApache: true });
    const { c, fake } = ctx(t);
    await planSetServer(c, { domain: 'local.shop.com', server: 'nginx', acceptIgnored: false }).find((s) => s.id === 'check')?.run({} as Parameters<JobStep['run']>[0]);
    expect(fake.calls.find((x) => x.file === 'curl')?.args).toContain('local.shop.com:443:127.0.0.2');
  });

  it('writes WordPress network rules for a subdirectory network, and the nginx file again when it is there already', async () => {
    const t = tree();
    writeFileSync(join(t.docroot, 'wp-config.php'), "<?php\ndefine('DB_NAME', 'shop_com');\ndefine('MULTISITE', true);\ndefine('SUBDOMAIN_INSTALL', false);\n");
    onNginx(t);
    const { c, lines } = ctx(t);
    const steps = planSetServer(c, { domain: 'local.shop.com', server: 'nginx', acceptIgnored: false });
    expect(steps.map((s) => s.id)).toEqual(['nginx', 'check']);
    await runSteps(steps);
    expect(lines()).toEqual(['nginx-site-write local.shop.com --kind subdirectory local.shop.de']);
  });

  it('takes the sites under its paths along to nginx, each with its own PHP', async () => {
    const t = tree();
    mkdirSync(join(t.config.WEB_DIR, 'local.learn.shop.com'));
    t.write('sites-available/local.shop.com-ssl.conf', `${MARKER}\n<VirtualHost *:443>\n ServerName local.shop.com\n ServerAlias local.shop.de\n DocumentRoot ${t.docroot}\n Alias /learn ${join(t.config.WEB_DIR, 'local.learn.shop.com')}\n</VirtualHost>\n`);
    const { c, lines } = ctx(t);
    await runSteps(planSetServer(c, { domain: 'local.shop.com', server: 'nginx', acceptIgnored: false }));
    expect(lines()[0]).toBe('nginx-site-write local.shop.com --kind single --mount /learn=local.learn.shop.com local.shop.de');
  });

  it('reads the sites under paths of a site on nginx from its file', () => {
    const t = tree();
    mkdirSync(join(t.config.WEB_DIR, 'local.learn.shop.com'));
    onNginx(t);
    const file = join(t.config.NGINX_SITES_AVAILABLE, 'local.shop.com.conf');
    writeFileSync(file, nginxFile(t.root, 'local.shop.com', 'local.shop.com local.shop.de').replace('# kind: single', '# kind: single\n# mount: /learn=local.learn.shop.com\n# mount: /gone=local.gone.shop.com'));
    expect(readSiteVhosts(t.config)[0]?.mounts).toEqual([{ path: '/learn', docroot: join(t.config.WEB_DIR, 'local.learn.shop.com') }]);
  });

  it('moves a site back to Apache: the vhost, the nginx file goes, the hosts line follows', async () => {
    const t = tree();
    onNginx(t);
    const { c, lines } = ctx(t);
    const undos = await runSteps(planSetServer(c, { domain: 'local.shop.com', server: 'apache', acceptIgnored: false }));
    expect(lines()).toEqual(['vhost-write local.shop.com local.shop.de', 'nginx-site-remove local.shop.com', 'hosts-add local.shop.com local.shop.de']);
    expect(undos).toEqual(['Remove the Apache vhost', 'Write the nginx site again and point the hosts line at nginx']);
  });

  it('refuses before anything runs: nginx not set up, no PHP-FPM, a vhost made by hand, a hosts line outside the block, a site under a path from outside the web root', () => {
    const input = { domain: 'local.shop.com', server: 'nginx' as const, acceptIgnored: false };
    expect(() => planSetServer(ctx(tree({ nginxSetUp: false })).c, input)).toThrow(/not set up next to Apache/);
    expect(() => planSetServer(ctx(tree({ fpm: false })).c, input)).toThrow(/PHP-FPM only/);
    const hand = tree();
    hand.write('sites-available/local.shop.com-ssl.conf', `<VirtualHost *:443>\n ServerName local.shop.com\n DocumentRoot ${hand.docroot}\n</VirtualHost>\n`);
    expect(() => planSetServer(ctx(hand).c, input)).toThrow(/made by hand/);
    const outside = tree();
    outside.write('hosts', `127.0.0.1 local.shop.de\n${HOSTS_BEGIN}\n127.0.0.1 local.shop.com local.shop.de\n${HOSTS_END}\n`);
    expect(() => planSetServer(ctx(outside).c, input)).toThrow(/outside the panel's block/);
    const away = tree();
    mkdirSync(join(away.root, 'elsewhere'));
    away.write('sites-available/local.shop.com-ssl.conf', `${MARKER}\n<VirtualHost *:443>\n ServerName local.shop.com\n DocumentRoot ${away.docroot}\n Alias /learn ${join(away.root, 'elsewhere')}\n</VirtualHost>\n`);
    expect(() => planSetServer(ctx(away).c, input)).toThrow(/from outside/);
    expect(() => planSetServer(ctx(tree()).c, { ...input, server: 'apache' })).toThrow(/on Apache already/);
  });

  it('needs a tick when nginx would leave .htaccess rules out, and the site page shows why a move cannot run', () => {
    const t = tree();
    t.write('www/local.shop.com/.htaccess', '# BEGIN Acme Redirects\nRedirect 301 /old /new\n# END Acme Redirects\n');
    const { c } = ctx(t);
    expect(() => planSetServer(c, { domain: 'local.shop.com', server: 'nginx', acceptIgnored: false })).toThrow(/Acme Redirects/);
    expect(planSetServer(c, { domain: 'local.shop.com', server: 'nginx', acceptIgnored: true })).toHaveLength(4);
    const vhost = readSiteVhosts(t.config)[0];
    expect(vhost && moveRefusal(t.config, vhost, 'local.shop.com')).toBeNull();
    const off = tree({ nginxSetUp: false });
    const offVhost = readSiteVhosts(off.config)[0];
    expect(offVhost && moveRefusal(off.config, offVhost, 'local.shop.com')).toMatch(/not set up/);
  });

  it('is a job with validated input', async () => {
    const t = tree();
    const { c } = ctx(t);
    await expect(runAction(c, 'site.setServer', { domain: 'example.com', server: 'nginx' })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(c, 'site.setServer', { domain: 'local.shop.com', server: 'caddy' })).rejects.toBeInstanceOf(ActionInputError);
    const run = await runAction(c, 'site.setServer', { domain: 'local.shop.com', server: 'nginx' });
    expect(run.data?.jobId).toBeTruthy();
  });
});

describe('sites.setServerAll', () => {
  it('moves every site that can, one after the other, and lists the ones that stay', async () => {
    const t = tree();
    // A second site, made by hand: it stays on Apache.
    const hand = join(t.config.WEB_DIR, 'local.hand.com');
    mkdirSync(hand);
    t.write('sites-available/local.hand.com-ssl.conf', `<VirtualHost *:443>\n ServerName local.hand.com\n DocumentRoot ${hand}\n</VirtualHost>\n`);
    symlinkSync(join(t.config.APACHE_SITES_AVAILABLE, 'local.hand.com-ssl.conf'), join(t.config.APACHE_SITES_ENABLED, 'local.hand.com-ssl.conf'));
    const { c, lines } = ctx(t);
    const steps = planSetServerAll(c, { server: 'nginx', acceptIgnored: false });
    expect(steps.map((s) => s.id)).toEqual(['list', 'local.shop.com:nginx', 'local.shop.com:hosts', 'local.shop.com:check', 'local.shop.com:apache']);
    expect(steps[0]?.label).toBe('Move 1 site to nginx, leave 1 as it is');
    const out = await steps[0]?.run({} as Parameters<JobStep['run']>[0]);
    expect(Array.isArray(out) ? '' : out?.stdout).toContain('staying: local.hand.com: the vhost of local.hand.com was made by hand');
    await runSteps(steps.slice(1));
    expect(lines()[0]).toBe('nginx-site-write local.shop.com --kind single local.shop.de');
  });

  it('leaves sites with .htaccess rules nginx ignores unless ticked, and refuses when nothing can move', () => {
    const t = tree();
    t.write('www/local.shop.com/.htaccess', 'Header set X-Acme 1\n');
    expect(() => planSetServerAll(ctx(t).c, { server: 'nginx', acceptIgnored: false })).toThrow(/No site can move to nginx: local.shop.com: nginx would not read/);
    expect(planSetServerAll(ctx(t).c, { server: 'nginx', acceptIgnored: true })).toHaveLength(5);
    expect(() => planSetServerAll(ctx(t).c, { server: 'apache', acceptIgnored: false })).toThrow(/Every site runs on Apache already/);
  });
});

describe('a site on nginx elsewhere in the panel', () => {
  it('rewrites its nginx file, not an Apache vhost, when aliases are added, and reloads nginx', async () => {
    const t = tree();
    onNginx(t);
    const { c, lines } = ctx(t);
    await runAction(c, 'site.addAliases', { domain: 'local.shop.com', aliases: ['local.shop.fr'] });
    expect(lines()).toEqual([
      'nginx-site-write local.shop.com --kind single local.shop.de local.shop.fr',
      'cert-reissue-from-vhost local.shop.com',
      'hosts-add local.shop.com local.shop.de local.shop.fr',
      'nginx-reload',
    ]);
    await runAction(c, 'cert.reissue', { domain: 'local.shop.com' });
    expect(lines().slice(-2)).toEqual(['cert-reissue-from-vhost local.shop.com', 'nginx-reload']);
  });

  it('shows the site on nginx, a hosts line on the wrong server, ignored .htaccess rules and rules of another kind', async () => {
    const t = tree();
    onNginx(t, { kind: 'subdirectory' });
    t.write('www/local.shop.com/.htaccess', '# BEGIN W3TC Browser Cache\nExpiresActive On\n# END W3TC Browser Cache\n');
    t.write('hosts', `${HOSTS_BEGIN}\n127.0.0.1 local.shop.com local.shop.de\n${HOSTS_END}\n`);
    // Halfway through: the hosts line still says Apache, but only nginx has the site now.
    const [site] = await discoverSites({ config: t.config, exec: fakeExec().exec, secrets: null, wpcoreConf: t.wpcoreConf });
    expect(site?.server).toBe('nginx');
    const ids = site?.issues.map((i) => i.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(['hosts.server', 'nginx.htaccess', 'nginx.kind']));
    expect(ids).not.toContain('htaccess.missing');
    expect(site?.issues.find((i) => i.id === 'nginx.kind')?.fix).toEqual({ action: 'site.setServer', input: { domain: 'local.shop.com', server: 'nginx' }, label: 'Write its nginx rules again' });
    expect(site?.issues.find((i) => i.id === 'hosts.server')?.fix?.action).toBe('hosts.add');
  });

  it('keeps nginx on while a site runs there, naming it', () => {
    const t = tree();
    onNginx(t);
    expect(() => planNginxTeardown(ctx(t).c)).toThrow(/local.shop.com runs on nginx: move it to Apache/);
  });

  it('tells the site page what moving it to nginx means', async () => {
    const t = tree();
    t.write('www/local.shop.com/.htaccess', 'Header set X-Acme 1\n');
    const [site] = await discoverSites({ config: t.config, exec: fakeExec().exec, secrets: null, wpcoreConf: t.wpcoreConf });
    expect(site?.server).toBe('apache');
    expect(site?.move).toEqual({ ignored: ['1 line of your own'], php: '8.3' });
  });
});
