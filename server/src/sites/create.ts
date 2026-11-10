import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ActionInput, RepoPlacement } from '@devmagic-panel/shared';
import { addressSummary, placementWarnings, repoTarget, throughCoreLink, databaseNameFor, hostMapper, isLocalName, MEDIA_PLUGIN, MEDIA_PLUGIN_URL, mountFolder, networkMoves } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { CoreStatusMap } from '../core-status.js';
import type { ExecResult, Executor } from '../exec.js';
import { runRoot } from '../exec.js';
import type { JobRuntime, JobStep } from '../jobs.js';
import { withRaisedLimits } from '../mysql-limits.js';
import type { Secrets } from '../secrets.js';
import type { RunStore } from '../store.js';
import { installedCores, keepRepoIndex, readWpcoreConfig } from '../wpcore.js';
import { archiveSteps, currentSite } from './archive.js';
import { CHECK_SKIPPED, formatBytes, importSql, limitsTarget, rewriteAddresses, wpFor } from './db.js';
import { checkAddresses } from './replace.js';
import { freeSpace, importRoom } from './space.js';

export { importRoom };
import { sqlFileFor, type DumpFacts } from './dump.js';
import { ensureHtaccess } from './htaccess.js';
import { setLocalMode } from './local-mode.js';
import { currentUpload, readUpload } from './uploads.js';
import { findVhost } from './discover.js';
import { siteHost, siteWriteArgs } from './site-actions.js';
import { nginxSetUp } from '../nginx.js';
import { frontArgs, nginxPhpVersion } from './server-switch.js';
import { clearModules, engineHint, nodeEnv, nodeFor, secondNode, type NodeChoice, type NodeOptions } from './node.js';
import { readSiteVhosts } from './vhost.js';
import { mysqlPassword } from './mysql-password.js';
import { setConstant, setTablePrefix } from './wpconfig-edit.js';
import { readLocalConstants } from '../local-constants.js';
import { excludeLocally } from './mu-plugins.js';
import { installPlugins, installThemes, removeInstalled } from './install-plugins.js';
import { signedInWith } from './more-dumps.js';
import { copyFromServer, removeCopied } from './server-files.js';
import { copyUploads } from './server-uploads.js';
import { cleanStep, newCleanState, pluginsOffStep, userStep } from './clean.js';
import { NO_PROMPTS } from './git.js';

export interface CreateContext {
  config: SystemConfig;
  exec: Executor;
  secrets: Secrets | null;
  dmpRoot: string;
  wpcoreBin: string;
  wpcoreConf: string;
  uploadsDir: string;
  /** WordPress.org's word on each release, to keep an insecure core from being added on the way. */
  coreStatus?: () => Promise<CoreStatusMap | null>;
  /** Where how sites were installed is kept; a reinstall moves the old record to the archive. */
  store?: RunStore;
  /** Your home folder, where nvm keeps the Node versions builds run with. */
  home?: string;
  /** Whether code from a repo may run here (repo-trust.ts); without it every repo may. */
  repoTrusted?: (url: string) => boolean;
}

export type CreateInput = ActionInput<'site.create'>;

export class CreateRefused extends Error {}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const SQL_NAME = /^[A-Za-z0-9_]{1,64}$/;
const secret = () => randomBytes(18).toString('base64url');

/** Everything a new site may not collide with, checked before any step runs. */
export async function precheck(ctx: CreateContext, input: CreateInput): Promise<{ facts?: DumpFacts; dumpFile?: string }> {
  const vhosts = readSiteVhosts(ctx.config);
  const taken = new Set(vhosts.flatMap((v) => v.names));
  if (input.server !== 'apache' && !input.path && !nginxSetUp(ctx.config)) {
    throw new CreateRefused('nginx is not set up next to Apache: set it up on Services, nginx, or install the site on Apache');
  }
  if (input.server === 'nginx' && !input.path) {
    if (!nginxPhpVersion(ctx.config, input.domain)) throw new CreateRefused('nginx runs PHP through PHP-FPM only, and the default PHP version has none: install PHP-FPM for it on Services, PHP');
  }
  if (input.path) {
    // Under a path: the domain is an existing site's, the path free, and the folder new.
    const parent = vhosts.find((v) => v.names[0] === input.domain);
    if (!parent) throw new CreateRefused(`no site called ${input.domain} to put ${input.path} under`);
    if (parent.mounts.some((m) => m.path === input.path)) throw new CreateRefused(`${input.domain}${input.path} is already served`);
    const folder = mountFolder(input.domain, input.path) as string;
    if (taken.has(folder)) throw new CreateRefused(`${folder} is already used by another site`);
    if (existsSync(join(ctx.config.WEB_DIR, folder))) throw new CreateRefused(`${join(ctx.config.WEB_DIR, folder)} already exists`);
  } else {
    // A reinstall frees the names and the folder of the site it replaces; any other site's stay taken.
    const replaced = input.replaceExisting ? vhosts.find((v) => v.names[0] === input.domain) : undefined;
    const free = new Set(replaced?.names ?? []);
    for (const name of [input.domain, ...input.aliases]) {
      if (taken.has(name) && !free.has(name)) throw new CreateRefused(`${name} is already used by another site`);
    }
    if (input.replaceExisting) {
      const current = currentSite(ctx, input.domain);
      if (current?.refusal) throw new CreateRefused(`${input.domain} cannot go to the archive first: ${current.refusal}`);
    } else if (existsSync(join(ctx.config.WEB_DIR, input.domain))) {
      throw new CreateRefused(`${join(ctx.config.WEB_DIR, input.domain)} already exists`);
    }
  }
  if (input.source !== 'empty' && !ctx.secrets?.mysql) throw new CreateRefused('Set up the MySQL admin account first (Aura, Machine checks)');
  if (input.core?.mode === 'wpcore') {
    // A core the shared folder lacks is added first, as on the WordPress page; one with known security issues is added there, after confirming.
    const conf = readWpcoreConfig(ctx.wpcoreConf);
    if (!conf) throw new CreateRefused('wpcore has no config yet; run the installer first');
    const version = input.core.version ?? '';
    if (!installedCores(conf.coresDir).includes(version)) {
      const status = (await ctx.coreStatus?.())?.[version];
      if (status === 'insecure') throw new CreateRefused(`WordPress ${version} has known security issues; add it on the WordPress page first, where you confirm it`);
    }
  }
  // A repo's PHP runs when the site loads and its builds run as you: only repos you trust, or your organizations' and groups'.
  const untrusted = ctx.repoTrusted ? input.repos.find((r) => !ctx.repoTrusted?.(r.url)) : undefined;
  if (untrusted) throw new CreateRefused(`${untrusted.url} is not from your organizations or groups, and its owner is not trusted on this computer: trust it in the wizard or in Settings first`);
  // A shared core links wp-admin and wp-includes into the site: a repo there would go through the link into the core every site uses.
  const inCore = input.repos.find((r) => throughCoreLink(repoTarget(r)));
  if (inCore && input.core?.mode === 'wpcore') {
    throw new CreateRefused(`${repoTarget(inCore)} is a folder of WordPress core, which a shared core links into the site: pick WordPress from the repo or a download of its own on the WordPress step, or another folder`);
  }
  if (input.uploadId) {
    const upload = await currentUpload(ctx.exec, ctx.uploadsDir, input.uploadId);
    if (!upload) throw new CreateRefused('The uploaded dump is gone; upload it again');
    return { facts: upload.facts, dumpFile: upload.file };
  }
  return {};
}

/** The folder a repo of the site is cloned into: its place in the site's folder. */
export function cloneDir(docroot: string, repo: RepoPlacement): string {
  const target = repoTarget(repo);
  return target ? join(docroot, ...target.split('/')) : docroot;
}

/**
 * Why a repo cannot be cloned into its folder now, or null: every part of
 * the path that is there already must be a real folder (never a link, so a
 * clone never lands in a shared core's wp-admin or outside the site), the
 * folder stays inside the site's folder, and it is missing or empty.
 */
export function cloneTargetProblem(docroot: string, target: string): string | null {
  const rel = relative(docroot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return `${target} is outside the site's folder`;
  let at = docroot;
  for (const part of rel ? rel.split(sep) : []) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      // The rest of the path is made by the clone.
      break;
    }
    if (st.isSymbolicLink()) return `${at} is a link to ${readlinkSync(at)}, so the repo would land there: pick another folder`;
    if (!st.isDirectory()) return `${at} is a file: pick another folder`;
  }
  if (existsSync(target) && readdirSync(target).length > 0) return `${target} already holds files: pick another folder name`;
  return null;
}

/** The repos of an install in the order they are cloned: the site root first, then by depth, so an outer repo is there before one inside it. */
export function cloneOrder(repos: readonly CreateInput['repos'][number][]): Array<{ repo: CreateInput['repos'][number]; index: number }> {
  const depth = (r: RepoPlacement) => (repoTarget(r) ? repoTarget(r).split('/').length : 0);
  return repos.map((repo, index) => ({ repo, index })).sort((a, b) => depth(a.repo) - depth(b.repo) || a.index - b.index);
}

/**
 * Links a clone holds that point out of the site's folder, from git's own
 * list (mode 120000), so the install can say so: PHP served from the site
 * could read what they point at.
 */
export async function linksOutOfSite(exec: Executor, clone: string, docroot: string): Promise<string[]> {
  const listed = await exec('git', ['-C', clone, 'ls-files', '-s', '-z'], { timeoutMs: 60_000, maxBufferBytes: 256 * 1024 * 1024 });
  if (listed.code !== 0) return [];
  const out: string[] = [];
  for (const entry of listed.stdout.split('\0')) {
    const m = /^120000 [0-9a-f]+ \d+\t(.+)$/s.exec(entry);
    if (!m) continue;
    const link = join(clone, m[1] as string);
    try {
      const to = resolve(dirname(link), readlinkSync(link));
      const rel = relative(docroot, to);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) out.push(`${relative(docroot, link)} -> ${readlinkSync(link)}`);
    } catch {
      // not checked out as a link
    }
    if (out.length >= 20) break;
  }
  return out;
}

/** git's "Receiving objects:  45% (450/1000)" and "Resolving deltas" lines as one bar for the whole clone. */
export function cloneProgress(text: string): { fraction: number; note: string } | undefined {
  const lines = text.split(/[\r\n]+/).reverse();
  for (const line of lines) {
    const m = /(Receiving objects|Resolving deltas):\s+(\d+)%/.exec(line);
    if (!m) continue;
    const pct = Number(m[2]) / 100;
    return m[1] === 'Receiving objects' ? { fraction: pct * 0.85, note: `receiving objects, ${m[2]}%` } : { fraction: 0.85 + pct * 0.15, note: `resolving deltas, ${m[2]}%` };
  }
  return undefined;
}

/** Room a clone gets before it starts; repos with history and vendored plugins easily reach a few hundred MB. */
const CLONE_ROOM = 2 * 1024 ** 3;
/** Room each further repo gets: themes and plugins are smaller. */
const EXTRA_CLONE_ROOM = 512 * 1024 ** 2;

export interface SpaceNeed {
  path: string;
  bytes: number;
  what: string;
}

/** Fails before anything is made when a disk lacks the room; needs on the same disk add up. */
export function checkFreeSpace(needs: SpaceNeed[], free: (path: string) => { dev: number; bytes: number } = freeSpace): ExecResult {
  const byDisk = new Map<number, { bytes: number; free: number; what: string[] }>();
  for (const need of needs) {
    const disk = free(need.path);
    const entry = byDisk.get(disk.dev) ?? { bytes: 0, free: disk.bytes, what: [] };
    entry.bytes += need.bytes;
    entry.what.push(need.what);
    byDisk.set(disk.dev, entry);
  }
  const short = [...byDisk.values()].find((d) => d.free < d.bytes);
  if (short) {
    return { code: 1, stdout: '', stderr: `Not enough free disk space for ${short.what.join(' and ')}: about ${formatBytes(short.bytes)} needed, ${formatBytes(short.free)} free` };
  }
  return { code: 0, stdout: [...byDisk.values()].map((d) => `${formatBytes(d.free)} free for ${d.what.join(' and ')} (about ${formatBytes(d.bytes)} needed)`).join('\n'), stderr: '' };
}

export async function planCreate(ctx: CreateContext, input: CreateInput): Promise<JobStep[]> {
  const { facts, dumpFile } = await precheck(ctx, input);
  const { config, exec } = ctx;
  const domain = input.domain;
  // A site under a path lives in a folder of its own and answers at the domain and path.
  const path = input.path;
  const folder = path ? (mountFolder(domain, path) as string) : domain;
  const host = siteHost(domain, path);
  const docroot = join(config.WEB_DIR, folder);
  const root = (...args: string[]) => runRoot(exec, ctx.dmpRoot, args);
  const isWp = input.source !== 'empty';
  const mysql = ctx.secrets?.mysql;
  const sql = (statements: string) =>
    exec('mysql', ['--user', mysql?.user ?? '', '--host', mysql?.host ?? 'localhost'], { env: { MYSQL_PWD: mysql?.password ?? '' }, input: statements });

  // Database names come from the domain and stay clear of existing ones.
  let dbName = '';
  let dbUser = '';
  const dbPassword = mysqlPassword();
  if (isWp && mysql) {
    const existing = await exec('mysql', ['--batch', '--skip-column-names', '--user', mysql.user, '--host', mysql.host, '-e', 'SHOW DATABASES'], {
      env: { MYSQL_PWD: mysql.password },
    });
    if (existing.code !== 0) throw new CreateRefused(`cannot reach MySQL: ${existing.stderr.trim()}`);
    // A user left behind without its database would refuse CREATE USER, so its name counts as taken. An account that cannot read the list leaves only the databases.
    const users = await exec('mysql', ['--batch', '--skip-column-names', '--user', mysql.user, '--host', mysql.host, '-e', 'SELECT DISTINCT User FROM mysql.user'], {
      env: { MYSQL_PWD: mysql.password },
    });
    // A reinstall drops the database of the site it replaces first, so its name is free again, and its user when the panel made it.
    const replaced = input.replaceExisting ? currentSite(ctx, domain) : null;
    const replacedDb = replaced?.dbName;
    const replacedUser = replacedDb && replaced?.dbUser === replacedDb.slice(0, 32) && replaced.dbUser !== mysql.user ? replaced.dbUser : undefined;
    dbName = databaseNameFor(
      folder,
      existing.stdout.split('\n').filter((n) => n && n !== replacedDb),
      undefined,
      users.code === 0 ? users.stdout.split('\n').filter((n) => n && n !== replacedUser) : [],
    );
    dbUser = dbName.slice(0, 32);
    if (!SQL_NAME.test(dbName)) throw new CreateRefused(`cannot use ${dbName} as a database name`);
  }

  const wp = (args: string[], options: { input?: string; timeoutMs?: number; cwd?: string } = {}) =>
    exec('wp', [`--path=${docroot}`, `--url=https://${host}/`, ...args], { timeoutMs: options.timeoutMs ?? 300_000, ...(options.input !== undefined ? { input: options.input } : {}) });
  const multisite = facts?.multisite ?? false;
  // The network type chosen here, in WordPress's terms; else the dump's own setting.
  const subdomain = input.network ? input.network.layout === 'subdomain' : (facts?.subdomainInstall ?? false);
  const prefix = facts?.tablePrefix ?? 'wp_';
  // The sites of the network whose address here differs from where the replace leaves them.
  const moves = input.network && facts?.sites ? networkMoves(facts.sites, input.network.sites, hostMapper(input.replace)) : [];

  // A reinstall: the current site goes to the archive first, and Undo puts it back after the new one is taken away.
  const steps: JobStep[] = input.replaceExisting ? archiveSteps({ ...ctx, ...(ctx.store ? { store: ctx.store } : {}) }, domain, 'reinstall') : [];
  // A skippable step says what skipping it leaves undone; the others the site needs, or keep it safe.
  const add = (id: string, label: string, run: (job: JobRuntime) => Promise<ExecResult | ExecResult[]>, weight?: number, skippable?: string) =>
    steps.push({ id, label, run, ...(weight ? { weight } : {}), ...(skippable ? { skippable } : {}) });

  if (input.repos.length > 0 || dumpFile) {
    add('space', 'Check free disk space', async () => {
      const needs: SpaceNeed[] = [];
      if (input.repos.length > 0) needs.push({ path: ctx.config.WEB_DIR, bytes: CLONE_ROOM + (input.repos.length - 1) * EXTRA_CLONE_ROOM, what: input.repos.length === 1 ? 'the clone' : `${input.repos.length} clones` });
      if (dumpFile && mysql) {
        const datadir = await exec('mysql', ['--batch', '--skip-column-names', '--user', mysql.user, '--host', mysql.host, '-e', 'SELECT @@datadir'], { env: { MYSQL_PWD: mysql.password } });
        const dir = datadir.code === 0 ? datadir.stdout.trim() : '';
        needs.push({ path: dir && existsSync(dir) ? dir : ctx.config.WEB_DIR, bytes: importRoom(dumpFile), what: 'the database import' });
      }
      return checkFreeSpace(needs);
    }, 0.2);
  }

  add('folder', `Create ${docroot}`, async (job) => {
    const r = await root('site-dir-create', folder);
    if (r.code === 0) job.onUndo(`Remove ${docroot}`, () => root('site-dir-remove', folder));
    return r;
  });

  for (const { repo, index } of cloneOrder(input.repos)) {
    const target = cloneDir(docroot, repo);
    const atRoot = target === docroot;
    const where = repoTarget(repo) || 'the site root';
    add(index === 0 ? 'clone' : `clone-${index + 1}`, `Clone ${repo.url} (${repo.branch}) into ${where}`, async (job) => {
      if (!atRoot) {
        const problem = cloneTargetProblem(docroot, target);
        if (problem) return { code: 1, stdout: '', stderr: problem };
      }
      // A site-root repo goes into a scratch folder first, then moves up, so the files land in the very folder dmp-root registered.
      const into = atRoot ? join(docroot, '.dmp-clone') : target;
      if (!atRoot) mkdirSync(dirname(into), { recursive: true });
      // core.fileMode false: a chmod on the site's files never shows as a change in git. Only SSH and HTTPS, never a local or ext:: transport.
      const cloned = await exec('git', ['clone', '--progress', '--no-recurse-submodules', '-c', 'core.fileMode=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '--branch', repo.branch, '--single-branch', '--', repo.url, into], {
        timeoutMs: 30 * 60_000,
        env: NO_PROMPTS,
        onStderr: (chunk) => {
          const at = cloneProgress(chunk);
          if (at) job.progress(at.fraction, at.note);
        },
      });
      // git's progress lines would bury the real output.
      const r = { ...cloned, stderr: cloned.stderr.split(/[\r\n]+/).filter((l) => l && !/\d+%/.test(l)).join('\n') };
      if (r.code !== 0) return r;
      if (atRoot) {
        for (const entry of readdirSync(into)) renameSync(join(into, entry), join(docroot, entry));
        rmdirSync(into);
      } else {
        // A repo inside another one's folder stays out of that one's git status, locally.
        await excludeLocally(exec, target, `devmagic-panel: ${repo.url} is a repo of its own here`);
      }
      const notes = [...placementWarnings(repoTarget(repo)).map((w) => `note: ${w}`)];
      const away = await linksOutOfSite(exec, target, docroot);
      if (away.length) notes.push(`note: the repo has links out of the site's folder, which PHP served from it can follow:\n  ${away.join('\n  ')}`);
      return notes.length ? [r, ok(notes.join('\n'))] : r;
    }, 4);
  }

  if (isWp) {
    add('content', 'Prepare wp-content', async () => {
      for (const dir of ['themes', 'plugins', 'mu-plugins', 'uploads']) mkdirSync(join(docroot, 'wp-content', dir), { recursive: true });
      // The folder's setgid keeps the web server's group; group write lets WordPress install and update plugins too.
      const writable = await exec('chmod', ['-R', 'g+w', '--', join(docroot, 'wp-content')], { timeoutMs: 5 * 60_000 });
      return writable.code === 0 ? ok('wp-content is ready and writable by WordPress') : writable;
    });

    const core = input.core as NonNullable<CreateInput['core']>;
    const version = core.version ?? '';
    const conf = readWpcoreConfig(ctx.wpcoreConf);
    if (core.mode === 'wpcore' && conf && !installedCores(conf.coresDir).includes(version)) {
      add('addcore', `Add WordPress ${version} to the shared cores`, () =>
        exec('sudo', ['-n', ctx.wpcoreBin, 'add', version], { input: 'n\n', timeoutMs: 10 * 60_000 }),
      );
    }
    add(
      'core',
      core.mode === 'wpcore' ? `Link WordPress ${version} with wpcore` : core.mode === 'repo' ? "Use the repo's own WordPress" : `Download WordPress ${version}`,
      async () => {
        if (core.mode === 'repo') return repoCore(docroot);
        if (core.mode !== 'wpcore') return exec('wp', ['core', 'download', `--version=${version}`, `--path=${docroot}`, '--skip-content'], { timeoutMs: 600_000 });
        const linked = await exec('sudo', ['-n', ctx.wpcoreBin, 'link', folder, version], { timeoutMs: 120_000 });
        if (linked.code !== 0) return linked;
        const kept = await keepRepoIndex(exec, docroot);
        return { ...linked, stdout: [linked.stdout.trim(), kept.stdout].filter(Boolean).join('\n') };
      },
    );
  }

  if (path) {
    // The parent's certificate and hosts line cover the domain already; its vhost gets an Alias for the path.
    add('mount', `Serve it at https://${host}/`, async (job) => {
      const parent = findVhost(config, domain);
      if (!parent) return { code: 1, stdout: '', stderr: `no vhost for ${domain}` };
      if (!parent.managed) {
        // A vhost made by hand stays as it is: you add the lines.
        return ok(
          `${parent.file} was made by hand, so the panel leaves it as it is. Add these lines inside its <VirtualHost *:443> block, then reload Apache on the Services page (or take ${domain} over first, with Take over... on its Overview, and the panel adds them):\n` +
            `    Alias ${path} ${docroot}\n    <Directory ${docroot}>\n        Options FollowSymLinks\n        AllowOverride All\n        Require all granted\n    </Directory>`,
        );
      }
      // The parent's server config, Apache's vhost or its nginx file, with this path added.
      const write = (mounts: Array<{ path: string; docroot: string }>) => root(...siteWriteArgs(config, parent, domain, parent.uploadsProxy, parent.names.slice(1).filter(isLocalName), mounts));
      const r = await write([...parent.mounts, { path, docroot }]);
      if (r.code === 0) job.onUndo(`Stop serving ${path} on ${domain}`, () => write(parent.mounts));
      return r;
    });
  } else {
    const names = [domain, ...input.aliases];
    add('cert', `Issue a certificate for ${names.length} name${names.length > 1 ? 's' : ''}`, async (job) => {
      const r = await root('cert-issue', ...names);
      if (r.code === 0) job.onUndo('Remove the certificate', () => root('cert-remove', domain));
      return r;
    });
    const proxy = input.uploadsFrom && input.uploadsVia === 'redirect' ? ['--uploads-proxy', input.uploadsFrom] : [];
    if (input.server === 'nginx') {
      // WordPress's rules for what the site is: a network when the dump has one, of the type chosen here.
      const kind = multisite || input.network ? (subdomain ? 'subdomain' : 'subdirectory') : 'single';
      add('vhost', 'Write the nginx site and reload', async (job) => {
        const r = await root('nginx-site-write', domain, '--kind', kind, ...proxy, ...input.aliases);
        if (r.code === 0) job.onUndo('Remove the nginx site', () => root('nginx-site-remove', domain));
        return r;
      });
    } else {
      add('vhost', 'Write the Apache vhost and reload', async (job) => {
        const r = await root('vhost-write', domain, ...proxy, ...input.aliases);
        if (r.code === 0) job.onUndo('Remove the vhost', () => root('vhost-remove', domain));
        return r;
      });
      if (input.server === 'nginx-apache') {
        // nginx answers in front of the vhost; folders with an .htaccess of their own show up on Aura later.
        add('front', 'Put nginx in front of the Apache vhost and reload', async (job) => {
          const r = await root(...frontArgs(domain, true, [], input.aliases));
          if (r.code === 0) job.onUndo('Take nginx out', () => root('nginx-site-remove', domain));
          return r;
        });
      }
    }
    add('hosts', 'Add the /etc/hosts entry', async (job) => {
      const r = await root('hosts-add', ...names);
      if (r.code === 0) job.onUndo('Remove the hosts entry', () => root('hosts-remove', domain));
      return r;
    });
  }

  if (isWp && mysql) {
    add('db', `Create database ${dbName} and its user`, async (job) => {
      const host = mysql.host === '127.0.0.1' ? '127.0.0.1' : 'localhost';
      // One statement at a time, the user first: a refusal leaves nothing behind, and only what this step made is ever dropped.
      const made: string[] = [];
      const statements: Array<[statement: string, drop: string]> = [
        [`CREATE USER '${dbUser}'@'${host}' IDENTIFIED BY '${dbPassword}';`, `DROP USER IF EXISTS '${dbUser}'@'${host}';`],
        [`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`, `DROP DATABASE IF EXISTS \`${dbName}\`;`],
        [`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'${host}';`, ''],
      ];
      for (const [statement, drop] of statements) {
        const r = await sql(statement);
        if (r.code !== 0) {
          // The database before the user, the reverse of how they were made.
          if (made.length) await sql(made.reverse().join('\n'));
          return r;
        }
        if (drop) made.push(drop);
      }
      job.onUndo(`Drop database ${dbName} and its user`, () => sql(`DROP DATABASE IF EXISTS \`${dbName}\`;\nDROP USER IF EXISTS '${dbUser}'@'${host}';`));
      return ok(`database ${dbName} and user ${dbUser} created`);
    });

    add('config', 'Write wp-config.php', async () => {
      const file = join(docroot, 'wp-config.php');
      const sample = join(docroot, 'wp-config-local-sample.php');
      const results: ExecResult[] = [];
      if (!existsSync(file)) {
        if (existsSync(sample)) {
          writeFileSync(file, readFileSync(sample, 'utf8'));
          results.push(ok('started from wp-config-local-sample.php'));
        } else {
          // The password comes from stdin (--prompt), never the command line.
          const r = await wp(['config', 'create', `--dbname=${dbName}`, `--dbuser=${dbUser}`, `--dbhost=${mysql.host}`, `--dbprefix=${prefix}`, '--skip-check', '--prompt=dbpass'], {
            input: `${dbPassword}\n`,
          });
          results.push(r);
          if (r.code !== 0) return results;
        }
      }
      let text = readFileSync(file, 'utf8');
      for (const [name, value] of [
        ['DB_NAME', dbName],
        ['DB_USER', dbUser],
        ['DB_PASSWORD', dbPassword],
        ['DB_HOST', mysql.host],
        ['WP_ENVIRONMENT_TYPE', 'local'],
        ['WP_DEBUG', true],
        ['WP_DEBUG_LOG', true],
      ] as const) {
        text = setConstant(text, name, value);
      }
      text = setTablePrefix(text, prefix);
      // The constants every local site should have, from Settings: over the repo's own value.
      const locals = readLocalConstants(ctx.store);
      for (const c of locals) text = setConstant(text, c.name, c.value);
      if (locals.length > 0) results.push(ok(`set the local constants from Settings: ${locals.map((c) => `${c.name} = ${typeof c.value === 'string' ? `'${c.value}'` : c.value}`).join(', ')}`));
      // A network dump needs the network settings; a wp-config.php from the repo usually has them already.
      if (multisite && !/define\s*\(\s*['"]MULTISITE['"]/.test(text)) {
        for (const [name, value] of [
          ['WP_ALLOW_MULTISITE', true],
          ['MULTISITE', true],
          ['SUBDOMAIN_INSTALL', subdomain],
          ['DOMAIN_CURRENT_SITE', domain],
          ['PATH_CURRENT_SITE', facts?.networkPath ?? '/'],
          ['SITE_ID_CURRENT_SITE', 1],
          ['BLOG_ID_CURRENT_SITE', 1],
        ] as const) {
          text = setConstant(text, name, value);
        }
        results.push(ok(`added the ${subdomain ? 'subdomain' : 'subdirectory'} network settings`));
      }
      if (multisite && /define\s*\(\s*['"]DOMAIN_CURRENT_SITE['"]/.test(text)) text = setConstant(text, 'DOMAIN_CURRENT_SITE', domain);
      if (input.network && /define\s*\(\s*['"]SUBDOMAIN_INSTALL['"]/.test(text)) text = setConstant(text, 'SUBDOMAIN_INSTALL', subdomain);
      // One cookie domain keeps a login on that domain only: the network's other domains would not stay signed in.
      const cookie = /define\s*\(\s*['"]COOKIE_DOMAIN['"]\s*,\s*['"]([^'"]+)['"]/.exec(text)?.[1];
      if (input.network?.layout === 'subdomain' && cookie) results.push(ok(`note: wp-config.php sets COOKIE_DOMAIN to ${cookie}, so logins on the network's other domains will not stay signed in`));
      writeFileSync(file, text);
      chmodSync(file, 0o640);
      results.push(ok(`wp-config.php set for ${dbName}`));
      results.push(await wp(['config', 'shuffle-salts']));
      return results;
    });
  }

  if (dumpFile) {
    add('import', 'Import the database dump', async (job) => {
      const upload = readUpload(ctx.uploadsDir, input.uploadId as string);
      const sqlFile = await sqlFileFor(exec, dumpFile, upload?.dir ?? join(dumpFile, '..'));
      return importSql(exec, docroot, host, sqlFile, { job, mysql, memo: ctx.store });
    }, 8);

    // Every address in one pass each, sites that move and http to https included; none when the dump already answers here.
    const addresses = { hosts: input.replace, moves, locals: [domain, ...input.aliases], httpHosts: facts?.httpHosts };
    const summary = addressSummary(addresses, input.network?.layout);
    if (summary) {
      add(
        'replace',
        summary,
        (job) =>
          withRaisedLimits(limitsTarget(exec, mysql, ctx.store), (line) => job.activity?.(line), () =>
            rewriteAddresses(wpFor(exec, docroot, host), addresses, { tables: '--all-tables', tableHosts: facts?.tableHosts, multisite, prefix, domainMapping: Boolean(facts?.domainMapping), job }),
          ),
        5,
      );
      const left = input.replace.filter((r) => r.from !== r.to).map((r) => r.from);
      if (left.length > 0) {
        add('check', 'Check no site is left on a production address', () => checkAddresses(wpFor(exec, docroot, host), { prefix, multisite, from: left }), 0.2, CHECK_SKIPPED);
      }
    }
  }

  // A copy from production, cleaned as a cleaned import cleans one: on the new database itself, with SQL.
  const cleaning = Boolean(dumpFile && input.clean);
  if (dumpFile && input.clean) {
    const target = limitsTarget(exec, mysql, ctx.store);
    if (!target) throw new CreateRefused('Cleaning the copy needs the MySQL admin account on this machine (Aura, Machine checks)');
    const state = newCleanState();
    const wpc = wpFor(exec, docroot, host);
    const wpIn = (args: string[], stdin: string) => exec('wp', [`--path=${docroot}`, `--url=https://${host}/`, ...args, '--skip-plugins', '--skip-themes'], { input: stdin, timeoutMs: 10 * 60_000 });
    steps.push(
      cleanStep(target, dbName, prefix, `admin@${domain}`, input.clean.user, state),
      { ...pluginsOffStep(wpc, multisite), id: 'clean-plugins' },
      userStep(wpc, wpIn, { user: input.clean.user, adminEmail: `admin@${domain}`, multisite, prefix, state }),
    );
  }

  // A fresh WordPress, or a project without a dump: its code on new, empty tables.
  const freshInstall = input.source === 'wordpress' || (input.source === 'repo' && !dumpFile);
  if (freshInstall) {
    const admin = input.admin as NonNullable<CreateInput['admin']>;
    add('install', 'Install WordPress', async () => {
      // Your password, or a random one nobody needs (one-click login signs in from the panel). Always on stdin.
      const r = await wp(['core', 'install', `--url=https://${host}/`, `--title=${host}`, `--admin_user=${admin.user}`, `--admin_email=${admin.email}`, '--skip-email', '--prompt=admin_password'], {
        input: `${admin.password ?? secret()}\n`,
      });
      if (r.code !== 0) return r;
      const themes = await wp(['theme', 'list', '--field=name']);
      if (themes.stdout.trim()) return [r, ok('theme found')];
      return [r, await wp(['theme', 'install', 'twentytwentyfive', '--activate'])];
    });
  }

  if (dumpFile && input.deactivate.length > 0) {
    add('plugins', `Deactivate ${input.deactivate.length} production-only plugin${input.deactivate.length > 1 ? 's' : ''}`, async () => {
      const results: ExecResult[] = [];
      const flags = ['--skip-plugins', '--skip-themes'];
      for (const status of multisite ? ['active-network', 'active'] : ['active']) {
        const list = await wp(['plugin', 'list', `--status=${status}`, '--field=name', ...flags]);
        results.push({ ...list, stdout: '' });
        if (list.code !== 0) return results;
        const active = new Set(list.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
        const targets = input.deactivate.filter((p) => active.has(p));
        if (targets.length === 0) continue;
        results.push(await wp(['plugin', 'deactivate', ...targets, ...(status === 'active-network' ? ['--network'] : []), ...flags]));
      }
      if (results.every((r) => !r.stdout)) results.push(ok('none of them were active'));
      return results;
    });
  }

  // Plugins the dump has that no repo brought: from WordPress.org, each on its own, a failure noted and the rest installed.
  if (isWp && input.installPlugins.length > 0) {
    const n = input.installPlugins.length;
    add('install-plugins', `Install ${n} missing plugin${n === 1 ? '' : 's'} from WordPress.org`, async (job) => {
      const out = await installPlugins(exec, docroot, host, input.installPlugins);
      if (out.installed.length) job.onUndo(`Remove the ${out.installed.length} plugin${out.installed.length === 1 ? '' : 's'} installed from WordPress.org`, async () => removeInstalled(out.installed));
      return out.results;
    }, 2, `The plugins were not installed from WordPress.org: install them on the site's Plugins tab, under Missing plugins.`);
  }

  if (isWp && input.installThemes.length > 0) {
    const n = input.installThemes.length;
    add('install-themes', `Install ${n} missing theme${n === 1 ? '' : 's'} from WordPress.org`, async (job) => {
      const out = await installThemes(exec, docroot, host, input.installThemes);
      if (out.installed.length) job.onUndo(`Remove the ${out.installed.length} theme${out.installed.length === 1 ? '' : 's'} installed from WordPress.org`, async () => removeInstalled(out.installed));
      return out.results;
    }, 1, `The themes were not installed from WordPress.org: install them on the site's Plugins tab, under Missing plugins and themes.`);
  }

  // The ones neither a repo nor WordPress.org has: from the site's own server, read only, when you ticked them.
  const fromServer = input.copyFromServer;
  if (isWp && fromServer && fromServer.plugins.length + fromServer.themes.length > 0) {
    const n = fromServer.plugins.length + fromServer.themes.length;
    const signedIn = signedInWith(ctx, fromServer.host, fromServer.password);
    add('copy-from-server', `Copy ${n} missing plugin${n === 1 ? '' : 's'} and themes from ${fromServer.host}`, (job) => signedIn(async (signed) => {
      const out = await copyFromServer(signed, docroot, { host: fromServer.host, folder: fromServer.folder, wpCli: fromServer.wpCli }, fromServer, ctx.uploadsDir);
      if (out.made.length) job.onUndo(`Remove the ${out.made.length} copied from ${fromServer.host}`, async () => removeCopied(out.made));
      return out.results;
    }), 3, `Nothing was copied from ${fromServer.host}: copy them on the site's Plugins tab, under Missing plugins.`);
  }

  // The uploads themselves, only when you asked: missing ones load from production as it is.
  const uploads = input.copyUploads;
  if (isWp && uploads) {
    const signedIn = signedInWith(ctx, uploads.host, uploads.password);
    add('copy-uploads', `Copy ${uploads.months ? `the last ${uploads.months} month${uploads.months === 1 ? '' : 's'} of uploads` : 'the uploads'} from ${uploads.host}`,
      () => signedIn((signed) => copyUploads(signed, docroot, { host: uploads.host, folder: uploads.folder, wpCli: uploads.wpCli }, uploads.months)),
      6, `The uploads were not copied from ${uploads.host}: missing images still load from production.`);
  }

  // Cleaning keeps one user itself, the admin; the admin step is for a copy kept as it is.
  if (!cleaning && input.source === 'repo' && dumpFile && input.admin && !(input.admin.ifExists === 'keep' && input.admin.ifMissing === 'skip')) {
    const admin = input.admin;
    const label = admin.ifExists === 'keep' ? `Add ${admin.user} unless the database has it` : `Make sure ${admin.user} is an administrator${admin.password ? ' with your password' : ''}`;
    add('admin', label, async () => {
      const found = await wp(['user', 'get', admin.user, '--field=ID', '--skip-plugins', '--skip-themes']);
      const results: ExecResult[] = [];
      if (found.code !== 0) {
        if (admin.ifMissing === 'skip') return ok(`${admin.user} is not in the database; no user added`);
        results.push(await wp(['user', 'create', admin.user, admin.email, '--role=administrator', '--prompt=user_pass', '--skip-plugins', '--skip-themes'], { input: `${admin.password ?? secret()}\n` }));
      } else {
        if (admin.ifExists === 'keep') return ok(`${admin.user} is in the database already; left as it is`);
        results.push(await wp(['user', 'set-role', admin.user, 'administrator', '--skip-plugins', '--skip-themes']));
        if (admin.password && results.every((r) => r.code === 0)) {
          results.push(await wp(['user', 'update', admin.user, '--prompt=user_pass', '--skip-plugins', '--skip-themes'], { input: `${admin.password}\n` }));
        }
      }
      if (multisite && results.every((r) => r.code === 0)) results.push(await wp(['super-admin', 'add', admin.user, '--skip-plugins', '--skip-themes']));
      return results;
    }, undefined, `${admin.user} was not added or made an administrator: sign in with an account the database has.`);
  }

  if (isWp && input.activate.length > 0) {
    add('helpers', `Turn on ${input.activate.join(', ')}`, async () => {
      const results: ExecResult[] = [];
      const flags = ['--skip-plugins', '--skip-themes'];
      for (const slug of input.activate) {
        // Only what the repo brings: a helper the site lacks is skipped, never downloaded.
        const installed = await wp(['plugin', 'is-installed', slug, ...flags]);
        if (installed.code !== 0) {
          results.push(ok(`${slug} is not in this site, skipped`));
          continue;
        }
        results.push(await wp(['plugin', 'activate', slug, ...(multisite ? ['--network'] : []), ...flags]));
        if (results.at(-1)?.code !== 0) break;
      }
      return results;
    }, undefined, `${input.activate.join(', ')} may be off: turn them on in wp-admin, under Plugins.`);
  }

  // BE Media from Production, which the repo brings: its constant in wp-config.php (one already there wins), then turned on.
  if (isWp && input.uploadsVia === 'plugin' && input.uploadsFrom) {
    const url = `https://${input.uploadsFrom}`;
    add('media', `Load missing uploads from ${input.uploadsFrom} with BE Media from Production`, async () => {
      const flags = ['--skip-plugins', '--skip-themes'];
      const installed = await wp(['plugin', 'is-installed', MEDIA_PLUGIN, ...flags]);
      if (installed.code !== 0) return { code: 1, stdout: '', stderr: `${MEDIA_PLUGIN} is not in this site; the panel never downloads it` };
      const configFile = join(docroot, 'wp-config.php');
      const text = readFileSync(configFile, 'utf8');
      const results: ExecResult[] = [];
      if (new RegExp(`^\\s*define\\s*\\(\\s*['"]${MEDIA_PLUGIN_URL}['"]`, 'm').test(text)) {
        results.push(ok(`wp-config.php sets ${MEDIA_PLUGIN_URL} already; left as it is`));
      } else {
        writeFileSync(configFile, setConstant(text, MEDIA_PLUGIN_URL, url));
        results.push(ok(`set ${MEDIA_PLUGIN_URL} to ${url} in wp-config.php`));
      }
      results.push(await wp(['plugin', 'activate', MEDIA_PLUGIN, ...(multisite ? ['--network'] : []), ...flags]));
      return results;
    }, undefined, `Missing uploads do not load from ${input.uploadsFrom}: set ${MEDIA_PLUGIN_URL} to ${url} in wp-config.php and turn on BE Media from Production in wp-admin.`);
  }

  const builds = input.repos.length > 0 ? buildsFor(input) : [];
  if (builds.length > 0) {
    const dirOf = (b: BuildStep) => cloneDir(docroot, input.repos[b.repo] ?? (input.repos[0] as RepoPlacement));
    add('build', builds.length === 1 ? 'Run the build' : `Run ${builds.length} builds`, async () => {
      const results: ExecResult[] = [];
      for (const build of builds) {
        const ran = await runBuild(exec, dirOf(build), build, ctx.home ? { home: ctx.home } : {});
        results.push(...ran);
        if (ran.some((r) => r.code !== 0)) return results;
      }
      return results;
    }, undefined, `The build did not run, so built theme or plugin files may be missing. Run it in a terminal: ${builds.map((b) => buildCommand(dirOf(b), b)).join('; ')}`);
  }

  if (isWp) {
    add('htaccess', 'Write .htaccess when the site has none', () =>
      ensureHtaccess(exec, docroot, !multisite ? 'single' : subdomain ? 'subdomain' : 'subdirectory', path ? `${path}/` : '/'),
      undefined, 'The site may have no .htaccess, so pages other than the home page can answer 404: Aura offers to write it.',
    );
    // A site under a path gets missing uploads through Local mode; the parent's vhost rule covers only the parent.
    const redirect = input.uploadsVia === 'redirect' ? (input.uploadsFrom ?? null) : null;
    add('local', 'Turn on Local mode (mail to Mailpit, noindex)', () => setLocalMode(exec, docroot, true, undefined, path ? redirect : undefined));
    add('flush', 'Flush caches and rewrite rules', async () => [await wp(['cache', 'flush']), await wp(['rewrite', 'flush'])], undefined, 'Caches and rewrite rules were not flushed: use Clear caches and Flush rewrite rules on the site\'s page.');
  }

  return steps;
}

type BuildStep = NonNullable<CreateInput['builds']>[number];
/** One build as it runs, in its folder of a clone. */
type BuildRun = Omit<BuildStep, 'repo'>;

/** The builds to run: the list the wizard sends, else the two older switches at the repo root. */
export function buildsFor(input: CreateInput): BuildStep[] {
  if (input.builds) return input.builds;
  return [...(input.build.composer ? [{ repo: 0, dir: '', tool: 'composer' as const }] : []), ...(input.build.npm ? [{ repo: 0, dir: '', tool: 'npm' as const, script: 'build' }] : [])];
}

/** The repo holds WordPress core: it is used as it is, with no link and no download. */
export function repoCore(docroot: string): ExecResult {
  try {
    const text = readFileSync(join(docroot, 'wp-includes', 'version.php'), 'utf8');
    const version = /\$wp_version\s*=\s*'([^']+)'/.exec(text)?.[1];
    return ok(`the repo has WordPress ${version ?? '(version unknown)'}; it is used as it is, with no shared core and no download`);
  } catch {
    return { code: 1, stdout: '', stderr: "the repo has no wp-includes/version.php, so it holds no WordPress core: pick a shared core or a download of its own on the WordPress step" };
  }
}

const MANIFEST = { composer: 'composer.json', npm: 'package.json', yarn: 'package.json', pnpm: 'package.json' } as const;

/** A build as you would run it in a terminal, for a skipped build step. */
export function buildCommand(clone: string, build: BuildRun): string {
  const run = build.tool === 'composer' ? 'composer install' : `${build.tool} install${build.script ? ` && ${build.tool} run ${build.script}` : ''}`;
  return `cd ${join(clone, build.dir)} && ${run}`;
}

/**
 * One build in its folder of the clone: composer install, or the package
 * manager's install (ci with a lock file) and the script. A folder that left
 * the clone through a link, or has no manifest any more, is skipped with a note.
 */
export async function runBuild(exec: Executor, clone: string, build: BuildRun, node: NodeOptions = {}): Promise<ExecResult[]> {
  const where = build.dir || '/';
  const folder = join(clone, build.dir);
  const inside = existsSync(folder) && relative(realpathSync(clone), realpathSync(folder)).split(sep)[0] !== '..';
  if (!inside || !existsSync(join(folder, MANIFEST[build.tool]))) return [ok(`${where}: no ${MANIFEST[build.tool]}, skipped`)];
  if (build.tool === 'composer') return [await exec('composer', ['install', '--no-interaction', '--no-progress'], { cwd: folder, timeoutMs: 20 * 60_000 })];
  // The Node picked for the build, the one the repo asks for, or nvm's; the service's own PATH often has no npm at all.
  const choice = nodeFor(folder, clone, { ...node, ...(build.node ? { pick: build.node } : {}) });
  if ('error' in choice) return [{ code: 1, stdout: '', stderr: `${where}: ${choice.error}` }];
  // A script the package.json does not have (it changed since the lookup) is not run, nor is the install for it.
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    // Not JSON: no script runs.
  }
  if (build.script && !(build.script in scripts)) return [ok(`${where}: package.json has no ${build.script} script, skipped`)];
  const attempt = async (on: NodeChoice): Promise<{ ran: ExecResult[]; install: ExecResult }> => {
    const env = nodeEnv(on);
    const run = (file: string, args: string[]) => exec(file, args, { cwd: folder, timeoutMs: 20 * 60_000, env });
    const install =
      build.tool === 'npm'
        ? await run('npm', existsSync(join(folder, 'package-lock.json')) ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'])
        : await run(build.tool, ['install', '--frozen-lockfile']);
    return { install, ran: install.code !== 0 || !build.script ? [install] : [install, quiet(await run(build.tool, ['run', build.script]))] };
  };
  let { ran, install } = await attempt(choice);
  const results = [ok(`${where}: ${choice.note}`)];
  // Nothing named this Node and the failure points at it: once more on the one nvm has that fits.
  const other = (ran.at(-1) as ExecResult).code !== 0 ? secondNode(`${install.stdout}\n${install.stderr}`, choice, folder, node) : undefined;
  if (other) {
    results.push(ok(`warn: ${where}: the build failed on Node ${(choice.version ?? '').slice(1)}: ${other.cause}. Trying once more on ${other.note}`));
    clearModules(folder);
    ({ ran, install } = await attempt(other));
  }
  results.push(...ran);
  // A failure after npm warned the Node is too old says how to get a newer one.
  const last = results.at(-1) as ExecResult;
  const hint = last.code !== 0 ? engineHint(`${install.stdout}\n${install.stderr}`) : undefined;
  // concurrently --kill-others stops the other builds as soon as one ends, which only says SIGTERM.
  const stopped = last.code !== 0 && build.script && STOPPED.test(`${last.stdout}\n${last.stderr}`)
    ? `the build failed: ${build.script} runs its builds with concurrently --kill-others, so the first to finish stopped the others; run one of its parts instead, or change it to --kill-others-on-fail in package.json`
    : undefined;
  const note = stopped ?? hint;
  if (note) results[results.length - 1] = { ...last, stderr: `${last.stderr.trim() ? `${last.stderr.trimEnd()}\n` : ''}${where}: ${note}` };
  return results;
}

/** What concurrently prints when one of its builds ends and --kill-others stops the rest. */
const STOPPED = /^--> Sending SIGTERM to other processes/m;
/** webpack --progress prints a line per plugin and percent: it would push the real output out of what a step keeps. */
const PROGRESS = /\[webpack\.Progress\]/;

/** A build's output without its progress lines. */
function quiet(r: ExecResult): ExecResult {
  const drop = (text: string) => (PROGRESS.test(text) ? text.split('\n').filter((l) => !PROGRESS.test(l)).join('\n') : text);
  return { ...r, stdout: drop(r.stdout), stderr: drop(r.stderr) };
}
