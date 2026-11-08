import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chosenRules, readHtaccessReport, regexOk, reportSums, ruleNginx, targetOk, translateHtaccess } from '../src/sites/htaccess-rules.js';
import { tempTree } from './helpers.js';

/** The status and dmp-root rule (or note) of each rule, in file order. */
const summary = (folder: string, text: string) => translateHtaccess(folder, text).map((r) => [r.status, r.rule ?? r.note]);

const SPELLBOOK = `# BEGIN Wandworks Firewall
<IfModule mod_php.c>
  php_value auto_prepend_file '/var/www/local.spellbook.example/wandworks-waf.php'
</IfModule>
# END Wandworks Firewall

# BEGIN W3TC Browser Cache
<IfModule mod_expires.c>
    ExpiresActive On
    ExpiresByType text/css A31536000
</IfModule>
# END W3TC Browser Cache

# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress

Options -Indexes
Redirect 301 /old-shop /shop
RedirectMatch 302 ^/promo/(.*)$ https://www.spellbook.example/sale/$1
RewriteEngine On
RewriteCond %{HTTPS} off
RewriteRule ^(.*)$ https://%{HTTP_HOST}/$1 [R=301,L]
RewriteCond %{HTTP_HOST} ^spellbook\\.example$ [NC]
RewriteRule ^(.*)$ https://www.spellbook.example/$1 [R=301,L]
RewriteRule ^Wands/(.*)$ /wands/$1 [R=301,L,NC]
RewriteRule ^feed$ index.php?feed=rss2 [L]
RewriteRule ^/never$ /x [R=301,L]
RewriteCond %{QUERY_STRING} ^p=([0-9]+)$
RewriteRule ^$ /?page_id=%1 [R=301,L]
Header always set X-Frame-Options "SAMEORIGIN"
Header set Content-Security-Policy "default-src 'self'; img-src *"
Header set X-Wandworks "1"
Header unset ETag
<Files wp-config.php>
  Require all denied
</Files>
<FilesMatch "\\.(log|ini)$">
  Order allow,deny
  Deny from all
</FilesMatch>
<If "%{REQUEST_URI} =~ m#^/secret#">
  Require all denied
</If>
ErrorDocument 404 /404.php
SetEnv WANDWORKS_ENV local
`;

describe('.htaccess rules for nginx', () => {
  it('sorts each rule of a site .htaccess: covered, translated, not needed, PHP settings and the rest', () => {
    expect(summary('/', SPELLBOOK)).toEqual([
      ['php', "auto_prepend_file = /var/www/local.spellbook.example/wandworks-waf.php: set it on the PHP tab, as nginx runs PHP through PHP-FPM"],
      ['local', 'Caching and compression: not needed on this computer'],
      ['covered', "WordPress's own rules: the nginx file has them"],
      ['covered', "nginx's default: no folder listings, links followed"],
      ['translated', 'redirect 301 ^/old-shop(/.*)?$ /shop$1'],
      ['translated', 'redirect 302 ^/promo/(.*)$ https://www.spellbook.example/sale/$1'],
      ['covered', 'nginx rewrites without it'],
      ['covered', 'nginx sends http to https already'],
      ['local', 'Names the production hosts; here the site answers to its own names'],
      ['translated', 'redirect 301 (?i)^/Wands/(.*)$ /wands/$1'],
      ['translated', 'rewrite ^/feed$ /index.php?feed=rss2?'],
      ['manual', 'Never matches: in an .htaccess the path has no leading slash'],
      ['manual', 'Depends on %{QUERY_STRING}, which the panel does not translate'],
      ['translated', 'header set X-Frame-Options SAMEORIGIN'],
      ['translated', "header set Content-Security-Policy default-src 'self'; img-src *"],
      ['manual', 'A header the panel does not set on nginx: X-Wandworks'],
      ['local', 'Caching and compression: not needed on this computer'],
      ['translated', 'deny ^/(?:.*/)?wp-config\\.php$'],
      ['translated', 'deny ^/(?:.*/)?[^/]*\\.(log|ini)$'],
      ['manual', 'A <If> block, which the panel does not translate'],
      ['translated', 'error-page 404 /404.php'],
      ['manual', 'Sets an environment variable'],
    ]);
  });

  it('keeps the source, line, section and nginx of each rule, and stable ids for the same text', () => {
    const rules = translateHtaccess('/', SPELLBOOK);
    const redirect = rules.find((r) => r.rule?.startsWith('redirect 301 ^/old-shop'));
    expect(redirect).toMatchObject({ file: '/', line: 26, source: 'Redirect 301 /old-shop /shop', nginx: 'rewrite ^/old-shop(/.*)?$ /shop$1 permanent;' });
    expect(rules[0]).toMatchObject({ section: 'Wandworks Firewall', line: 3 });
    expect(rules[2]?.source.split('\n')).toHaveLength(10);
    expect(translateHtaccess('/', SPELLBOOK).map((r) => r.id)).toEqual(rules.map((r) => r.id));
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
  });

  it('scopes rules of an .htaccess below the site to its folder', () => {
    expect(summary('/wp-content/uploads/wc-logs', 'Require all denied\n')).toEqual([['translated', 'deny ^/wp-content/uploads/wc-logs/']]);
    expect(summary('/shop', 'RewriteRule ^old/(.*)$ new/$1 [R=301,L]\n<Files secret.txt>\nDeny from all\n</Files>\n')).toEqual([
      ['translated', 'redirect 301 ^/shop/old/(.*)$ /shop/new/$1'],
      ['translated', 'deny ^/shop/(?:.*/)?secret\\.txt$'],
    ]);
    expect(summary('/', 'Require all denied\n')[0]?.[0]).toBe('manual');
  });

  it('never hands dmp-root a rule its checks would refuse', () => {
    const rules = translateHtaccess('/', [
      SPELLBOOK,
      'RewriteRule ^a{2}$ /b [R=301,L]',
      'Redirect 301 /x;y /z',
      'RewriteRule ^c$ /d$document_root [R=301,L]',
      'Header set X-Frame-Options "$x"',
      'RewriteRule ^e$ /f [R=307,L]',
    ].join('\n'));
    for (const r of rules.filter((x) => x.status === 'translated')) {
      const [kind, a = '', b = '', c = ''] = (r.rule as string).split(' ');
      if (kind === 'redirect') expect(regexOk(b) && targetOk(c)).toBe(true);
      if (kind === 'rewrite') expect(regexOk(a) && targetOk(b)).toBe(true);
      if (kind === 'deny') expect(regexOk(a)).toBe(true);
    }
    expect(rules.slice(-5).map((r) => r.status)).toEqual(['manual', 'manual', 'manual', 'manual', 'manual']);
    expect(ruleNginx('header unset X-Powered-By')).toBe('fastcgi_hide_header X-Powered-By;');
  });

  it('reads every .htaccess of a site with its checksum, and says when one changed since its rules were applied', () => {
    const t = tempTree();
    const docroot = join(t.config.WEB_DIR, 'local.spellbook.example');
    mkdirSync(join(docroot, 'wp-content/uploads/wc-logs'), { recursive: true });
    writeFileSync(join(docroot, '.htaccess'), 'Redirect 301 /old /new\nHeader set X-Wandworks 1\n');
    writeFileSync(join(docroot, 'wp-content/uploads/wc-logs/.htaccess'), 'Deny from all\n');
    const report = readHtaccessReport(docroot, undefined, 0, true);
    expect(report.files.map((f) => f.folder)).toEqual(['/', '/wp-content/uploads/wc-logs']);
    expect(report.nginx).toBe('rewrite ^/old(/.*)?$ /new$1 permanent;\nlocation ~ ^/wp-content/uploads/wc-logs/ { deny all; }');
    expect(report.changed).toBeUndefined();
    const sums = reportSums(report);
    const rules = chosenRules(report);
    expect(rules).toEqual(['redirect 301 ^/old(/.*)?$ /new$1', 'deny ^/wp-content/uploads/wc-logs/']);
    const skip = [report.rules.find((r) => r.rule?.startsWith('deny'))?.id as string];
    expect(chosenRules(report, skip)).toEqual(['redirect 301 ^/old(/.*)?$ /new$1']);
    expect(readHtaccessReport(docroot, { rules: [], sums: {} }, 0, true).changed).toBe(true);
    expect(readHtaccessReport(docroot, { rules, sums }, 0, true).changed).toBe(false);
    writeFileSync(join(docroot, '.htaccess'), 'Redirect 301 /old /newer\n');
    expect(readHtaccessReport(docroot, { rules, sums }, 0, true).changed).toBe(true);
  });
});
