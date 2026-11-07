import type { MysqlSettingName, MysqlSettings } from '@devmagic-panel/shared';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** The mockup's MySQL 8: a small buffer pool for its sites, an import holding the packet limit raised, nothing kept yet. */
const values: Record<string, number> = {
  innodb_buffer_pool_size: 128 * MB,
  max_allowed_packet: GB,
  innodb_redo_log_capacity: 100 * MB,
  max_connections: 151,
  tmp_table_size: 16 * MB,
  innodb_flush_log_at_trx_commit: 1,
  slow_query_log: 0,
  long_query_time: 10,
};
const kept: Partial<Record<string, number>> = {};
const raised: Record<string, number> = { max_allowed_packet: 64 * MB };

export function mockMysqlSettings(): MysqlSettings {
  const suggested: Record<string, [number, string]> = {
    innodb_buffer_pool_size: [2 * GB, "Room for your sites' InnoDB data, up to half the memory"],
    innodb_redo_log_capacity: [GB, 'Big imports go faster'],
    innodb_flush_log_at_trx_commit: [2, 'Much faster imports on a computer for local work'],
  };
  return {
    product: 'MySQL',
    file: '/etc/mysql/mysql.conf.d/zz-devmagic-panel.cnf',
    settings: Object.entries(values).map(([name, value]) => {
      const s = suggested[name];
      return {
        name: name as MysqlSettingName,
        value,
        ...(kept[name] !== undefined ? { kept: kept[name] } : {}),
        ...(raised[name] !== undefined ? { raisedFrom: raised[name] } : {}),
        ...(s && value < s[0] ? { suggested: s[0], why: s[1] } : {}),
      };
    }),
  };
}

/** A settings job as the panel runs it: applied now, and kept for the next start (null takes one out of the file). */
export function mockApplyMysqlSettings(changes: Record<string, number | null>): void {
  for (const [name, value] of Object.entries(changes)) {
    if (name === 'max_heap_table_size') continue;
    delete raised[name];
    if (value === null) delete kept[name];
    else {
      values[name] = value;
      kept[name] = value;
    }
  }
}
