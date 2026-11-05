import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SystemConfig } from '../src/config.js';
import type { HostPaths } from '../src/environment.js';
import type { ExecResult, Executor } from '../src/exec.js';

export interface FakeCall {
  file: string;
  args: string[];
  env?: Record<string, string | undefined>;
  input?: string;
  /** What an inputStream carried, read to its end as the program would. */
  inputText?: string;
  inputStallMs?: number;
  maxBufferBytes?: number;
  /** Started detached, like a terminal window, in this folder. */
  detach?: { cwd?: string };
}

/**
 * A fake executor: answers by the first matching prefix of "file arg arg",
 * records every call, and answers unknown commands with exit 127.
 */
export type FakeResponse = Partial<ExecResult> | ((call: FakeCall) => Partial<ExecResult> | Promise<Partial<ExecResult>>);

export function fakeExec(responses: Record<string, FakeResponse> = {}) {
  const calls: FakeCall[] = [];
  const exec: Executor = async (file, args, options) => {
    let inputText: string | undefined;
    if (options?.inputStream) {
      // Read like the real executor: a broken stream stops the program.
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of options.inputStream) chunks.push(Buffer.from(chunk as Buffer));
        inputText = Buffer.concat(chunks).toString('utf8');
      } catch (error) {
        return { code: 1, stdout: '', stderr: `could not read the input: ${(error as Error).message}` };
      }
    }
    calls.push({
      file,
      args: [...args],
      ...(options?.env ? { env: options.env } : {}),
      ...(options?.input !== undefined ? { input: options.input } : {}),
      ...(inputText !== undefined ? { inputText } : {}),
      ...(options?.inputStallMs ? { inputStallMs: options.inputStallMs } : {}),
      ...(options?.maxBufferBytes ? { maxBufferBytes: options.maxBufferBytes } : {}),
      ...(options?.detach ? { detach: options.cwd ? { cwd: options.cwd } : {} } : {}),
    });
    const line = [file, ...args].join(' ');
    const key = Object.keys(responses)
      .filter((k) => line === k || line.startsWith(`${k} `))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return { code: 127, stdout: '', stderr: `not faked: ${line}` };
    const response = responses[key];
    const answer = typeof response === 'function' ? response(calls.at(-1) as FakeCall) : response;
    // A response may wait, like a long import a test holds open.
    const result = { code: 0, stdout: '', stderr: '', ...(await answer) };
    // Output that streams goes into the stream, as a real program's would, and not into the result.
    if (options?.stdoutTo) {
      const into = options.stdoutTo;
      await new Promise<void>((resolve) => into.end(result.stdout, () => resolve()));
      return { ...result, stdout: '' };
    }
    // Stdout arrives in small chunks, cut anywhere, as a real program's does.
    if (options?.onStdout) for (let i = 0; i < result.stdout.length; i += 37) options.onStdout(result.stdout.slice(i, i + 37));
    return result;
  };
  return { exec, calls };
}

/** A throwaway filesystem tree with the layout config.env points at. */
export function tempTree() {
  const root = mkdtempSync(join(tmpdir(), 'dmp-test-'));
  const dirs = ['sites-available', 'sites-enabled', 'mods-enabled', 'certs/devmagic-panel-ca', 'system-ca', 'www', 'home/.pki/nssdb', 'log'];
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'hosts'), '127.0.0.1 localhost\n');

  const config: SystemConfig = {
    PANEL_USER: 'dev',
    PANEL_GROUP: 'dev',
    PANEL_PORT: 4710,
    PANEL_DOMAIN: 'local.devmagic',
    WEB_DIR: join(root, 'www'),
    WEB_GROUP: 'www-data',
    CERTS_DIR: join(root, 'certs'),
    CA_DIR: join(root, 'certs/devmagic-panel-ca'),
    APACHE_SITES_AVAILABLE: join(root, 'sites-available'),
    APACHE_SITES_ENABLED: join(root, 'sites-enabled'),
    APACHE_LOG_DIR: join(root, 'log'),
    HOSTS_FILE: join(root, 'hosts'),
    SYSTEM_CA_DIR: join(root, 'system-ca'),
    BACKUP_DIR: join(root, 'backups'),
    PHP_CONF_DIR: join(root, 'php'),
    PHP_LIB_DIR: join(root, 'php-lib'),
    STATE_DIR: join(root, 'state'),
  };
  const hostPaths: HostPaths = {
    home: join(root, 'home'),
    systemCaBundle: join(root, 'system-ca/bundle.crt'),
    wpcoreConf: join(root, 'wpcore.conf'),
    phpMyAdminDirs: [join(root, 'phpmyadmin')],
    modsEnabled: join(root, 'mods-enabled'),
    searchPath: '',
    mounts: join(root, 'mounts'),
  };
  const write = (path: string, text = '') => writeFileSync(join(root, path), text);
  return { root, config, hostPaths, write };
}

export const DMP = '/usr/local/lib/devmagic-panel/bin/dmp-root';

/** Responses for a machine where every check passes. */
export function healthyResponses(): Record<string, Partial<ExecResult>> {
  return {
    'systemctl is-active apache2': { stdout: 'active\n' },
    [`sudo -n ${DMP} apache-configtest`]: { stdout: 'ok: apache configtest passed\n' },
    'ss -ltnH': { stdout: 'LISTEN 0 511 *:80 *:*\nLISTEN 0 511 *:443 *:*\n' },
    'mysql --user': { stdout: '1\n' },
    'php -r': { stdout: '8.3.6' },
    'php -m': { stdout: '[PHP Modules]\ncurl\ngd\nimagick\nintl\nmbstring\nmysqli\nxml\nzip\nxdebug\n' },
    'wp --version': { stdout: 'WP-CLI 2.11.0\n' },
    'git --version': { stdout: 'git version 2.43.0\n' },
    'unzip -v': { stdout: 'UnZip 6.00 of 20 April 2009, by Debian. Original by Info-ZIP.\n' },
    'composer --version': { stdout: 'Composer version 2.7.1 2024-02-09 15:26:28\n' },
    'openssl verify': { stdout: 'ca.pem: OK\n' },
    'certutil -L': { stdout: 'devmagic-panel Local CA\n' },
    [`sudo -n -l ${DMP}`]: { stdout: DMP },
    'ssh -T': { code: 1, stderr: "Hi dev! You've successfully authenticated, but GitHub does not provide shell access.\n" },
    'gh api user --jq .login': { stdout: 'alex-morgan\n' },
    'rclone listremotes --long': { stdout: 'gdrive:  drive\n' },
  };
}

/**
 * A temp tree with one WordPress site, local.shop.com, on a shared core
 * (7.1.3 linked, 6.8.3 also installed) with an enabled vhost.
 */
export function wpSiteTree(options: { multisite?: boolean; ownCore?: boolean } = {}) {
  const tree = tempTree();
  const { root, config } = tree;
  const docroot = join(config.WEB_DIR, 'local.shop.com');
  mkdirSync(join(docroot, 'wp-content'), { recursive: true });
  mkdirSync(join(root, 'wp-cores/7.1.3/wp-includes'), { recursive: true });
  mkdirSync(join(root, 'wp-cores/6.8.3'), { recursive: true });
  if (options.ownCore) {
    mkdirSync(join(docroot, 'wp-includes'));
    writeFileSync(join(docroot, 'wp-includes/version.php'), "<?php $wp_version = '6.8.1';");
  } else {
    symlinkSync(join(root, 'wp-cores/7.1.3/wp-includes'), join(docroot, 'wp-includes'));
  }
  writeFileSync(join(root, 'wpcore.conf'), `CORES_DIR="${join(root, 'wp-cores')}"\n`);
  writeFileSync(
    join(docroot, 'wp-config.php'),
    `<?php\ndefine('DB_NAME', 'shop_com');\n$table_prefix = 'wp_';\ndefine('WP_DEBUG', true);\n${options.multisite ? "define('MULTISITE', true);\n" : ''}`,
  );
  const cert = join(config.CERTS_DIR, 'local.shop.com/local.shop.com.crt');
  writeFileSync(
    join(config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf'),
    `<VirtualHost *:443>\n ServerName local.shop.com\n ServerAlias local.shop.de www.local.shop.com\n DocumentRoot ${docroot}\n SSLCertificateFile ${cert}\n</VirtualHost>\n`,
  );
  symlinkSync(join(config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf'), join(config.APACHE_SITES_ENABLED, 'local.shop.com-ssl.conf'));
  return { ...tree, docroot, cert, wpcoreConf: join(root, 'wpcore.conf') };
}

/** Debug constants of a site whose wp-config.php sets none of them. */
export const NO_DEBUG_CONSTANTS = { WP_DEBUG: null, WP_DEBUG_LOG: null, WP_DEBUG_DISPLAY: null, SCRIPT_DEBUG: null, SAVEQUERIES: null };

/**
 * A MySQL server for the panel's admin account: databases of tables, each
 * table marked with where it came from, changed by the statements the panel
 * sends (DROP and CREATE DATABASE, RENAME TABLE, all or nothing) and by
 * imports, which make the tables a dump creates.
 */
/**
 * A MySQL server for swap and cleanup tests. admins: the logins the check
 * for a user to keep finds as administrators (admin by default); members:
 * logins it finds that are not.
 */
export function fakeMysql(start: Record<string, Record<string, string>>, options: { triggers?: number; views?: number; generated?: number; failImport?: boolean; failRename?: boolean; admins?: string[]; members?: string[] } = {}) {
  const statements: string[] = [];
  const dbs = new Map(Object.entries(start).map(([db, tables]) => [db, new Map(Object.entries(tables))]));
  const run = (call: FakeCall): { code?: number; stdout?: string; stderr?: string } => {
    const e = call.args.indexOf('-e');
    if (e !== -1) {
      // MySQL 8's cached table stats: the panel asks for them fresh first.
      if (call.args[e + 1] === "SHOW VARIABLES LIKE 'information_schema_stats_expiry'") return { stdout: 'information_schema_stats_expiry\t86400\n' };
      const sql = (call.args[e + 1] as string).replace(/^SET SESSION information_schema_stats_expiry = 0; /, '');
      const db = /'([^']+)'/.exec(sql)?.[1] ?? '';
      // Clean this database's check: tables, views, triggers, generated columns, size, datadir.
      if (sql.includes("EXTRA LIKE '%STORED GENERATED%'")) {
        const size = dbs.get(db)?.size ?? 0;
        return { stdout: `${size}\t${options.views ?? 0}\t${options.triggers ?? 0}\t${options.generated ?? 0}\t${size * 1024 ** 2}\t\n` };
      }
      if (sql.startsWith('SELECT u.user_login')) return { stdout: (options.admins ?? ['admin']).map((a) => `${a}\n`).join('') };
      if (sql.startsWith('SELECT meta_value FROM')) return { stdout: `a:${(options.admins ?? ['admin']).length}:{${(options.admins ?? ['admin']).map((a, i) => `i:${i};s:${a.length}:"${a}";`).join('')}}\n` };
      if (sql.startsWith('SELECT (SELECT COUNT(*)')) return { stdout: `${dbs.get(db)?.size ?? 0}\t0\t${options.triggers ?? 0}\t\n` };
      if (sql.startsWith('SELECT DEFAULT_CHARACTER_SET_NAME')) return { stdout: 'utf8mb4\tutf8mb4_unicode_ci\n' };
      if (sql.startsWith('SELECT TABLE_NAME, TABLE_TYPE')) return { stdout: [...(dbs.get(db)?.keys() ?? [])].map((t) => `${t}\tBASE TABLE\n`).join('') };
      if (sql.startsWith('SELECT @@SESSION.sql_mode')) return { stdout: 'NO_ENGINE_SUBSTITUTION\n' };
      if (sql.startsWith('SELECT s.SCHEMA_NAME')) {
        const asked = [...sql.matchAll(/'(\w+)'/g)].map((x) => x[1] as string);
        return { stdout: asked.filter((name) => dbs.has(name)).map((name) => `${name}\t${(dbs.get(name)?.size ?? 0) * 1024 ** 2}\n`).join('') };
      }
      if (sql.startsWith('SELECT TABLE_NAME, COALESCE(TABLE_ROWS')) return { stdout: [...(dbs.get(db)?.keys() ?? [])].map((t) => `${t}\t100\t${1024 ** 2}\n`).join('') };
      if (sql.startsWith('SELECT u.ID')) {
        const login = /u\.user_login = '([^']+)'/.exec(sql)?.[1] ?? '';
        if ((options.admins ?? ['admin']).includes(login)) return { stdout: '7\t1\n' };
        return { stdout: (options.members ?? []).includes(login) ? '8\t0\n' : '' };
      }
      return { code: 1, stderr: `not faked: ${sql}` };
    }
    if (call.args.includes('--max-allowed-packet=1G')) {
      const db = call.args.at(-1) as string;
      if (options.failImport) return { code: 1, stderr: "ERROR 1064 (42000) at line 9: You have an error in your SQL syntax" };
      for (const m of (call.inputText ?? '').matchAll(/^CREATE TABLE `(\w+)`/gm)) dbs.get(db)?.set(m[1] as string, 'dump');
      return { stdout: '' };
    }
    const database = call.args.at(-1) as string;
    const answers: string[] = [];
    for (const statement of (call.input ?? '').split('\n').filter(Boolean)) {
      let m: RegExpExecArray | null;
      statements.push(statement);
      // A cleanup: TRUNCATE empties the table; other changes are only recorded; a report line answers with a count.
      if ((m = /^TRUNCATE TABLE `(\w+)`;$/.exec(statement))) {
        if (dbs.get(database)?.has(m[1] as string)) dbs.get(database)?.set(m[1] as string, 'emptied');
        continue;
      }
      if ((m = /^SELECT '([^']+)', (\w+|ROW_COUNT\(\)), '(about|exact)';$/.exec(statement))) {
        answers.push(`${m[1]}\t${m[2] === 'ROW_COUNT()' ? 7 : m[2]}\t${m[3]}`);
        continue;
      }
      // Clean this database's copy: the side database gets the table as it is.
      if ((m = /^CREATE TABLE `(\w+)`\.`(\w+)` LIKE `(\w+)`\.`(\w+)`;$/.exec(statement))) {
        const origin = dbs.get(m[3] as string)?.get(m[4] as string);
        if (origin === undefined || !dbs.has(m[1] as string)) return { code: 1, stderr: `ERROR 1146: Table '${m[3]}.${m[4]}' doesn't exist` };
        dbs.get(m[1] as string)?.set(m[2] as string, origin);
        continue;
      }
      // A kept user put back into an emptied users table.
      if ((m = /^INSERT INTO `(\w+)` SELECT \* FROM dmp_keep_/.exec(statement))) {
        if (dbs.get(database)?.has(m[1] as string)) dbs.get(database)?.set(m[1] as string, 'kept one');
        continue;
      }
      if (/^(SET|DELETE|UPDATE|INSERT|PREPARE|EXECUTE|DEALLOCATE) |^CREATE TEMPORARY TABLE |^SELECT .* INTO @/.test(statement)) continue;
      if ((m = /^DROP DATABASE (?:IF EXISTS )?`(\w+)`;$/.exec(statement))) dbs.delete(m[1] as string);
      else if ((m = /^CREATE DATABASE `(\w+)`/.exec(statement))) dbs.set(m[1] as string, new Map());
      else if (statement.startsWith('RENAME TABLE ')) {
        if (options.failRename) return { code: 1, stderr: "ERROR 1435 (HY000): Trigger in wrong schema" };
        const moves = [...statement.matchAll(/`(\w+)`\.`(\w+)` TO `(\w+)`\.`\w+`/g)].map((x) => [x[1], x[2], x[3]] as [string, string, string]);
        // All or nothing, in order: a later move may use a name an earlier one freed.
        const next = new Map([...dbs].map(([k, v]) => [k, new Map(v)]));
        for (const [from, table, to] of moves) {
          const origin = next.get(from)?.get(table);
          if (origin === undefined || !next.has(to) || next.get(to)?.has(table)) return { code: 1, stderr: `ERROR 1050: cannot move ${from}.${table} to ${to}` };
          next.get(from)?.delete(table);
          next.get(to)?.set(table, origin);
        }
        dbs.clear();
        for (const [k, v] of next) dbs.set(k, v);
      } else return { code: 1, stderr: `not faked: ${statement}` };
    }
    return { stdout: answers.map((a) => `${a}\n`).join('') };
  };
  const state = () => Object.fromEntries([...dbs].map(([db, tables]) => [db, Object.fromEntries([...tables].sort())]));
  return { run, state, statements };
}
