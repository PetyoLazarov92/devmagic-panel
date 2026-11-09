import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { DMP_ROOT, loadConfig, userPaths } from './config.js';
import { coreStatusSource } from './core-status.js';
import { defaultHostPaths } from './environment.js';
import { runCommand } from './exec.js';
import { putBackBeforeExit, putBackLeftRaised } from './mysql-limits.js';
import { readSecrets, removeGithubToken } from './secrets.js';
import { listTrash, purgeTrash, sweepArchives } from './sites/trash.js';
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

const app = await buildApp({
  config,
  exec: runCommand,
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
if (mysqlAccount) void putBackLeftRaised({ exec: runCommand, mysql: mysqlAccount, memo: store }).catch(() => undefined);

const shutdown = async () => {
  await putBackBeforeExit().catch(() => undefined);
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Deleted sites older than TRASH_DAYS go for good: now, and every six hours.
// The panel's records of the archives that went go with them.
const dmpRootBin = process.env.DEVMAGIC_PANEL_DMP_ROOT ?? DMP_ROOT;
const purge = () =>
  void purgeTrash(runCommand, dmpRootBin)
    .then(async (r) => {
      if (r.code !== 0) return app.log.warn(`trash purge: ${r.stderr.trim()}`);
      sweepArchives(store, await listTrash(runCommand, dmpRootBin));
    })
    .catch((error: Error) => app.log.warn(`trash purge: ${error.message}`));
purge();
setInterval(purge, 6 * 60 * 60_000).unref();

// Localhost only: Apache proxies https://PANEL_DOMAIN to this port.
await app.listen({ host: '127.0.0.1', port: config.PANEL_PORT });
