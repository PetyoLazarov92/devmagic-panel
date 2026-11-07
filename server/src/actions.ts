import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ActionId, ActionInput, ActionRunResult, ClaudeRun, ClaudeStep, ClaudeUsage } from '@devmagic-panel/shared';
import { accessKey, actions, presetFromCreate, readKey, repoKey, totalTokens } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import type { CoreStatusMap } from './core-status.js';
import { NSS_NICKNAME } from './environment.js';
import type { ExecResult, Executor } from './exec.js';
import { runRoot } from './exec.js';
import {
  addAliases, clearCache, reloadArgs, clearDebugLog, fixWritable, flushRewrites, login, removeLegacySalts, setConstant, setDebug, setLocalMode, shuffleSalts, setUploadsFrom, SiteActionRefused, siteFor, siteKey, SiteNotFoundError, switchCore, writeHtaccess, type HandlerOutcome,
} from './sites/site-actions.js';
import { findVhost } from './sites/discover.js';
import { Jobs, KEPT_ACTIVITY, type JobOptions, type JobStep } from './jobs.js';
import { readSecrets, type Secrets, writeSecrets } from './secrets.js';
import { createReadOnlyAccount, READ_ONLY_MYSQL_USER } from './mysql-admin.js';
import { planSetSettings } from './mysql-settings.js';
import { contentTitle, planContent, planDropTable, planEmptyTable, planOrphans, planTransients, setAutoload, undoCleanup } from './mysql-cleanup.js';
import { deleteRows, insertRow, type RowsContext, undoRowChange, updateRow } from './mysql-rows.js';
import { resetSlowQueries } from './mysql-slow.js';
import { deleteProfiles } from './profiles.js';
import { killQuery, planWrite } from './mysql-write.js';
import { planImportDump } from './mysql-transfer.js';
import { CoreRefused, planAddCore, removeCore } from './sites/cores.js';
import { CreateRefused, planCreate } from './sites/create.js';
import { planCleanCopy } from './sites/clean.js';
import { planCleanCurrent } from './sites/clean-current.js';
import { deleteCleanCopy, planExportClean } from './sites/export.js';
import { deleteKept, planRestoreKept } from './sites/kept.js';
import { DbRefused, deleteSnapshot, planImport, planRestore, planSearchReplace, planSnapshot } from './sites/db.js';
import { fetchOrigin, pull, switchBranch } from './sites/git.js';
import { setPlugin } from './sites/plugins.js';
import { planAddNetworkAdmin } from './sites/network-admin.js';
import { openTerminal } from './terminal.js';
import type { Drafts } from './drafts.js';
import { findClaude } from './org/claude-code.js';
import { DumpRefused, planDriveDownload, planUseDownloaded } from './org/dumps.js';
import { checkAccess, type ClaudeSettings, readRepo } from './org/read.js';
import { archiveSteps, currentSite } from './sites/archive.js';
import { planRemove, RemoveRefused, stampDate } from './sites/remove.js';
import { removeUpload } from './sites/uploads.js';
import { planAdoptIni, PhpSettingsRefused, setPhpIni, setPhpModule, setXdebug } from './php/settings.js';
import { planMatchFpm, planSitePhp } from './php/site-php.js';
import { forgetCompat, planCheckCompat, planCheckCompatAll, wordpressSites } from './php/compat.js';
import { planInstallVersion, planPhpPackage, planRemoveVersion, planUpgradeVersion, setCliVersion } from './php/apt.js';
import { planSwitchToFpm, planSwitchToModPhp } from './php/switch.js';
import { planNginxSetup, planNginxTeardown } from './nginx.js';
import { planSetServer, planSetServerAll } from './sites/server-switch.js';
import { analyzeDatabases, deleteMysqlBackup, type MysqlContext, mysqlBackupsDir, MysqlRefused, planDropDatabase, planDropUsers, planOptimize, resetSiteUser } from './mysql-server.js';
import type { RunStore } from './store.js';
import { clearMail, type Downloader, mailpitFetch, type MailpitFetch, planInstallMailpit } from './mailpit.js';
import { writeAutostart } from './autostart.js';
import { planTrashRestore, TrashRefused } from './sites/trash.js';
import { checkUpdate, installedReleases, installerCheck, panelCli, planSwitch, planUpdate, type UpdateContext } from './update.js';
import { forgetOnFailure, type HeldPassword, installRunning, planInstallRelease } from './update-install.js';
import { changeCrontab, type CronChange, type CronCommand, cronCommand, type CronContext, cronLockDir, CronRefused, findTask, newTaskId, type PanelTask, parseCrontab, readCrontab, taskArgs, tasksOf, undoCrontab } from './cron.js';
import { runCronTask, taskRefusal } from './cron-run.js';
import { deleteWpCronEvent, restoreWpCronEvent, runWpCronHook, setSiteWpCron } from './sites/wp-cron.js';
import { planFixTable, planToInnodb } from './mysql-health.js';
import { planAutoloadOff } from './wordpress-plugins.js';

export interface ActionContext {
  config: SystemConfig;
  exec: Executor;
  store: RunStore;
  dmpRoot: string;
  wpcoreBin: string;
  wpcoreConf: string;
  home: string;
  jobs: Jobs;
  uploadsDir: string;
  secrets: Secrets | null;
  /** Where secrets are saved, for an action that adds one (the read-only MySQL account). */
  secretsFile?: string;
  /** WordPress.org's status per release, to check a core before downloading it. */
  coreStatus?: () => Promise<CoreStatusMap | null>;
  /** The run history row of the current call. */
  runId?: number;
  /** The action being run, set by runAction; jobs carry it as their kind. */
  actionId?: ActionId;
  /** Mailpit's API and the release download; tests swap in fakes. */
  mailpit?: MailpitFetch;
  download?: Downloader;
  /** The panel's own repository and logs, for panel.update. */
  update?: UpdateContext;
  /** Install drafts, which site.create keeps while it runs and finishes once it is done. */
  drafts?: Drafts;
  /** Where Claude Code is looked for and works, for the organization install's steps. */
  claudeCode?: { home: string; searchPath: string; workDir: string };
  /** What the panel's crontab lines run, and /etc for the system cron; tests pass their own. */
  cron?: CronSetup;
}

export interface CronSetup {
  command?: CronCommand;
  etcDir?: string;
}

type Handler<Id extends ActionId> = (ctx: ActionContext, input: ActionInput<Id>) => Promise<ExecResult[] | HandlerOutcome>;

const root = (ctx: ActionContext, ...args: string[]) => runRoot(ctx.exec, ctx.dmpRoot, args);

/** What the MySQL actions need: the admin account, the panel's kept databases and where deletions are saved. */
const mysqlCtx = (ctx: ActionContext): MysqlContext => ({
  config: ctx.config,
  exec: ctx.exec,
  mysql: ctx.secrets?.mysql,
  kept: () => ctx.store.keptDatabases(),
  backupsDir: mysqlBackupsDir(ctx.uploadsDir),
});

/** What the cron actions need: the crontab, the run history and what the panel's lines run. */
export const cronCtx = (ctx: Pick<ActionContext, 'config' | 'exec' | 'store' | 'uploadsDir' | 'update' | 'cron'>): CronContext => ({
  config: ctx.config,
  exec: ctx.exec,
  store: ctx.store,
  command: ctx.cron?.command ?? cronCommand(process.execPath, dirname(ctx.uploadsDir), panelCli(ctx.update)),
  ...(ctx.cron?.etcDir ? { etcDir: ctx.cron.etcDir } : {}),
});

/** A crontab change, with its saved copy for the toast's Undo. */
const cronOutcome = (change: Pick<CronChange, 'results' | 'backup'>): HandlerOutcome => ({ results: change.results, data: { backup: change.backup } });

/** Refuses a task that cannot run as asked before it goes into the crontab. */
async function checkTask(ctx: ActionContext, task: ActionInput<'cron.add'>['task']): Promise<void> {
  const refusal = await taskRefusal(ctx.exec, ctx.config, task);
  if (refusal) throw new CronRefused(refusal);
}

const REMOVED_CRON = (domain: string) => `cron-removed:${domain}`;

/**
 * The first step of a removal: the site's cron tasks leave the crontab, so
 * they do not fail every few minutes, and are kept for a restore. A crontab
 * the panel cannot change never stops the removal.
 */
function removeCronStep(ctx: ActionContext, domain: string): JobStep {
  return {
    id: 'cron',
    label: 'Remove its cron tasks',
    run: async () => {
      const ours = (t: PanelTask) => 'domain' in t.task && t.task.domain === domain;
      try {
        const removed = tasksOf(parseCrontab(await readCrontab(ctx.exec))).filter(ours);
        if (removed.length === 0) return { code: 0, stdout: 'no cron tasks of the panel run for this site', stderr: '' };
        const change = await changeCrontab(cronCtx(ctx), (tasks) => tasks.filter((t) => !ours(t)), `removed ${removed.length} cron task${removed.length === 1 ? '' : 's'}; a restore puts ${removed.length === 1 ? 'it' : 'them'} back`);
        if (change.results.every((r) => r.code === 0)) ctx.store.setMeta(REMOVED_CRON(domain), JSON.stringify(removed));
        return change.results;
      } catch (error) {
        return { code: 0, stdout: `left the crontab as it is: ${(error as Error).message}`, stderr: '' };
      }
    },
  };
}

/** A restored site gets back the cron tasks its removal took out. */
async function restoreCronTasks(ctx: ActionContext, domain: string): Promise<void> {
  const kept = ctx.store.getMeta(REMOVED_CRON(domain));
  if (!kept) return;
  try {
    const back = JSON.parse(kept) as PanelTask[];
    await changeCrontab(cronCtx(ctx), (tasks) => {
      const ids = new Set(tasks.map((t) => t.id));
      return [...tasks, ...back.map((t) => (ids.has(t.id) ? { ...t, id: newTaskId([...ids]) } : t))];
    }, `put back ${back.length} cron task${back.length === 1 ? '' : 's'} of ${domain}`);
    ctx.store.deleteMeta(REMOVED_CRON(domain));
  } catch {
    // The tasks stay noted for the next restore; the site is back either way.
  }
}

/** Runs steps in order and stops at the first failure. */
const siteKeyOf = (input: { domain: string; path?: string | undefined }) => `${input.domain}${input.path ?? ''}`;

const rowsCtx = (ctx: ActionContext): RowsContext => ({
  config: ctx.config,
  exec: ctx.exec,
  mysql: ctx.secrets?.mysql,
  kept: () => ctx.store.keptDatabases(),
  // Only a job makes a site busy here: the action asking holds the site's key itself while it runs (db.setAutoload).
  siteBusy: (site) => ctx.jobs.busyFor(site)?.jobId !== undefined,
});

function rowOutcome({ change, ...result }: ExecResult & { change?: string }): HandlerOutcome {
  return { results: [result], ...(change ? { data: { backup: change } } : {}) };
}

/** Makes the SQL runner's read-only account with the admin account and saves it next to the admin account in secrets.json. */
async function makeReadOnlyAccount(ctx: ActionContext): Promise<ExecResult> {
  const admin = ctx.secrets?.mysql;
  if (!admin) throw new MysqlRefused('The panel has no MySQL admin account: add one under Aura, Machine checks');
  if (!ctx.secretsFile) throw new MysqlRefused('The panel cannot write its secrets file here');
  const made = await createReadOnlyAccount(ctx.exec, admin);
  if ('problem' in made) return { code: 1, stdout: '', stderr: made.problem };
  // Read again just before writing: the file may have changed since this request began.
  const current = readSecrets(ctx.secretsFile);
  if (!current) return { code: 1, stdout: '', stderr: 'The secrets file is gone: run setup again' };
  writeSecrets(ctx.secretsFile, { ...current, mysqlReadOnly: made.account });
  return { code: 0, stdout: `${READ_ONLY_MYSQL_USER}@localhost can read every database and change none; its password is in the panel's secrets file`, stderr: '' };
}

async function steps(...run: Array<() => Promise<ExecResult>>): Promise<ExecResult[]> {
  const results: ExecResult[] = [];
  for (const step of run) {
    const result = await step();
    results.push(result);
    if (result.code !== 0) break;
  }
  return results;
}

async function trustBrowsers(ctx: ActionContext): Promise<ExecResult[]> {
  const ca = join(ctx.config.CA_DIR, 'ca.pem');
  const stores = [join(ctx.home, '.pki', 'nssdb')];
  for (const base of [join(ctx.home, '.mozilla', 'firefox'), join(ctx.home, 'snap', 'firefox', 'common', '.mozilla', 'firefox')]) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (existsSync(join(base, name, 'cert9.db'))) stores.push(join(base, name));
    }
  }
  const results: ExecResult[] = [];
  if (!existsSync(join(stores[0] as string, 'cert9.db'))) {
    results.push(await ctx.exec('mkdir', ['-p', stores[0] as string]));
    results.push(await ctx.exec('certutil', ['-N', '-d', `sql:${stores[0]}`, '--empty-password']));
  }
  for (const store of stores) {
    results.push(await ctx.exec('certutil', ['-A', '-d', `sql:${store}`, '-n', NSS_NICKNAME, '-t', 'C,,', '-i', ca]));
  }
  return results;
}

/** At most this many site installs run at once; more wait in a queue. Each clones, imports and replaces, which is heavy on disk and CPU. */
export const MAX_PARALLEL_INSTALLS = 2;

/** Starts a job; the job finishes the run history row itself. */
function startJob(ctx: ActionContext, steps: JobStep[], title: string, target: string, extra: Pick<JobOptions, 'onDone' | 'onUndone' | 'upload' | 'stoppable'> = {}): HandlerOutcome {
  const view = ctx.jobs.start(steps, { runId: ctx.runId as number, title, target, ...(ctx.actionId ? { kind: ctx.actionId } : {}), ...extra });
  return { results: [{ code: 0, stdout: `started ${view.id}`, stderr: '' }], data: { jobId: view.id }, detached: true };
}

/**
 * A Claude Code step of an install from an organization, as a job, noted on
 * the draft with what it is for (key) so the wizard finds it after you left;
 * its answer is kept there too. A second start for the same key follows the
 * running job instead of paying for another.
 */
/** What a Claude Code step did so far: shown on its job as it goes and kept with its answer. */
interface Activity {
  add: (line: string) => void;
  lines: string[];
}

function claudeJob(ctx: ActionContext, step: ClaudeStep, draftId: string, key: string, title: string, label: string, settings: ClaudeRun, run: (claude: ClaudeSettings, workDir: string, activity: Activity) => Promise<string>): HandlerOutcome | ExecResult[] {
  const noted = ctx.drafts?.get(draftId)?.jobs?.[step];
  const running = noted?.key === key ? ctx.jobs.get(noted.id) : undefined;
  if (running && (running.status === 'running' || running.status === 'queued')) return { results: [{ code: 0, stdout: `already running as ${running.id}`, stderr: '' }], data: { jobId: running.id }, detached: true };
  const where = ctx.claudeCode;
  const bin = where ? findClaude(where.home, where.searchPath) : null;
  if (!where || !bin) return [{ code: 1, stdout: '', stderr: 'Claude Code is not installed or not found: install it and sign in with claude auth login' }];
  const outcome = startJob(
    ctx,
    [
      {
        id: step,
        label,
        run: async (job) => {
          const activity: Activity = {
            lines: [],
            add(line) {
              activity.lines = [...activity.lines, line].slice(-KEPT_ACTIVITY);
              job.activity?.(line);
            },
          };
          return { code: 0, stdout: await run({ bin, ...settings }, where.workDir, activity), stderr: '' };
        },
      },
    ],
    title,
    draftId,
  );
  const jobId = outcome.data?.jobId;
  if (typeof jobId === 'string') ctx.drafts?.noteJob(draftId, step, jobId, key);
  return outcome;
}

/** A Claude Code run for Run history: its time, tokens and estimate at API prices. */
const usageText = (u: ClaudeUsage) =>
  [u.durationMs !== undefined ? `${Math.round(u.durationMs / 1000)} s` : '', u.tokens ? `${totalTokens(u.tokens)} tokens` : '', `$${u.costUsd.toFixed(2)} at API prices`].filter(Boolean).join(', ');

/** A dump job for an install is noted on its draft, so the wizard follows it after you left. */
function noteDump(ctx: ActionContext, draftId: string | undefined, outcome: HandlerOutcome): HandlerOutcome {
  const jobId = outcome.data?.jobId;
  if (draftId && typeof jobId === 'string') ctx.drafts?.noteJob(draftId, 'dump', jobId);
  return outcome;
}

const handlers: { [Id in ActionId]: Handler<Id> } = {
  'apache.enableModule': (ctx, { module }) =>
    steps(() => root(ctx, 'apache-module-enable', module), () => root(ctx, 'apache-reload')),
  'apache.reload': (ctx) => steps(() => root(ctx, 'apache-reload')),
  'apache.setModule': (ctx, { module, enabled }) => steps(() => root(ctx, 'apache-module', module, enabled ? 'on' : 'off')),
  'service.restart': (ctx, { service }) => steps(() => root(ctx, 'service-restart', service)),
  'nginx.setup': async (ctx) => startJob(ctx, planNginxSetup(ctx), 'Set nginx up next to Apache', 'nginx'),
  'nginx.teardown': async (ctx) => startJob(ctx, planNginxTeardown(ctx), 'Turn nginx off', 'nginx'),
  'nginx.reload': (ctx) => steps(() => root(ctx, 'nginx-reload')),
  'sites.setServerAll': async (ctx, input) =>
    startJob(ctx, planSetServerAll(ctx, input), input.server === 'nginx' ? 'Move every site to nginx' : 'Move every site to Apache', 'web servers'),
  'site.setServer': async (ctx, input) =>
    startJob(ctx, planSetServer(ctx, input), input.server === 'nginx' ? `Run ${input.domain} on nginx` : `Run ${input.domain} on Apache again`, input.domain),
  'mysql.analyze': (ctx, input) => analyzeDatabases(mysqlCtx(ctx), input),
  'mysql.optimize': async (ctx, input) =>
    startJob(ctx, await planOptimize(mysqlCtx(ctx), input, (s) => ctx.jobs.busyFor(`${s.domain}${s.path ?? ''}`) !== undefined), `Optimize ${input.database}`, input.database),
  'mysql.setSettings': async (ctx, input) => {
    const { title, steps } = await planSetSettings({ config: ctx.config, exec: ctx.exec, mysql: ctx.secrets?.mysql, dmpRoot: ctx.dmpRoot, memo: ctx.store }, input);
    return startJob(ctx, steps, title, 'mysql settings');
  },
  'mysql.dropDatabase': async (ctx, input) => startJob(ctx, await planDropDatabase(mysqlCtx(ctx), input), `Delete database ${input.database}`, input.database),
  'mysql.dropUsers': async (ctx, input) =>
    startJob(ctx, await planDropUsers(mysqlCtx(ctx), input), `Delete ${input.accounts.length === 1 ? `${input.accounts[0]?.user}@${input.accounts[0]?.host}` : `${input.accounts.length} MySQL users`}`, 'mysql users'),
  'mysql.resetSiteUser': (ctx, input) => resetSiteUser(mysqlCtx(ctx), input),
  'mysql.makeReadOnlyAccount': async (ctx) => [await makeReadOnlyAccount(ctx)],
  // A row change answers with the name of its saved copy, for the Undo in its toast.
  'mysql.updateRow': async (ctx, input) => rowOutcome(await updateRow(rowsCtx(ctx), input)),
  'mysql.insertRow': async (ctx, input) => rowOutcome(await insertRow(rowsCtx(ctx), input)),
  'mysql.deleteRows': async (ctx, input) => rowOutcome(await deleteRows(rowsCtx(ctx), input)),
  'mysql.undoRowChange': async (ctx, input) => [await undoRowChange(rowsCtx(ctx), input)],
  // Clean-ups are jobs: save what they remove, then remove it; their Undo, and mysql.undoCleanup later, put it back.
  'db.cleanTransients': async (ctx, input) => startJob(ctx, await planTransients(rowsCtx(ctx), input), input.scope === 'expired' ? 'Delete expired transients' : 'Delete every transient', siteKeyOf(input), { stoppable: true }),
  'db.cleanContent': async (ctx, input) => startJob(ctx, await planContent(rowsCtx(ctx), input), contentTitle(input.kinds, input.orphans), siteKeyOf(input), { stoppable: true }),
  'db.cleanOrphans': async (ctx, input) => startJob(ctx, await planOrphans(rowsCtx(ctx), input), 'Delete what was left behind', siteKeyOf(input), { stoppable: true }),
  'db.toInnodb': async (ctx, input) => {
    const { title, steps } = await planToInnodb(rowsCtx(ctx), input);
    return startJob(ctx, steps, title, siteKeyOf(input), { stoppable: true });
  },
  'db.fixTable': async (ctx, input) => {
    const { title, steps } = await planFixTable(rowsCtx(ctx), input);
    return startJob(ctx, steps, title, siteKeyOf(input));
  },
  'db.autoloadOff': async (ctx, input) => {
    const { title, steps } = await planAutoloadOff(rowsCtx(ctx), input);
    return startJob(ctx, steps, title, siteKeyOf(input), { stoppable: true });
  },
  'db.setAutoload': async (ctx, input) => rowOutcome(await setAutoload(rowsCtx(ctx), input)),
  'mysql.emptyTable': async (ctx, input) => startJob(ctx, await planEmptyTable(rowsCtx(ctx), input), `Empty ${input.table}`, `database ${input.database}`),
  'mysql.dropTable': async (ctx, input) => startJob(ctx, await planDropTable(rowsCtx(ctx), input), `Delete table ${input.table}`, `database ${input.database}`),
  'mysql.undoCleanup': async (ctx, input) => [await undoCleanup(rowsCtx(ctx), input)],
  // The job's title names the statement's kind and tables, never its text: run history keeps titles.
  'mysql.runSql': async (ctx, input) => {
    const { title, steps } = await planWrite(rowsCtx(ctx), input);
    return startJob(ctx, steps, title, `database ${input.database}`);
  },
  'mysql.killQuery': async (ctx, input) => [await killQuery(rowsCtx(ctx), input)],
  'mysql.resetQueryStats': async (ctx) => [await resetSlowQueries(rowsCtx(ctx))],
  'profile.delete': async (ctx, input) => [deleteProfiles(ctx.config, dirname(ctx.uploadsDir), input.profiles)],
  'mysql.importDump': async (ctx, input) =>
    startJob(
      ctx,
      await planImportDump({ config: ctx.config, exec: ctx.exec, mysql: ctx.secrets?.mysql, kept: () => ctx.store.keptDatabases(), uploadsDir: ctx.uploadsDir, backupsDir: mysqlBackupsDir(ctx.uploadsDir) }, input),
      input.mode === 'replace' ? `Replace ${input.database} with a dump` : `Import a dump into a new database ${input.database}`,
      `database ${input.database}`,
      { upload: input.uploadId },
    ),
  'mysql.deleteBackup': async (ctx, input) => [deleteMysqlBackup(mysqlBackupsDir(ctx.uploadsDir), input)],
  'php.setXdebug': (ctx, input) => setXdebug(ctx.config, ctx.exec, ctx.dmpRoot, input),
  'php.setModule': (ctx, input) => setPhpModule(ctx.config, ctx.exec, ctx.dmpRoot, input),
  'php.setIni': (ctx, input) => setPhpIni(ctx.exec, ctx.dmpRoot, input),
  'php.switchToFpm': async (ctx, { version }) => startJob(ctx, planSwitchToFpm(ctx, version), `Run every site on PHP ${version} through PHP-FPM`, 'PHP'),
  'php.switchToModPhp': async (ctx, { version }) => startJob(ctx, planSwitchToModPhp(ctx, version), `Run sites on mod_php ${version} again`, 'PHP'),
  'php.install': async (ctx, { version }) => startJob(ctx, planInstallVersion(ctx, version), `Install PHP ${version}`, `PHP ${version}`),
  'php.package': async (ctx, { version, name, how }) => startJob(ctx, planPhpPackage(ctx, version, name, how), `${how === 'install' ? 'Install' : 'Remove'} php${version}-${name}`, `PHP ${version}`),
  'php.upgrade': async (ctx, { version }) => startJob(ctx, planUpgradeVersion(ctx, version), `Update PHP ${version}`, `PHP ${version}`),
  'php.remove': async (ctx, { version }) => startJob(ctx, await planRemoveVersion(ctx, version), `Remove PHP ${version}`, `PHP ${version}`),
  'php.setCli': (ctx, { version }) => setCliVersion(ctx, version),
  'php.matchFpm': async (ctx, { version }) => startJob(ctx, planMatchFpm(ctx, version), `Make PHP-FPM ${version} match Apache's PHP ${version}`, `PHP ${version}`),
  'site.setPhp': async (ctx, { domain, path, version, values }) => {
    const site = siteFor(ctx.config, domain, path);
    const title = version === null && Object.keys(values).length === 0 ? `Put ${site.host} back on the default PHP` : `Run ${site.host} on PHP ${version ?? 'the default version'}`;
    return startJob(ctx, planSitePhp(ctx, site, { version, values }), title, site.host);
  },
  'php.deleteCompat': async (ctx, { domain, path, version }) => {
    if (!domain && !version) throw new ActionInputError('Give a site, a PHP version or both');
    if (path && !domain) throw new ActionInputError('A path needs the domain it is under');
    const n = forgetCompat(ctx.store, dirname(ctx.uploadsDir), { ...(domain ? { key: siteKey(domain, path) } : {}), ...(version ? { version } : {}) });
    const what = domain ? `${domain}${path ?? ''}${version ? ` on PHP ${version}` : ''}` : `every site on PHP ${version}`;
    return [{ code: 0, stdout: n ? `deleted ${n} compatibility scan${n === 1 ? '' : 's'} of ${what}` : `no compatibility scan of ${what} was kept`, stderr: '' }];
  },
  'php.checkCompatAll': async (ctx, { version, scope }) =>
    startJob(ctx, planCheckCompatAll({ config: ctx.config, exec: ctx.exec, store: ctx.store, dataDir: dirname(ctx.uploadsDir) }, wordpressSites(ctx.config), { version, scope }), `Check every site against PHP ${version}`, `PHP ${version}`),
  'php.checkCompat': async (ctx, { domain, path, version, scope }) => {
    const site = siteFor(ctx.config, domain, path);
    return startJob(ctx, planCheckCompat({ config: ctx.config, exec: ctx.exec, store: ctx.store, dataDir: dirname(ctx.uploadsDir) }, site, { version, scope }), `Check ${site.host} against PHP ${version}`, site.host);
  },
  'php.adoptIni': async (ctx, { version }) =>
    startJob(ctx, planAdoptIni(ctx.config, ctx.exec, ctx.dmpRoot, version), `Move PHP ${version}'s php.ini changes into the panel's settings`, `PHP ${version}`),
  'ca.trustSystem': (ctx) => steps(() => root(ctx, 'ca-trust')),
  'ca.trustBrowsers': (ctx) => trustBrowsers(ctx),
  'ca.untrustLegacy': (ctx) => steps(() => root(ctx, 'ca-untrust-legacy')),
  'hosts.add': (ctx, { domain, aliases }) => steps(() => root(ctx, 'hosts-add', domain, ...aliases)),
  'hosts.remove': (ctx, { domain }) => steps(() => root(ctx, 'hosts-remove', domain)),
  'cert.reissue': (ctx, { domain }) => steps(() => root(ctx, 'cert-reissue-from-vhost', domain), () => root(ctx, ...reloadArgs(findVhost(ctx.config, domain)))),
  'site.setLocalMode': setLocalMode,
  'site.writeHtaccess': writeHtaccess,
  'trash.restore': async (ctx, input) => {
    const domain = input.id.slice(0, -16);
    const current = currentSite(ctx, domain);
    if (current && !input.replaceCurrent) throw new TrashRefused(`${domain} exists again; confirm replacing it, and it goes to the archive first`);
    // The site there now goes to the archive first; its database is dropped with it, so the archived copy's may come back.
    const first = input.replaceCurrent ? archiveSteps(ctx, domain, 'restore') : [];
    const steps = [...first, ...(await planTrashRestore(ctx, input, current?.dbName ? { replacingDb: current.dbName } : {}))];
    const before = ctx.store.archivedInstall(input.id);
    return startJob(ctx, steps, `Restore ${domain}`, domain, {
      onDone: async () => {
        ctx.store.setInstall(domain, undefined, { ...(before?.repo ? { repo: before.repo } : {}), ...(before?.org ? { org: before.org } : {}), how: 'restore', at: new Date().toISOString(), archivedAt: stampDate(input.id.slice(-15)) });
        ctx.store.forgetArchive(input.id);
        await restoreCronTasks(ctx, domain);
      },
    });
  },
  'trash.delete': async (ctx, input) => {
    const r = await runRoot(ctx.exec, ctx.dmpRoot, ['trash-delete', input.id]);
    if (r.code === 0) ctx.store.forgetArchive(input.id);
    return [r];
  },
  'org.readRepo': async (ctx, input) =>
    claudeJob(ctx, 'read', input.draftId, readKey(input.fullName, input.branch), `Read ${input.fullName} with Claude Code`, `Claude Code reads the docs of ${input.fullName}`, input.settings, async (claude, workDir, activity) => {
      const r = await readRepo(ctx.exec, workDir, claude, input, activity.add);
      const { facts, files, ...usage } = r;
      ctx.drafts?.saveResult(input.draftId, 'read', { key: readKey(input.fullName, input.branch), facts, files, ...usage, activity: activity.lines });
      return `Read ${files.length} files of ${input.fullName} (${input.branch}): ${usageText(usage)}`;
    }),
  'org.checkAccess': async (ctx, input) =>
    claudeJob(ctx, 'access', input.draftId, accessKey(input.fullName, input.links, input.dumpHints), `Check the links of ${input.fullName} with Claude Code`, `Claude Code checks ${input.links.length} links`, input.settings, async (claude, workDir, activity) => {
      const r = await checkAccess(ctx.exec, workDir, claude, { fullName: input.fullName }, input.links, input.dumpHints, activity.add);
      const { report, ...usage } = r;
      ctx.drafts?.saveResult(input.draftId, 'access', { key: accessKey(input.fullName, input.links, input.dumpHints), report, ...usage, activity: activity.lines });
      return `Checked ${report.links.length} links and found ${report.dumps.length} dumps: ${usageText(usage)}`;
    }),
  'dump.download': async (ctx, input) => {
    let upload: string | undefined;
    const steps = await planDriveDownload(ctx, input, (id) => {
      upload = id;
      if (input.draftId) ctx.drafts?.attach(input.draftId, id);
    });
    return noteDump(ctx, input.draftId, startJob(ctx, steps, `Download ${input.name}`, input.draftId ?? input.fileId, { onUndone: () => upload && input.draftId && ctx.drafts?.detach(input.draftId, upload) }));
  },
  'dump.useDownloaded': async (ctx, input) => {
    let upload: string | undefined;
    const steps = planUseDownloaded(ctx, input, (id) => {
      upload = id;
      if (input.draftId) ctx.drafts?.attach(input.draftId, id);
    });
    return noteDump(ctx, input.draftId, startJob(ctx, steps, `Use ${input.file.split('/').pop() ?? 'the dump'}`, input.draftId ?? input.file, { onUndone: () => upload && input.draftId && ctx.drafts?.detach(input.draftId, upload) }));
  },
  'mailpit.install': async (ctx) =>
    startJob(ctx, planInstallMailpit({ exec: ctx.exec, dataDir: dirname(ctx.uploadsDir), home: ctx.home, ...(ctx.download ? { download: ctx.download } : {}) }), 'Install Mailpit', 'mailpit'),
  'panel.autostart': async (ctx) => {
    const file = writeAutostart(ctx.home, process.execPath, panelCli(ctx.update));
    return [{ code: 0, stdout: `wrote ${file}: the panel and Mailpit start after you log in`, stderr: '' }];
  },
  'site.skippedDone': async (ctx, input) => {
    const site = `${input.domain}${input.path ?? ''}`;
    if (!ctx.store.skippedDone(input.domain, input.path, input.label)) throw new ActionInputError(`${site} has no skipped step called ${input.label}`);
    return [{ code: 0, stdout: `${input.label}: marked done on ${site}`, stderr: '' }];
  },
  'history.clear': async (ctx) => [{ code: 0, stdout: `deleted ${ctx.store.clearRuns()} runs`, stderr: '' }],
  'cron.add': async (ctx, input) => {
    await checkTask(ctx, input.task);
    const { title, schedule, enabled, timeoutMinutes, task } = input;
    return cronOutcome(await changeCrontab(cronCtx(ctx), (tasks) => [...tasks, { id: newTaskId(tasks.map((t) => t.id)), title, schedule, enabled, timeoutMinutes, task }], `added the task ${title}: ${schedule}`));
  },
  'cron.update': async (ctx, input) => {
    await checkTask(ctx, input.task);
    const { id, title, schedule, enabled, timeoutMinutes, task } = input;
    return cronOutcome(
      await changeCrontab(cronCtx(ctx), (tasks) => {
        findTask(tasks, id);
        return tasks.map((t) => (t.id === id ? { id, title, schedule, enabled, timeoutMinutes, task } : t));
      }, `changed the task ${title}`),
    );
  },
  'cron.setEnabled': async (ctx, { id, enabled }) =>
    cronOutcome(
      await changeCrontab(cronCtx(ctx), (tasks) => {
        findTask(tasks, id);
        return tasks.map((t) => (t.id === id ? { ...t, enabled } : t));
      }, `turned ${enabled ? 'on' : 'off'} the task ${id}`),
    ),
  'cron.remove': async (ctx, { id }) =>
    cronOutcome(
      await changeCrontab(cronCtx(ctx), (tasks) => {
        findTask(tasks, id);
        return tasks.filter((t) => t.id !== id);
      }, `removed the task ${id}; its runs are kept 14 days`),
    ),
  'cron.undo': async (ctx, { backup }) => cronOutcome(await undoCrontab(cronCtx(ctx), backup)),
  'cron.clearRuns': async (ctx, { id }) => [{ code: 0, stdout: `deleted ${ctx.store.clearCronRuns(id)} runs of the task ${id}`, stderr: '' }],
  'cron.runNow': async (ctx, { id }) => {
    const task = findTask(tasksOf(parseCrontab(await readCrontab(ctx.exec))), id);
    const runner = { config: ctx.config, exec: ctx.exec, store: ctx.store, lockDir: cronLockDir(dirname(ctx.uploadsDir)), home: ctx.home };
    return startJob(
      ctx,
      [
        {
          id: 'run',
          label: `Run ${task.title}`,
          run: async () => {
            const run = await runCronTask(runner, taskArgs(task), 'manual');
            const code = run.status === 'ok' ? 0 : (run.exitCode ?? 1) || 1;
            return code === 0 ? { code, stdout: run.output || 'done, it printed nothing', stderr: '' } : { code, stdout: '', stderr: run.output || run.status };
          },
        },
      ],
      `Run ${task.title}`,
      `cron task ${id}`,
    );
  },
  'cron.setSiteWpCron': async (ctx, { domain, path, fromCron, schedule }) => cronOutcome(await setSiteWpCron(cronCtx(ctx), siteFor(ctx.config, domain, path), fromCron, schedule)),
  'wpcron.run': async (ctx, { domain, path, url, hook }) => runWpCronHook(ctx.exec, siteFor(ctx.config, domain, path), hook, url),
  'wpcron.delete': async (ctx, { domain, path, url, hook, time, sig }) => {
    const r = await deleteWpCronEvent(cronCtx(ctx), siteFor(ctx.config, domain, path), { hook, time, sig, ...(url ? { url } : {}) });
    return { results: r.results, ...(r.backup ? { data: { backup: r.backup } } : {}) };
  },
  'wpcron.undo': async (ctx, { domain, path, url, backup }) => restoreWpCronEvent(cronCtx(ctx), siteFor(ctx.config, domain, path), backup, url),
  'mail.clear': async (ctx, input) => [await clearMail(ctx.mailpit ?? mailpitFetch, input.domain)],
  'panel.update': async (ctx, input) => {
    if (!ctx.update) throw new ActionInputError('updates are not set up in this panel');
    const status = await checkUpdate(ctx.update);
    if (!status.available || status.latest !== input.version) throw new ActionInputError(`${input.version} is not the newest release (${status.latest ?? status.error ?? 'none found'})`);
    if (status.mode === 'blocked') throw new ActionInputError(status.reason ?? status.error ?? `${input.version} cannot be installed from the panel`);
    const title = status.mode === 'panel' ? `Update the panel to ${input.version}` : `Download ${input.version} for a terminal install`;
    return startJob(ctx, planUpdate(ctx.update, input.version, status.mode), title, 'panel');
  },
  'panel.installRelease': async (ctx, input) => {
    if (!ctx.update) throw new ActionInputError('updates are not set up in this panel');
    const release = installedReleases(ctx.update).find((r) => r.name === input.release);
    const dir = join(ctx.update.dataDir, 'releases', input.release);
    if (release && !release.fromPanel) throw new ActionInputError(`${input.release}'s install.sh cannot install from the panel (that came in v0.25.0): run ${join(dir, 'install.sh')} in a terminal`);
    let download: JobStep[] = [];
    if (!release) {
      // Not here yet: the newest release, when it needs the password, downloads first in the same job.
      const status = await checkUpdate(ctx.update);
      if (!status.available || status.latest !== input.release) throw new ActionInputError(`${input.release} is not installed and is not the newest release (${status.latest ?? status.error ?? 'none found'})`);
      if (status.mode !== 'terminal') throw new ActionInputError(status.mode === 'panel' ? `${input.release} needs no password: update to it from the Updates page` : (status.reason ?? status.error ?? `${input.release} cannot be installed from the panel`));
      download = planUpdate(ctx.update, input.release, 'download');
    }
    if (await installRunning({ exec: ctx.exec, dataDir: ctx.update.dataDir })) throw new ActionBusyError('An install from the Updates page is still running');
    const held: HeldPassword = { value: input.password };
    const before: JobStep[] = download.length ? [...download, installerCheck(input.release, dir)].map((step) => forgetOnFailure(held, step)) : [];
    const steps = planInstallRelease({ exec: ctx.exec, dataDir: ctx.update.dataDir, store: ctx.store }, { name: input.release, dir }, held, ctx.runId as number);
    return startJob(ctx, [...before, ...steps], `${download.length ? 'Download and install' : 'Install'} ${input.release} with your sudo password`, 'panel');
  },
  'panel.switchRelease': async (ctx, input) => {
    if (!ctx.update) throw new ActionInputError('updates are not set up in this panel');
    const release = installedReleases(ctx.update).find((r) => r.name === input.release);
    if (!release) throw new ActionInputError(`${input.release} is not installed`);
    if (release.current) throw new ActionInputError(`the panel already runs ${input.release}`);
    if (release.mode === 'terminal') {
      throw new ActionInputError(`${input.release} has other root scripts than the installed ones: run ${join(ctx.update.dataDir, 'releases', input.release, 'install.sh')} in a terminal to switch to it`);
    }
    return startJob(ctx, planSwitch(ctx.update, input.release), `Switch the panel to ${input.release}`, 'panel');
  },
  'site.setUploadsFrom': setUploadsFrom,
  'site.addAliases': addAliases,
  'site.fixWritable': fixWritable,
  'git.fetch': fetchOrigin,
  'git.pull': pull,
  'git.switch': switchBranch,
  'db.snapshot': async (ctx, input) => startJob(ctx, planSnapshot(ctx, input), `Snapshot ${input.domain}${input.path ?? ''}`, `${input.domain}${input.path ?? ''}`),
  'db.restore': async (ctx, input) => startJob(ctx, planRestore(ctx, input), `Restore ${input.snapshot} on ${input.domain}${input.path ?? ''}`, `${input.domain}${input.path ?? ''}`),
  'db.deleteSnapshot': async (ctx, input) => [deleteSnapshot(ctx.config, input)],
  'db.import': async (ctx, input) =>
    startJob(ctx, planImport(ctx, input), `Import a dump into ${input.domain}${input.path ?? ''}`, `${input.domain}${input.path ?? ''}`, {
      // The dump goes once it is in, or once the import is undone; a failed import keeps it for Retry.
      onDone: () => removeUpload(ctx.uploadsDir, input.uploadId),
      onUndone: () => removeUpload(ctx.uploadsDir, input.uploadId),
      upload: input.uploadId,
    }),
  'db.cleanCopy': async (ctx, input) =>
    startJob(ctx, planCleanCopy(ctx, input), `Prepare ${input.domain}${input.path ?? ''} from production`, `${input.domain}${input.path ?? ''}`, {
      // The dump goes once it is in, or once the job is undone; a failed job keeps it for Retry.
      onDone: () => removeUpload(ctx.uploadsDir, input.uploadId),
      onUndone: () => removeUpload(ctx.uploadsDir, input.uploadId),
      upload: input.uploadId,
    }),
  'db.cleanCurrent': async (ctx, input) => startJob(ctx, planCleanCurrent(ctx, input), `Clean the database of ${input.domain}${input.path ?? ''}`, `${input.domain}${input.path ?? ''}`),
  'db.exportClean': async (ctx, input) => startJob(ctx, planExportClean(ctx, input), `Export a clean copy of ${input.domain}${input.path ?? ''}`, `${input.domain}${input.path ?? ''}`),
  'db.deleteCleanCopy': async (ctx, input) => [deleteCleanCopy(ctx.config, input)],
  'db.restoreKept': async (ctx, input) => startJob(ctx, planRestoreKept(ctx, input), `Put back ${input.name} on ${input.domain}${input.path ?? ''}`, `${input.domain}${input.path ?? ''}`),
  'db.deleteKept': async (ctx, input) => [await deleteKept(ctx, input)],
  'db.searchReplace': async (ctx, input) =>
    startJob(ctx, planSearchReplace(ctx, input), `${input.dryRun ? 'Preview' : 'Run'} search and replace on ${input.domain}${input.path ?? ''}`, `${input.domain}${input.path ?? ''}`),
  'site.clearCache': clearCache,
  'site.flushRewrites': flushRewrites,
  'site.pluginSet': setPlugin,
  'site.setDebug': setDebug,
  'site.setConstant': setConstant,
  'site.shuffleSalts': shuffleSalts,
  'site.removeLegacySalts': removeLegacySalts,
  'site.clearDebugLog': clearDebugLog,
  'site.login': login,
  'site.openTerminal': async (ctx, { domain, path }) => [await openTerminal(ctx.exec, siteFor(ctx.config, domain, path).docroot)],
  'network.addAdmin': async (ctx, { domain, path, user }) =>
    startJob(ctx, planAddNetworkAdmin(ctx.exec, siteFor(ctx.config, domain, path), user), `Make ${user} administrator on every site of ${domain}${path ?? ''}`, `${domain}${path ?? ''}`),
  'core.switch': switchCore,
  'core.add': async (ctx, input) => startJob(ctx, await planAddCore(ctx, input), `Add WordPress ${input.version}`, `WordPress ${input.version}`),
  'core.remove': (ctx, input) => removeCore(ctx, input),
  'site.remove': async (ctx, input) => {
    const steps = [removeCronStep(ctx, input.domain), ...planRemove(ctx, input)];
    const view = ctx.jobs.start(steps, { runId: ctx.runId as number, title: `Remove ${input.domain}`, target: input.domain, kind: 'site.remove' });
    return { results: [{ code: 0, stdout: `started ${view.id}`, stderr: '' }], data: { jobId: view.id }, detached: true };
  },
  'site.create': async (ctx, input) => {
    const steps = await planCreate(ctx, input);
    const draft = input.draftId && ctx.drafts?.get(input.draftId) ? input.draftId : undefined;
    const view = ctx.jobs.start(steps, {
      runId: ctx.runId as number,
      title: `Create ${input.domain}${input.path ?? ''}`,
      target: `${input.domain}${input.path ?? ''}`,
      kind: 'site.create',
      limit: MAX_PARALLEL_INSTALLS,
      // A failed install keeps its dump for Retry; Undo, or the daily prune, removes it.
      ...(input.uploadId ? { upload: input.uploadId } : {}),
      onUndone: () => {
        if (input.uploadId) removeUpload(ctx.uploadsDir, input.uploadId);
        // Taken back: its draft opens again, to change it and run it once more.
        if (draft) ctx.drafts?.reopen(draft, 'open');
      },
      ...(draft ? { onFailed: () => ctx.drafts?.reopen(draft) } : {}),
      // The dump is no longer needed once the site is in place, nor the draft and
      // its files, and the wizard's answers are remembered for the next install of this repo.
      onDone: (job) => {
        if (input.uploadId) removeUpload(ctx.uploadsDir, input.uploadId);
        if (draft) ctx.drafts?.done(draft);
        // Steps skipped on the way stay on the site's page, with what is left to do.
        const skipped = job.steps.filter((s) => s.status === 'skipped').map((s) => ({ label: s.label, todo: s.skippable ?? '' }));
        ctx.store.setInstall(input.domain, input.path, {
          how: input.organization && input.repo ? 'organization' : input.source,
          at: new Date().toISOString(),
          ...(input.repo ? { repo: input.repo.url } : {}),
          ...(input.organization ? { org: input.organization } : {}),
          ...(skipped.length ? { skipped } : {}),
        });
        const key = input.repo ? repoKey(input.repo.url) : null;
        const preset = presetFromCreate(input);
        if (key && preset) ctx.store.savePreset(key, preset);
      },
    });
    if (draft) ctx.drafts?.installing(draft, view.id);
    return { results: [{ code: 0, stdout: `started ${view.id}`, stderr: '' }], data: { jobId: view.id }, detached: true };
  },
};

export class ActionInputError extends Error {}

/** Another job works on the action's site now; the route answers 409 with that job. */
export class ActionBusyError extends Error {
  constructor(message: string, readonly jobId?: string) {
    super(message);
  }
}

/** Actions that only read or hand out a login, so they may run while a job works on the site. */
const LOCK_FREE = new Set<ActionId>(['git.fetch', 'site.login']);

/**
 * What an action locks: its site (local.shop.com, or local.shop.com/learn
 * under a path), the domain of a Deleted sites entry, a core version, or a
 * database the MySQL actions change.
 */
export function lockKey(id: ActionId, input: unknown): string | undefined {
  if (LOCK_FREE.has(id)) return undefined;
  const { domain, path, id: entry, version, database } = input as { domain?: unknown; path?: unknown; id?: unknown; version?: unknown; database?: unknown };
  if (typeof domain === 'string') return `${domain}${typeof path === 'string' ? path : ''}`;
  // One change of the crontab at a time; a run and its history lock nothing.
  if (id.startsWith('cron.') && id !== 'cron.runNow' && id !== 'cron.clearRuns') return 'crontab';
  if (id.startsWith('mysql.') && typeof database === 'string') return `database ${database}`;
  if (id.startsWith('trash.') && typeof entry === 'string') return entry.replace(/-\d{8}-\d{6}$/, '');
  if (id.startsWith('core.') && typeof version === 'string') return `WordPress ${version}`;
  return undefined;
}

/** Inputs run history never keeps: passwords, and a row's values and key or SQL that writes (data from a database). */
const HIDDEN_INPUTS = new Set(['password', 'rowKey', 'rowKeys', 'rowValues', 'rowWas', 'sql']);

/** The input as run history keeps it: any field called password, or holding a row's data, is blanked out. */
export function withoutPasswords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPasswords);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, HIDDEN_INPUTS.has(k) ? '(hidden)' : withoutPasswords(v)]));
}

/**
 * Validates the input against the registry schema, runs the handler and
 * records the run. Input that fails validation never reaches a command.
 */
export async function runAction(ctx: ActionContext, id: ActionId, rawInput: unknown): Promise<ActionRunResult> {
  const parsed = actions[id].input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new ActionInputError(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  }
  // One thing at a time on a site: nothing touches it while a job works on it (an
  // install, a removal, a restore of its Deleted sites entry) or another action runs.
  // A site under a path meets its domain: local.northwind.com/learn and local.northwind.com.
  const key = lockKey(id, parsed.data);
  const busy = key ? ctx.jobs.busyFor(key) : undefined;
  if (busy) {
    throw new ActionBusyError(
      busy.kind === 'site.create' && busy.target === key ? `${key} is still being installed; wait until it finishes` : `${key} is busy: ${busy.title}. Wait until it finishes`,
      busy.jobId,
    );
  }
  // One update or switch at a time, and none while installs run: both restart the panel.
  const restarts = (kind?: string) => kind === 'panel.update' || kind === 'panel.switchRelease' || kind === 'panel.installRelease';
  // Any job: a restart would cut a clean-up, an import or an install off half way.
  const active = ctx.jobs.list().filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'undoing');
  if (restarts(id) && active.length > 0) {
    throw new ActionBusyError(`Wait for ${active.length === 1 ? `${active[0]?.title ?? 'the running job'} to finish` : `the ${active.length} running jobs to finish`}: this restarts the panel`, active[0]?.id);
  }
  // While install.sh swaps the root scripts nothing else may run them.
  if (actions[id].changesSystem && ctx.jobs.list().some((j) => j.kind === 'panel.installRelease' && (j.status === 'running' || j.status === 'queued'))) {
    throw new ActionBusyError('The panel is installing an update: wait until it finishes');
  }
  const runId = ctx.store.start(id, withoutPasswords(parsed.data));
  const handler = handlers[id] as Handler<ActionId>;
  // Held until the handler returns; a job it starts holds the key from then on.
  const release = key ? ctx.jobs.hold(key, actions[id].title) : () => {};
  let outcome: HandlerOutcome;
  try {
    const result = await handler({ ...ctx, runId, actionId: id }, parsed.data as ActionInput<ActionId>);
    outcome = Array.isArray(result) ? { results: result } : result;
  } catch (error) {
    if (error instanceof SiteNotFoundError || error instanceof SiteActionRefused || error instanceof DumpRefused || error instanceof TrashRefused || error instanceof CreateRefused || error instanceof RemoveRefused || error instanceof DbRefused || error instanceof CoreRefused || error instanceof MysqlRefused || error instanceof PhpSettingsRefused || error instanceof CronRefused) {
      ctx.store.finish(runId, 2, error.message);
      throw new ActionInputError(error.message);
    }
    outcome = { results: [{ code: 1, stdout: '', stderr: (error as Error).message }] };
  } finally {
    release();
  }
  const failed = outcome.results.find((r) => r.code !== 0);
  const exitCode = failed?.code ?? 0;
  const output = outcome.results.map((r) => [r.stdout, r.stderr].filter(Boolean).join('\n')).filter(Boolean).join('\n');
  // A detached action (a job) finishes its own run history row.
  // The login URL is a secret for 60 seconds; it goes to the browser, never into the run history.
  if (!outcome.detached) ctx.store.finish(runId, exitCode, output);
  return { runId, ok: exitCode === 0, exitCode, output, ...(exitCode === 0 && outcome.data ? { data: outcome.data } : {}) };
}
