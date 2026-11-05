import type { Executor } from './exec.js';
import type { MysqlAccount } from './mysql-limits.js';

const known = new WeakMap<Executor, boolean>();

/**
 * MySQL 8 keeps the table sizes and row counts information_schema shows for
 * information_schema_stats_expiry seconds (a day by default), so a size read
 * after a big change, like cleared logs, can still show the old one. This is
 * the statement that asks for them fresh, to put before a query in the same
 * session, or nothing on MariaDB, which has no such cache and no such
 * variable. The server is asked once per executor, so once per panel start.
 */
export async function freshStatsSql(exec: Executor, mysql: MysqlAccount): Promise<string> {
  let has = known.get(exec);
  if (has === undefined) {
    const r = await exec('mysql', ['--batch', '--skip-column-names', '--user', mysql.user, '--host', mysql.host, '-e', "SHOW VARIABLES LIKE 'information_schema_stats_expiry'"], {
      env: { MYSQL_PWD: mysql.password },
    });
    // A server that does not answer is asked again next time.
    if (r.code !== 0) return '';
    has = r.stdout.trim() !== '';
    known.set(exec, has);
  }
  return has ? 'SET SESSION information_schema_stats_expiry = 0; ' : '';
}
