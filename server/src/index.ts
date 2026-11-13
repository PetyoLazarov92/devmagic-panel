import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { DMP_ROOT, loadConfig, userPaths } from './config.js';
import { coreStatusSource } from './core-status.js';
import { defaultHostPaths } from './environment.js';
import { runCommand } from './exec.js';
import { RunningPrograms } from './running.js';
import { putBackBeforeExit, putBackLeftRaised } from './mysql-limits.js';
import { readSecrets, removeGithubToken } from './secrets.js';
import { RunStore } from './store.js';
import { readVersion } from './version.js';

const config = loadConfig();
const paths = userPaths();
const store = new RunStore(paths.databaseFile);
// Runs a previous panel was stopped in the middle of; jobs live in memory, so nothing can finish them now.
store.markInterrupted();
const production = process.env.NODE_ENV === 'production';
// Updates need no GitHub token since v0.7.0: one an older panel saved goes.
if (removeGithubToken(paths.secretsFile, join(paths.dataDir, 'github-token-removed'))) console.log('deleted the GitHub token an older panel saved; updates need none');

// Every program the panel runs is listed while it runs, for the status in the top bar.
const programs = new RunningPrograms();
const exec = programs.track(runCommand);
const app = await buildApp({
  config,
  exec,
  programs,
  store,
  secrets: () => readSecrets(paths.secretsFile),
  hostPaths: defaultHostPaths(homedir()),
  dmpRoot: process.env.DEVMAGIC_PANEL_DMP_ROOT ?? DMP_ROOT,
  version: readVersion(),
  production,
  webRoot: fileURLToPath(new URL('../../web/dist', import.meta.url)),
  uploadsDir: join(paths.dataDir, 'uploads'),
  coreStatus: coreStatusSource(join(paths.dataDir, 'wp-core-status.json')),
  secretsFile: paths.secretsFile,
  settingsFile: join(paths.configDir, 'settings.json'),
  checkUpdates: production,
  housekeeping: production,
  logger: true,
});

// MySQL limits a job raised before the panel last stopped go back to what they were.
const mysqlAccount = readSecrets(paths.secretsFile)?.mysql;
if (mysqlAccount) void putBackLeftRaised({ exec, mysql: mysqlAccount, memo: store }).catch(() => undefined);

const shutdown = async () => {
  await putBackBeforeExit().catch(() => undefined);
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Localhost only: Apache proxies https://PANEL_DOMAIN to this port.
await app.listen({ host: '127.0.0.1', port: config.PANEL_PORT });
