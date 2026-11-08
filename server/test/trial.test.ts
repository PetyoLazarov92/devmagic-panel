import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markLogs, newLogLines, phpMessages, trialRun } from '../src/php/trial.js';
import { siteFor } from '../src/sites/site-actions.js';
import { type FakeCall, fakeExec, wpSiteTree } from './helpers.js';

type Tree = ReturnType<typeof wpSiteTree>;

const stamp = '[Sat Oct 31 19:40:01.123456 2026]';
/** A PHP-FPM message as Apache logs it, several PHP messages in one line. */
const fpm = (docroot: string, ...messages: string[]) =>
  `${stamp} [proxy_fcgi:error] [pid 42:tid 43] [client 127.0.0.1:5000] AH01071: Got error 'PHP message: ${messages.map((m) => `${m} in ${docroot}/wp-content/plugins/wandworks-forms/x.php on line 9`).join('\\nPHP message: ')}'\n`;

function logs(t: Tree) {
  mkdirSync(t.config.APACHE_LOG_DIR, { recursive: true });
  const apache = join(t.config.APACHE_LOG_DIR, 'error.log');
  writeFileSync(apache, fpm(t.docroot, 'PHP Fatal error:  Uncaught Error: an old one'));
  return apache;
}

describe('trial run after a PHP switch', () => {
  it('reads only what the site\'s logs got since the mark, this site\'s lines of a shared log, by what PHP calls them', () => {
    const t = wpSiteTree();
    const apache = logs(t);
    const site = siteFor(t.config, 'local.shop.com');
    const marks = markLogs(t.config, site);
    appendFileSync(apache, fpm(t.docroot, 'PHP Deprecated:  Creation of dynamic property', 'PHP Warning:  Undefined array key "x"'));
    appendFileSync(apache, fpm('/var/www/local.other.com', 'PHP Fatal error:  Uncaught Error: not this site'));
    appendFileSync(apache, `${stamp} [ssl:warn] [pid 1] AH01909: local.shop.com:443:0 server certificate does not include an ID which matches the server name\n`);
    expect(phpMessages(newLogLines(marks)).map((m) => m.level)).toEqual(['deprecated', 'warning']);
  });

  it('leaves out what WP-CLI\'s own code logs to debug.log', () => {
    const lines = [{ time: '', level: 'deprecated' as const, message: 'PHP Deprecated:  Mustache_Parser::buildTree(): Implicitly marking parameter $parent as nullable is deprecated in phar:///usr/local/bin/wp/vendor/mustache/mustache/src/Mustache/Parser.php on line 73' }];
    expect(phpMessages(lines)).toEqual([]);
  });

  it('makes the one-time login with WP-CLI on the version of the site\'s new pool', async () => {
    const t = wpSiteTree();
    logs(t);
    const site = siteFor(t.config, 'local.shop.com');
    const answer = (call: FakeCall) => ({ stdout: call.args.includes('list') ? 'admin' : call.args.includes('get') ? '1' : 'ok' });
    const fake = fakeExec({ curl: { stdout: '200' }, wp: answer, 'php8.4': answer });
    await trialRun({ config: t.config, exec: fake.exec }, site, '8.4', markLogs(t.config, site), '8.4');
    const cli = fake.calls.filter((c) => c.file === 'php8.4' || c.file === 'wp');
    expect(cli.length).toBeGreaterThan(0);
    // A phar on the PATH runs as php8.4 wp ...; another launcher gets WP_CLI_PHP.
    for (const c of cli) expect(c.file === 'php8.4' || c.env?.WP_CLI_PHP === 'php8.4').toBe(true);
  });

  it('reads a rotated log from its start', () => {
    const t = wpSiteTree();
    const apache = logs(t);
    const marks = markLogs(t.config, siteFor(t.config, 'local.shop.com'));
    writeFileSync(apache, fpm(t.docroot, 'PHP Notice:  after the rotation'));
    expect(phpMessages(newLogLines(marks))).toEqual([{ level: 'notice', message: expect.stringContaining('after the rotation') }]);
  });

  it('opens the home page, wp-login.php and wp-admin signed in, and passes with deprecations listed', async () => {
    const t = wpSiteTree();
    const apache = logs(t);
    const site = siteFor(t.config, 'local.shop.com');
    const marks = markLogs(t.config, site);
    const fake = fakeExec({
      curl: () => {
        appendFileSync(apache, fpm(t.docroot, 'PHP Deprecated:  Creation of dynamic property'));
        return { stdout: '200' };
      },
      wp: (call: FakeCall) => ({ stdout: call.args.includes('user') && call.args.includes('list') ? 'admin' : call.args.includes('get') ? '1' : 'ok' }),
    });
    const r = await trialRun({ config: t.config, exec: fake.exec }, site, '8.4', marks);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toContain('Opened home page 200, wp-login.php 200, wp-admin 200. New in the logs: 3 deprecations.');
    expect(r.stdout).toContain('Creation of dynamic property');
    const admin = fake.calls.filter((c) => c.file === 'curl').at(-1) as FakeCall;
    expect(admin.args).toEqual(expect.arrayContaining(['-L', '-c', '-b', '--resolve', 'local.shop.com:443:127.0.0.1']));
    expect(admin.args.at(-1)).toMatch(/^https:\/\/local\.shop\.com\/\?dmp_login=[\w-]+$/);
  });

  it('fails on a new fatal error or a page answering 500, says the site stays so you can look, and skips wp-admin without a login', async () => {
    const t = wpSiteTree();
    const apache = logs(t);
    const site = siteFor(t.config, 'local.shop.com');
    const marks = markLogs(t.config, site);
    const fake = fakeExec({
      curl: (call) => {
        if (call.args.at(-1)?.endsWith('/')) appendFileSync(apache, fpm(t.docroot, 'PHP Fatal error:  Uncaught Error: Call to undefined function each()'));
        return { stdout: call.args.at(-1)?.endsWith('/') ? '500' : '200' };
      },
      wp: { code: 1, stderr: 'Error establishing a database connection' },
    });
    const r = await trialRun({ config: t.config, exec: fake.exec }, site, '8.4', marks);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('wp-admin skipped');
    expect(r.stderr).toContain('home page answered 500');
    expect(r.stderr).toContain('Call to undefined function each()');
    expect(r.stderr).not.toContain('an old one');
    expect(r.stderr).toContain('The site stays on PHP 8.4 so you can look; Undo puts it back.');
  });
});
