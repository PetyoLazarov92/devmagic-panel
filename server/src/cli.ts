#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { homedir, setPriority, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { PANEL_PASSWORD_MIN, panelPasswordProblem } from '@devmagic-panel/shared';
import { startEnabled, writeAutostart } from './autostart.js';
import { loadConfig, userPaths } from './config.js';
import { cronLockDir, cronLogFile } from './cron.js';
import { runCronTask, runnerPath } from './cron-run.js';
import { pingMysql } from './environment.js';
import { runCommand } from './exec.js';
import { planInstallMailpit } from './mailpit.js';
import { runMcpStdio } from './mcp.js';
import { createPanelAccount, createReadOnlyAccount, PANEL_MYSQL_USER, READ_ONLY_MYSQL_USER } from './mysql-admin.js';
import { hashPassword, readSecrets, writeSecrets, type Secrets } from './secrets.js';
import { RunStore } from './store.js';
import { panelCli } from './update.js';
import { readVersion } from './version.js';

/**
 * devmagic-panel CLI, run by install.sh:
 *   setup         set the panel password and the MySQL admin account
 *   set-password  change the panel password only
 *   install-mailpit  install Mailpit as on the Services page
 *   autostart     start the panel and Mailpit after login, for an encrypted home
 *   write-autostart  write the desktop entry that runs autostart
 *   mcp           the MCP server on stdio, for Claude Code and Claude Desktop
 */

/** Reads a line without echoing it. */
async function askHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(question);
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, terminal: false });
    const line = await new Promise<string>((resolve) => rl.once('line', resolve));
    rl.close();
    return line;
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('cancelled'));
          return;
        }
        value = ch === '\u007f' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function ask(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
  rl.close();
  return answer || fallback;
}

/** A new panel password, by the same rules as the panel's own form. */
async function askNewPassword(): Promise<string> {
  for (;;) {
    const first = await askHidden(`Panel password (at least ${PANEL_PASSWORD_MIN} characters): `);
    const problem = panelPasswordProblem(first, userInfo().username);
    if (problem) {
      console.log(`${problem}. Try again.`);
      continue;
    }
    if ((await askHidden('Repeat it: ')) === first) return first;
    console.log('They do not match, try again.');
  }
}

async function askMysql(current: Secrets['mysql']): Promise<Secrets['mysql']> {
  console.log('\nMySQL admin account: the panel uses it only to create and drop site databases and users.');
  // A saved account that still signs in is kept with Enter, like the panel password, instead of typing its password again.
  if (current) {
    const saved = await pingMysql(runCommand, current);
    if (saved.code === 0) {
      if ((await ask(`The saved account, ${current.user}@${current.host}, signs in. Keep it?`, 'y')).toLowerCase() === 'y') return current;
    } else {
      console.log(`The saved account, ${current.user}@${current.host}, does not sign in: ${(saved.stderr || saved.stdout).trim().split('\n')[0] ?? ''}`);
    }
  }
  for (;;) {
    const user = await ask('MySQL admin user', current?.user ?? 'root');
    const host = await ask('MySQL host', current?.host ?? 'localhost');
    const password = await askHidden('MySQL password (hidden): ');
    const ping = await pingMysql(runCommand, { user, host, password });
    if (ping.code === 0) {
      console.log('Connected.');
      return { user, host, password };
    }
    console.log(`Could not connect: ${(ping.stderr || ping.stdout).trim().split('\n')[0] ?? ''}`);
    console.log(`On a new MySQL or MariaDB, root signs in only through sudo: c makes an account for the panel, ${PANEL_MYSQL_USER}, with sudo mysql.`);
    const next = (await ask('Try again (t), create the account (c), or go on without one for now (s)?', 't')).toLowerCase();
    if (next.startsWith('s')) return current;
    if (next.startsWith('c')) {
      console.log('Running sudo mysql (sudo may ask for your password)...');
      const made = await createPanelAccount(runCommand);
      if ('account' in made) {
        console.log(`Created ${PANEL_MYSQL_USER}@localhost and connected. Its password is only in the panel's secrets file.`);
        return made.account;
      }
      console.log(`Could not create it: ${made.problem}`);
    }
  }
}

/** Mailpit the way the Services page installs it, for install.sh: each step in order, stopping at the first failure. */
async function installMailpit(dataDir: string): Promise<boolean> {
  for (const step of planInstallMailpit({ exec: runCommand, dataDir, home: homedir() })) {
    console.log(`   ${step.label}`);
    const results = [await step.run({ onUndo: () => undefined, progress: () => undefined })].flat();
    const failed = results.find((r) => r.code !== 0);
    if (failed) {
      console.error(`   ${(failed.stderr || failed.stdout).trim().split('\n')[0] ?? 'failed'}`);
      return false;
    }
  }
  return true;
}

/** One run of a cron task, as cron starts it. */
async function cronRun(dataDir: string, args: string[]): Promise<void> {
  try {
    process.env.PATH = runnerPath(homedir());
    // Below the panel and the sites you are looking at.
    setPriority(10);
    const store = new RunStore(userPaths().databaseFile);
    try {
      await runCronTask({ config: loadConfig(), exec: runCommand, store, lockDir: cronLockDir(dataDir), home: homedir() }, args, 'cron');
    } finally {
      store.close();
    }
  } catch (error) {
    try {
      appendFileSync(cronLogFile(dataDir), `${new Date().toISOString()} cron-run ${args.join(' ')}: ${(error as Error).message}\n`, { mode: 0o600 });
    } catch {
      // nowhere left to say it
    }
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  // stdout belongs to the MCP protocol here: nothing else may write to it.
  if (command === 'mcp') {
    await runMcpStdio(readVersion());
    return;
  }
  // From the desktop's autostart entry, after login: the encrypted home is unlocked now.
  if (command === 'autostart') {
    const failed = (await startEnabled(runCommand)).filter((r) => r.code !== 0);
    for (const r of failed) console.error((r.stderr || r.stdout).trim().split('\n')[0] ?? 'failed');
    process.exitCode = failed.length ? 1 : 0;
    return;
  }
  const { secretsFile, dataDir } = userPaths();

  // From cron, for a task of the panel: prints nothing, so cron mails nothing; its own failures go to cron.log.
  if (command === 'cron-run') {
    await cronRun(dataDir, process.argv.slice(3));
    return;
  }

  const current = readSecrets(secretsFile);

  if (command === 'setup') {
    const keep = current?.panelPasswordHash
      ? (await ask('A panel password is already set. Keep it?', 'y')).toLowerCase() === 'y'
      : false;
    const panelPasswordHash = keep && current ? current.panelPasswordHash : await hashPassword(await askNewPassword());
    const changedAt = keep && current ? current.panelPasswordChangedAt : new Date().toISOString();
    const mysql = await askMysql(current?.mysql);
    // Keep what setup does not ask about, like a saved Anthropic key; a GitHub token an older panel saved goes.
    const { mysql: _old, github: _token, ...rest } = (current ?? {}) as Partial<Secrets> & { github?: unknown };
    // The SQL runner's read-only account, made with the admin account; kept when it still signs in.
    let readOnly = rest.mysqlReadOnly;
    if (mysql && !(readOnly && (await pingMysql(runCommand, readOnly)).code === 0)) {
      const made = await createReadOnlyAccount(runCommand, mysql);
      if ('account' in made) {
        readOnly = made.account;
        console.log(`Made ${READ_ONLY_MYSQL_USER}@localhost, the read-only account the SQL runner uses.`);
      } else {
        readOnly = undefined;
        console.log(`Could not make the read-only MySQL account (${made.problem}); the Environment page offers it again.`);
      }
    }
    const { mysqlReadOnly: _ro, ...others } = rest;
    writeSecrets(secretsFile, { ...others, panelPasswordHash, ...(changedAt ? { panelPasswordChangedAt: changedAt } : {}), ...(mysql ? { mysql } : {}), ...(mysql && readOnly ? { mysqlReadOnly: readOnly } : {}) });
    console.log(`Saved to ${secretsFile} (readable only by you).`);
    return;
  }

  if (command === 'set-password') {
    // Every browser signed in with the old password is signed out by the new one.
    const panelPasswordHash = await hashPassword(await askNewPassword());
    writeSecrets(secretsFile, { ...current, panelPasswordHash, panelPasswordChangedAt: new Date().toISOString() });
    console.log('Panel password changed. Every browser signed in to the panel is signed out.');
    return;
  }

  if (command === 'write-autostart') {
    // This file is <app>/server/dist/cli.js; the entry runs it through current.
    const appDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    console.log(`Wrote ${writeAutostart(homedir(), process.execPath, panelCli({ appDir, dataDir }))}`);
    return;
  }

  if (command === 'install-mailpit') {
    process.exitCode = (await installMailpit(dataDir)) ? 0 : 1;
    return;
  }

  console.log('Usage: devmagic-panel <setup|set-password|install-mailpit|autostart|write-autostart|mcp|cron-run>');
  process.exitCode = command ? 2 : 0;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
