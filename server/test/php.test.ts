import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_REPORTING_CHOICES, PHP_INI_SETTINGS } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { readFpmFindings, phpDirectivesOutsideModPhp } from '../src/php/fpm-check.js';
import { cliInfo, infoScript, PhpInfoUnavailable, webInfo } from '../src/php/info.js';
import { diffIni, parseIni, readIniReport } from '../src/php/ini.js';
import { planInstallVersion, planPhpPackage, planRemoveVersion, planUpgradeVersion, setCliVersion } from '../src/php/apt.js';
import { apachePhpVersion, installedVersions, packageVersions, phpReport, readAptSources, readPhpModules, readPhpPackages, readXdebug, updateLabel, upstreamVersion, webSapi, XDEBUG_INI } from '../src/php/versions.js';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobStep } from '../src/jobs.js';
import { normalizeIniValue, PhpSettingsRefused, planAdoptIni, planAdoption, readPhpSettings } from '../src/php/settings.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, tempTree } from './helpers.js';

type Tree = ReturnType<typeof tempTree>;

/** A version's folders: mods-available and the parts asked for, with modules on per part. */
function addVersion(t: Tree, version: string, parts: Record<string, string[]>, available: string[] = []) {
  const base = join(t.config.PHP_CONF_DIR, version);
  mkdirSync(join(base, 'mods-available'), { recursive: true });
  const names = new Set([...available, ...Object.values(parts).flat()]);
  for (const name of names) writeFileSync(join(base, 'mods-available', `${name}.ini`), name === 'xdebug' ? 'zend_extension=xdebug.so\nxdebug.mode = develop\n' : `extension=${name}.so\n`);
  for (const [sapi, on] of Object.entries(parts)) {
    mkdirSync(join(base, sapi, 'conf.d'), { recursive: true });
    mkdirSync(join(t.config.PHP_LIB_DIR, version, 'sapi'), { recursive: true });
    writeFileSync(join(t.config.PHP_LIB_DIR, version, 'sapi', sapi), '');
    for (const name of on) symlinkSync(join(base, 'mods-available', `${name}.ini`), join(base, sapi, 'conf.d', `20-${name}.ini`));
  }
  return base;
}

const modPhp = (t: Tree, version: string) => writeFileSync(join(t.root, 'mods-enabled', `php${version}.load`), '');

describe('versions', () => {
  it('lists versions with a config folder, newest first, with their parts', () => {
    const t = tempTree();
    addVersion(t, '8.1', { fpm: [], cli: [] });
    addVersion(t, '8.3', { apache2: [], cli: [] });
    mkdirSync(join(t.config.PHP_CONF_DIR, '7.4/mods-available'), { recursive: true }); // left behind by apt remove: no markers
    mkdirSync(join(t.config.PHP_CONF_DIR, '7.4/fpm'), { recursive: true });
    mkdirSync(join(t.config.PHP_CONF_DIR, 'tmp'), { recursive: true });
    expect(installedVersions(t.config)).toEqual([
      { version: '8.3', sapis: ['apache2', 'cli'] },
      { version: '8.1', sapis: ['fpm', 'cli'] },
    ]);
  });

  it('picks the web part sites see: mod_php for its version, FPM for the others', () => {
    const t = tempTree();
    addVersion(t, '8.3', { apache2: [], fpm: [], cli: [] });
    addVersion(t, '8.1', { fpm: [] });
    modPhp(t, '8.3');
    expect(apachePhpVersion(t.config)).toBe('8.3');
    expect(webSapi(t.config, '8.3')).toBe('apache2');
    expect(webSapi(t.config, '8.1')).toBe('fpm');
  });

  it('reads modules per part, less Xdebug, and Xdebug for the web part', () => {
    const t = tempTree();
    const base = addVersion(t, '8.1', { fpm: ['mysqli', 'xdebug'], cli: ['mysqli', 'soap'] }, ['soap', 'Bad-Name']);
    writeFileSync(join(base, 'fpm/conf.d', XDEBUG_INI), 'xdebug.mode=debug,profile\nxdebug.start_with_request=yes\n');
    expect(readPhpModules(t.config, '8.1')).toEqual([
      { name: 'mysqli', fpm: true, cli: true, required: true },
      { name: 'soap', fpm: false, cli: true, required: false },
    ]);
    expect(readXdebug(t.config, '8.1')).toEqual({ installed: true, enabled: true, modes: ['debug', 'profile'], startWithRequest: 'yes' });
    addVersion(t, '8.4', { cli: [] });
    expect(readXdebug(t.config, '8.4')).toMatchObject({ installed: false, reason: 'Xdebug is not installed for PHP 8.4: apt install php8.4-xdebug' });
  });

  it('marks a module missing when apt removed its library and left its ini on', () => {
    const t = tempTree();
    addVersion(t, '8.4', { fpm: ['mysqli', 'soap'], cli: ['mysqli'] }, ['xdebug']);
    const ext = join(t.root, 'php-ext');
    mkdirSync(ext);
    writeFileSync(join(ext, 'mysqli.so'), '');
    expect(readPhpModules(t.config, '8.4', ext)).toEqual([
      { name: 'mysqli', fpm: true, cli: true, required: true },
      { name: 'soap', fpm: true, cli: false, required: false, missing: true },
    ]);
    expect(readPhpModules(t.config, '8.4').some((m) => m.missing)).toBe(false);
  });

  it('leaves out the apache2 folder a removed mod_php left behind, with only its php.ini', () => {
    const t = tempTree();
    const base = addVersion(t, '8.4', { fpm: ['mysqli'], cli: ['mysqli'] });
    mkdirSync(join(base, 'apache2'));
    writeFileSync(join(base, 'apache2/php.ini'), 'memory_limit = 512M\n');
    expect(readPhpModules(t.config, '8.4')).toEqual([{ name: 'mysqli', fpm: true, cli: true, required: true }]);
    expect(webSapi(t.config, '8.4')).toBe('fpm');
    expect(readIniReport(t.config, '8.4').sapis.map((d) => d.sapi)).toEqual([]);
    expect(readPhpSettings(t.config, '8.4').scopes.map((x) => x.scope)).toEqual(['web', 'cli']);
  });

  it('reads installed and candidate builds from apt-cache policy', async () => {
    const { exec, calls } = fakeExec({
      'apt-cache policy': {
        stdout: [
          'php8.3-common:', '  Installed: 8.3.6-0ubuntu0.24.04.5', '  Candidate: 1:8.3.14-1+ubuntu24.04.1+deb.sury.org+1', '  Version table:',
          'php8.1-common:', '  Installed: (none)', '  Candidate: 8.1.31-1', '',
        ].join('\n'),
      },
    });
    const versions = await packageVersions(exec, ['8.3', '8.1']);
    expect(calls[0]?.args).toEqual(['policy', 'php8.3-common', 'php8.1-common']);
    expect(versions.get('8.3')).toEqual({ installed: '8.3.6-0ubuntu0.24.04.5', candidate: '1:8.3.14-1+ubuntu24.04.1+deb.sury.org+1' });
    expect(versions.get('8.1')).toEqual({ candidate: '8.1.31-1' });
    expect(upstreamVersion('1:8.3.14-1+ubuntu24.04.1+deb.sury.org+1')).toBe('8.3.14');
    expect(updateLabel('8.3.6-0ubuntu0.24.04.5', '1:8.3.14-1+ubuntu24.04.1')).toBe('8.3.14');
    expect(updateLabel('8.3.6-0ubuntu0.24.04.4', '8.3.6-0ubuntu0.24.04.5')).toBe('a new build of 8.3.6');
    expect(updateLabel('8.3.6-1', '8.3.6-1')).toBeUndefined();
    expect(updateLabel('8.3.14-1', '8.3.6-1')).toBeUndefined();
  });

  it('builds the report: patch, update, FPM state, the command line and the default', async () => {
    const t = tempTree();
    addVersion(t, '8.3', { apache2: ['mysqli'], cli: ['mysqli'] });
    addVersion(t, '8.1', { fpm: [], cli: [] });
    modPhp(t, '8.3');
    const { exec } = fakeExec({
      'apt-cache policy': { stdout: 'php8.3-common:\n  Installed: 8.3.6-1\n  Candidate: 8.3.14-1\nphp8.1-common:\n  Installed: 8.1.31-1\n  Candidate: 8.1.31-1\n' },
      php: { stdout: '8.3' },
      'systemctl is-active php8.1-fpm': { stdout: 'active\n' },
    });
    const report = await phpReport(t.config, exec, (v) => (v === '8.1' ? ['local.old.com'] : []), () => 0);
    expect(report.defaultVersion).toBe('8.3');
    expect(report.versions.map(({ modules, xdebug, ...v }) => v)).toEqual([
      { version: '8.3', patch: '8.3.6', update: '8.3.14', sapis: ['apache2', 'cli'], apache: true, cli: true, sites: [] },
      { version: '8.1', patch: '8.1.31', sapis: ['fpm', 'cli'], apache: false, cli: false, fpm: 'running', sites: ['local.old.com'] },
    ]);
  });
});

describe('php.ini changes', () => {
  it('parses settings, quotes and comments, and keeps repeated keys', () => {
    const ini = parseIni('[PHP]\n; memory_limit = 1G\nmemory_limit = 512M ; more\nerror_log = "/var/log/php errors.log"\nextension=a\nextension=b\n[Date]\ndate.timezone=\n');
    expect([...ini]).toEqual([['memory_limit', '512M'], ['error_log', '/var/log/php errors.log'], ['extension', 'a, b'], ['date.timezone', '']]);
    expect(diffIni(parseIni('a=1\nb=2\nc=3\n'), parseIni('a=1\nb=20\nd=4\n'))).toEqual([
      { key: 'b', original: '2', current: '20' },
      { key: 'd', current: '4' },
      { key: 'c', original: '3' },
    ]);
  });

  it('compares each part with its packaged php.ini (the command line with its own) and lists extra ini files', () => {
    const t = tempTree();
    const base = addVersion(t, '8.3', { apache2: ['mysqli'], cli: [] });
    const lib = join(t.config.PHP_LIB_DIR, '8.3');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'php.ini-production'), 'memory_limit = 128M\nmax_execution_time = 30\n');
    writeFileSync(join(lib, 'php.ini-production.cli'), 'memory_limit = -1\n');
    writeFileSync(join(base, 'apache2/php.ini'), 'memory_limit = 512M\nmax_execution_time = 30\n');
    writeFileSync(join(base, 'cli/php.ini'), 'memory_limit = -1\n');
    writeFileSync(join(base, 'apache2/conf.d/50-wandworks.ini'), 'upload_max_filesize=64M\n');
    writeFileSync(join(base, 'apache2/conf.d', XDEBUG_INI), 'xdebug.mode=debug\n');
    expect(readIniReport(t.config, '8.3')).toEqual({
      version: '8.3',
      sapis: [
        {
          sapi: 'apache2',
          file: join(base, 'apache2/php.ini'),
          original: join(lib, 'php.ini-production'),
          changes: [{ key: 'memory_limit', original: '128M', current: '512M' }],
          extraFiles: [{ name: '50-wandworks.ini', panel: false }, { name: XDEBUG_INI, panel: true }],
        },
        { sapi: 'cli', file: join(base, 'cli/php.ini'), original: join(lib, 'php.ini-production.cli'), changes: [], extraFiles: [] },
      ],
    });
  });
});

describe('PHP info', () => {
  const info = { version: '8.3.6', sapi: 'cli', iniFile: '/etc/php/8.3/cli/php.ini', scannedFiles: ['/etc/php/8.3/cli/conf.d/20-mysqli.ini'], ini: { memory_limit: { local: '-1', master: '-1' } }, groups: { Core: ['memory_limit'] }, extensions: { Core: '8.3.6' }, zendExtensions: [] };

  function withScript() {
    const t = tempTree();
    const dmpRoot = join(t.root, 'prefix/bin/dmp-root');
    mkdirSync(join(t.root, 'prefix/php'), { recursive: true });
    writeFileSync(infoScript(dmpRoot), '<?php');
    return { t, dmpRoot };
  }

  it('runs the installed script with the version\'s command line', async () => {
    const { dmpRoot } = withScript();
    const { exec, calls } = fakeExec({ 'php8.3': { stdout: JSON.stringify(info) } });
    expect(await cliInfo(exec, dmpRoot, '8.3')).toEqual(info);
    expect(calls[0]).toMatchObject({ file: 'php8.3', args: [infoScript(dmpRoot)] });
    await expect(cliInfo(fakeExec().exec, dmpRoot, '8.1')).rejects.toThrow('PHP 8.1 has no command line: apt install php8.1-cli');
    await expect(cliInfo(fakeExec({ 'php8.3': { stdout: 'Warning: x' } }).exec, dmpRoot, '8.3')).rejects.toThrow('a form the panel cannot read');
  });

  it('asks Apache through the panel\'s own vhost on this computer only', async () => {
    const { t, dmpRoot } = withScript();
    const { exec, calls } = fakeExec({ curl: { stdout: JSON.stringify({ ...info, sapi: 'apache2handler' }) } });
    expect((await webInfo(exec, t.config, dmpRoot)).sapi).toBe('apache2handler');
    expect(calls[0]?.args).toEqual([
      '-sS', '--fail-with-body', '--max-time', '20', '--noproxy', '*',
      '--resolve', 'local.devmagic:80:127.0.0.1', '-H', 'X-Devmagic-Panel: info', 'http://local.devmagic/.devmagic-panel-php/info.php',
    ]);
    await webInfo(exec, t.config, dmpRoot, 'php8.1/info.php');
    expect(calls[1]?.args.at(-1)).toBe('http://local.devmagic/.devmagic-panel-php/php8.1/info.php');
    await expect(webInfo(fakeExec({ curl: { code: 22, stderr: 'curl: (22) The requested URL returned error: 404' } }).exec, t.config, dmpRoot)).rejects.toThrow('run ./install.sh once');
  });

  it('asks for install.sh when the script is not installed yet', async () => {
    const t = tempTree();
    await expect(cliInfo(fakeExec().exec, join(t.root, 'none/bin/dmp-root'), '8.3')).rejects.toBeInstanceOf(PhpInfoUnavailable);
  });

  it('ships an info script that hides password-like settings and answers only the panel on the web', () => {
    const script = readFileSync(join(import.meta.dirname, '../../scripts/php/info.php'), 'utf8');
    expect(script).toContain("'HTTP_X_DEVMAGIC_PANEL'");
    expect(script).toContain('(hidden)');
    expect(script).toContain('http_response_code( 404 )');
  });
});

describe('before sites move to PHP-FPM', () => {
  it('counts php_value lines that apply without mod_php only', () => {
    expect(phpDirectivesOutsideModPhp('php_value memory_limit 1G\n<IfModule mod_php.c>\n  php_flag display_errors on\n</IfModule>\n<IfModule mod_rewrite.c>\nphp_admin_value x 1\n</IfModule>\n')).toBe(2);
  });

  it('finds php_value in sites and Apache, .user.ini, phpMyAdmin, and Apache and FPM differences', () => {
    const t = tempTree();
    mkdirSync(join(t.config.WEB_DIR, 'local.shop.com/wp-content/plugins/wandworks'), { recursive: true });
    mkdirSync(join(t.config.WEB_DIR, 'local.shop.com/node_modules/x'), { recursive: true });
    writeFileSync(join(t.config.WEB_DIR, 'local.shop.com/.htaccess'), 'php_value upload_max_filesize 64M\n');
    writeFileSync(join(t.config.WEB_DIR, 'local.shop.com/wp-content/plugins/wandworks/.htaccess'), '<IfModule mod_php7.c>\nphp_value a 1\n</IfModule>\n');
    writeFileSync(join(t.config.WEB_DIR, 'local.shop.com/.user.ini'), 'auto_prepend_file=x.php\n');
    writeFileSync(join(t.config.WEB_DIR, 'local.shop.com/node_modules/x/.user.ini'), '');
    mkdirSync(join(t.root, 'conf-enabled'), { recursive: true });
    writeFileSync(join(t.root, 'conf-enabled/phpmyadmin.conf'), '<IfModule mod_php.c>\nphp_admin_value open_basedir /x\n</IfModule>\n');
    writeFileSync(join(t.root, 'sites-enabled/local.wandworks.example-ssl.conf'), '<VirtualHost *:443>\nphp_admin_value memory_limit 1G\n</VirtualHost>\n');
    const base = addVersion(t, '8.3', { apache2: ['mysqli', 'soap'], fpm: ['mysqli'] });
    writeFileSync(join(base, 'apache2/php.ini'), 'memory_limit = 512M\n');
    writeFileSync(join(base, 'fpm/php.ini'), 'memory_limit = 128M\n');

    const findings = readFpmFindings(t.config);
    const by = (id: string) => findings.find((f) => f.id === id);
    expect(by('apache-php-value')).toMatchObject({ status: 'warn', files: [join(t.root, 'sites-enabled/local.wandworks.example-ssl.conf')] });
    expect(by('htaccess-php-value')).toMatchObject({ status: 'warn', files: ['local.shop.com/.htaccess'] });
    expect(by('user-ini')).toMatchObject({ status: 'warn', files: ['local.shop.com/.user.ini'] });
    expect(by('phpmyadmin')?.status).toBe('info');
    expect(by('ini-differs')).toMatchObject({ status: 'warn', text: expect.stringContaining('memory_limit') });
    expect(by('modules-differ')).toMatchObject({ status: 'warn', text: expect.stringContaining('soap (on for Apache only)') });
  });

  it('is all clear on a clean machine', () => {
    const findings = readFpmFindings(tempTree().config);
    expect(findings.map((f) => f.status)).toEqual(['ok', 'ok', 'ok']);
  });
});

describe('settings, modules and Xdebug per version', () => {
  function ctx(t: Tree, responses: Parameters<typeof fakeExec>[0] = {}) {
    const fake = fakeExec({ [`sudo -n ${DMP}`]: { stdout: 'ok' }, ...responses });
    const store = new RunStore(':memory:');
    const c: ActionContext = {
      config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: join(t.root, 'wpcore.conf'), home: t.hostPaths.home,
      jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
    };
    return { c, lines: () => fake.calls.map((x) => [x.file, ...x.args].join(' ')) };
  }

  it('switch modules and Xdebug for the version asked, else the one Apache runs', async () => {
    const t = tempTree();
    modPhp(t, '8.3');
    const { c, lines } = ctx(t);
    await runAction(c, 'php.setModule', { version: '8.1', module: 'soap', enabled: true });
    await runAction(c, 'php.setModule', { module: 'soap', enabled: false });
    await runAction(c, 'php.setXdebug', { version: '8.1', enabled: true, modes: ['develop', 'debug'], startWithRequest: 'trigger' });
    await runAction(c, 'php.setXdebug', { version: '8.1', enabled: false });
    expect(lines()).toEqual([
      `sudo -n ${DMP} php-module 8.1 soap on`,
      `sudo -n ${DMP} php-module 8.3 soap off`,
      `sudo -n ${DMP} xdebug-enable 8.1 debug,develop trigger`,
      `sudo -n ${DMP} xdebug-disable 8.1`,
    ]);
    await expect(runAction(c, 'php.setModule', { version: '8', module: 'soap', enabled: true })).rejects.toBeInstanceOf(ActionInputError);
  });

  it('writes the panel\'s settings in a fixed order, and refuses settings it does not manage or values they do not take', async () => {
    const { c, lines } = ctx(tempTree());
    await runAction(c, 'php.setIni', { version: '8.3', scope: 'web', values: { upload_max_filesize: '64M', memory_limit: '512M', error_reporting: 'E_ALL & ~E_NOTICE' } });
    await runAction(c, 'php.setIni', { version: '8.3', scope: 'cli', values: {} });
    expect(lines()).toEqual([
      `sudo -n ${DMP} php-ini 8.3 web memory_limit=512M upload_max_filesize=64M error_reporting=E_ALL & ~E_NOTICE`,
      `sudo -n ${DMP} php-ini 8.3 cli`,
    ]);
    for (const values of [{ auto_prepend_file: '/tmp/x.php' }, { memory_limit: '512M\nauto_prepend_file=x' }, { display_errors: '1' }, { max_execution_time: '-5' }, { 'date.timezone': 'x/../y' }]) {
      await expect(runAction(c, 'php.setIni', { version: '8.3', scope: 'web', values }), JSON.stringify(values)).rejects.toBeInstanceOf(ActionInputError);
    }
    expect(lines()).toHaveLength(2);
  });

  it('reads the panel\'s settings and what the files set otherwise, per scope', () => {
    const t = tempTree();
    const base = addVersion(t, '8.3', { apache2: [], cli: [] });
    writeFileSync(join(base, 'apache2/php.ini'), 'memory_limit = 512M\nmax_execution_time = 300\nauto_prepend_file =\n');
    writeFileSync(join(base, 'apache2/conf.d/50-wandworks.ini'), 'upload_max_filesize = 32M\n');
    writeFileSync(join(base, 'apache2/conf.d/99-devmagic-panel.ini'), '; Managed\nupload_max_filesize = 64M\n');
    writeFileSync(join(base, 'cli/php.ini'), 'memory_limit = -1\n');
    expect(readPhpSettings(t.config, '8.3')).toEqual({
      version: '8.3',
      scopes: [
        { scope: 'web', panel: { upload_max_filesize: '64M' }, files: { memory_limit: '512M', max_execution_time: '300', upload_max_filesize: '32M' } },
        { scope: 'cli', panel: {}, files: { memory_limit: '-1' } },
      ],
    });
  });

  function adoptTree(apacheIni: string, fpmIni?: string) {
    const t = tempTree();
    const base = addVersion(t, '8.3', fpmIni === undefined ? { apache2: [], cli: [] } : { apache2: [], fpm: [], cli: [] });
    const lib = join(t.config.PHP_LIB_DIR, '8.3');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'php.ini-production'), 'memory_limit = 128M\nmax_execution_time = 30\ndisplay_errors = Off\nupload_max_filesize = 2M\n');
    writeFileSync(join(lib, 'php.ini-production.cli'), 'memory_limit = -1\n');
    writeFileSync(join(base, 'apache2/php.ini'), apacheIni);
    if (fpmIni !== undefined) writeFileSync(join(base, 'fpm/php.ini'), fpmIni);
    writeFileSync(join(base, 'cli/php.ini'), 'memory_limit = -1\n');
    return { t, base };
  }

  it('plans moving php.ini changes: values in the panel\'s form, refusals for what it cannot write', () => {
    const { t } = adoptTree('memory_limit = 512m\nmax_execution_time = 300\ndisplay_errors = 1\nupload_max_filesize = 2M\n', 'memory_limit = 512M\nmax_execution_time = 30\ndisplay_errors = Off\nupload_max_filesize = 2M\n');
    expect(planAdoption(t.config, '8.3')).toEqual({ values: { web: { memory_limit: '512M', max_execution_time: '300', display_errors: 'On' }, cli: {} }, reset: ['apache2', 'fpm'] });
    expect(normalizeIniValue('display_errors', 'off')).toBe('Off');

    const conflict = adoptTree('memory_limit = 512M\nmax_execution_time = 30\ndisplay_errors = Off\nupload_max_filesize = 2M\n', 'memory_limit = 1G\nmax_execution_time = 30\ndisplay_errors = Off\nupload_max_filesize = 2M\n');
    expect(() => planAdoption(conflict.t.config, '8.3')).toThrow('memory_limit is 512M for Apache but 1G for FPM');
    const unmanaged = adoptTree('memory_limit = 128M\nmax_execution_time = 30\ndisplay_errors = Off\nupload_max_filesize = 2M\nauto_prepend_file = /x.php\n');
    expect(() => planAdoption(unmanaged.t.config, '8.3')).toThrow(PhpSettingsRefused);
    expect(() => planAdoption(unmanaged.t.config, '8.3')).toThrow('auto_prepend_file (apache2) is not a setting the panel manages');
    const dropped = adoptTree('memory_limit = 128M\nmax_execution_time = 30\ndisplay_errors = Off\n');
    expect(() => planAdoption(dropped.t.config, '8.3')).toThrow('upload_max_filesize (apache2) was taken out of php.ini');
    const same = adoptTree('memory_limit = 128M\nmax_execution_time = 30\ndisplay_errors = Off\nupload_max_filesize = 2M\n');
    expect(() => planAdoption(same.t.config, '8.3')).toThrow('nothing to move');
  });

  it('moves the changes as a job: settings first with the panel\'s own values winning, then php.ini, and Undo reverses both', async () => {
    const { t, base } = adoptTree('memory_limit = 512M\nmax_execution_time = 300\ndisplay_errors = Off\nupload_max_filesize = 2M\n');
    writeFileSync(join(base, 'apache2/conf.d/99-devmagic-panel.ini'), 'max_execution_time = 600\n');
    const { exec, calls } = fakeExec({ [`sudo -n ${DMP} php-ini-reset`]: { stdout: 'saved 8.3-apache2-20261030101010\nok: done\n' }, [`sudo -n ${DMP}`]: { stdout: 'ok' } });
    const undos: Array<() => Promise<unknown>> = [];
    const job = { onUndo: (_label: string, fn: () => Promise<unknown>) => undos.push(fn) } as unknown as Parameters<JobStep['run']>[0];
    const steps = planAdoptIni(t.config, exec, DMP, '8.3');
    expect(steps.map((s) => s.id)).toEqual(['settings-web', 'reset-apache2']);
    for (const step of steps) await step.run(job);
    for (const undo of undos.reverse()) await undo();
    expect(calls.map((c) => c.args.slice(2).join(' '))).toEqual([
      'php-ini 8.3 web memory_limit=512M max_execution_time=600',
      'php-ini-reset 8.3 apache2',
      'php-ini-put-back 8.3 apache2 8.3-apache2-20261030101010',
      'php-ini 8.3 web max_execution_time=600',
    ]);
  });

  it('refuses the action when there is nothing to move, before any command', async () => {
    const same = adoptTree('memory_limit = 128M\nmax_execution_time = 30\ndisplay_errors = Off\nupload_max_filesize = 2M\n');
    const { c, lines } = ctx(same.t);
    await expect(runAction(c, 'php.adoptIni', { version: '8.3' })).rejects.toThrow('nothing to move');
    expect(lines()).toEqual([]);
  });
});

describe('the settings list', () => {
  it('is the same in dmp-root as in the panel', () => {
    const sh = readFileSync(join(import.meta.dirname, '../../scripts/lib/php.sh'), 'utf8');
    const block = /DMP_PHP_INI_SETTINGS=\(([^)]*)\)/.exec(sh)?.[1] ?? '';
    const shell = Object.fromEntries(block.trim().split(/\s+/).map((e) => e.split(':') as [string, string]));
    const ours = Object.fromEntries(Object.entries(PHP_INI_SETTINGS).map(([k, s]) => [k, s.kind === 'size' && 'unlimited' in s ? 'size-' : s.kind]));
    expect(shell).toEqual(ours);
    const choices = [...(/DMP_PHP_ERROR_REPORTING=\(([^)]*)\)/.exec(sh)?.[1] ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect(choices).toEqual([...ERROR_REPORTING_CHOICES]);
  });
});

describe('installing, updating and removing versions', () => {
  it('reads whether apt has a PHP source, and the system family', () => {
    const t = tempTree();
    const dir = join(t.root, 'sources.list.d');
    mkdirSync(dir);
    writeFileSync(join(t.root, 'os-release'), 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n');
    expect(readAptSources({ sourcesDir: dir, osRelease: join(t.root, 'os-release') })).toEqual({ php: false, distro: 'ubuntu' });
    writeFileSync(join(dir, 'ondrej-ubuntu-php-noble.sources'), 'Types: deb\nURIs: https://ppa.launchpadcontent.net/ondrej/php/ubuntu/\n');
    writeFileSync(join(t.root, 'os-release'), 'ID=debian\n');
    expect(readAptSources({ sourcesDir: dir, osRelease: join(t.root, 'os-release') })).toEqual({ php: true, distro: 'debian' });
  });

  it('lists a version\'s module packages apt has, without FPM, the command line or tools', async () => {
    const { exec } = fakeExec({
      'apt-cache pkgnames php8.3-': { stdout: 'php8.3-redis\nphp8.3-fpm\nphp8.3-soap\nphp8.3-dev\nphp8.3-mysql\nphp8.31-x\n' },
      'dpkg-query': { stdout: 'php8.3-mysql:amd64 ii \nphp8.3-soap rc \n' },
    });
    expect(await readPhpPackages(exec, '8.3')).toEqual([
      { name: 'mysql', installed: true },
      { name: 'redis', installed: false },
      { name: 'soap', installed: false },
    ]);
  });

  it('offers the versions apt has that are not installed', async () => {
    const t = tempTree();
    addVersion(t, '8.3', { apache2: [], cli: [] });
    const { exec } = fakeExec({
      'apt-cache policy php8.3-common': { stdout: 'php8.3-common:\n  Installed: 8.3.6-1\n  Candidate: 8.3.6-1\n' },
      'apt-cache policy php7.4-common': { stdout: 'php7.4-common:\n  Installed: (none)\n  Candidate: (none)\nphp8.4-common:\n  Installed: (none)\n  Candidate: 8.4.1-1\n' },
      php: { stdout: '8.3' },
    });
    const report = await phpReport(t.config, exec, () => [], () => 0, { sourcesDir: join(t.root, 'none'), osRelease: join(t.root, 'none') });
    expect(report.available).toEqual(['8.4']);
    expect(report.sources).toEqual({ php: false, distro: 'other' });
  });

  function aptCtx(t: Tree, cli = '8.3') {
    const fake = fakeExec({ [`sudo -n ${DMP}`]: { stdout: 'ok' }, php: { stdout: cli } });
    return { c: { config: t.config, exec: fake.exec, dmpRoot: DMP }, fake };
  }
  const runtime = () => {
    const undo: Array<() => Promise<unknown>> = [];
    return { job: { onUndo: (_l: string, fn: () => Promise<unknown>) => undo.push(fn), progress: () => undefined } as unknown as Parameters<JobStep['run']>[0], undo };
  };

  it('installs a version and Undo removes it; installing one twice is refused', async () => {
    const t = tempTree();
    addVersion(t, '8.3', { apache2: [] });
    const { c, fake } = aptCtx(t);
    const { job, undo } = runtime();
    await planInstallVersion(c, '8.4')[0]?.run(job);
    await undo[0]?.();
    expect(fake.calls.map((x) => x.args.slice(2).join(' '))).toEqual(['php-install 8.4', 'php-remove 8.4']);
    expect(() => planInstallVersion(c, '8.3')).toThrow('installed already');
  });

  it('installs or removes a package with the opposite as Undo, and updates without Undo', async () => {
    const t = tempTree();
    addVersion(t, '8.3', { apache2: [] });
    const { c, fake } = aptCtx(t);
    const { job, undo } = runtime();
    await planPhpPackage(c, '8.3', 'redis', 'install')[0]?.run(job);
    await undo[0]?.();
    await planUpgradeVersion(c, '8.3')[0]?.run(job);
    expect(undo).toHaveLength(1);
    expect(fake.calls.map((x) => x.args.slice(2).join(' '))).toEqual(['php-package 8.3 redis install', 'php-package 8.3 redis remove', 'php-upgrade 8.3']);
  });

  it('refuses to remove the version Apache, the command line or a site runs', async () => {
    const t = tempTree();
    addVersion(t, '8.3', { apache2: [], cli: [] });
    addVersion(t, '8.1', { fpm: [], cli: [] });
    addVersion(t, '8.2', { fpm: [] });
    modPhp(t, '8.3');
    await expect(planRemoveVersion(aptCtx(t).c, '8.3')).rejects.toThrow('Apache runs PHP 8.3 as mod_php');
    await expect(planRemoveVersion(aptCtx(t, '8.1').c, '8.1')).rejects.toThrow('php on the command line is PHP 8.1');
    mkdirSync(join(t.config.PHP_CONF_DIR, '8.2/fpm/pool.d'), { recursive: true });
    mkdirSync(join(t.config.WEB_DIR, 'local.shop.com'), { recursive: true });
    writeFileSync(join(t.config.PHP_CONF_DIR, '8.2/fpm/pool.d/dmp-local.shop.com.conf'), '; Managed by devmagic-panel. Edits here are overwritten.\n');
    await expect(planRemoveVersion(aptCtx(t).c, '8.2')).rejects.toThrow('these sites run on it: local.shop.com');
    const { c, fake } = aptCtx(t);
    const { job, undo } = runtime();
    await (await planRemoveVersion(c, '8.1'))[0]?.run(job);
    await undo[0]?.();
    expect(fake.calls.filter((x) => x.file === 'sudo').map((x) => x.args.slice(2).join(' '))).toEqual(['php-remove 8.1', 'php-install 8.1']);
  });

  it('points php on the command line at a version with a command line only', async () => {
    const t = tempTree();
    addVersion(t, '8.3', { apache2: [], cli: [] });
    addVersion(t, '8.4', { fpm: [] });
    const { c, fake } = aptCtx(t);
    await setCliVersion(c, '8.3');
    expect(fake.calls.map((x) => x.args.slice(2).join(' '))).toEqual(['php-cli 8.3']);
    await expect(setCliVersion(c, '8.4')).rejects.toThrow('has no command line');
    await expect(setCliVersion(c, '8.2')).rejects.toThrow('not installed');
  });
});
