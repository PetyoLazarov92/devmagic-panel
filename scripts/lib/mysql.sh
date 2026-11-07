# shellcheck shell=bash
# The panel's own MySQL (or MariaDB) settings: one marked file, read last, so
# what the MySQL page keeps survives a restart. Only allow-listed names with
# numbers inside bounds go in: never text, so nothing like init_file or
# plugin_load can be set through it. The panel applies the values with
# SET GLOBAL itself; this only keeps them.

DMP_MYSQL_CNF_NAME="zz-devmagic-panel.cnf"

# name min max: whole numbers (bytes for the sizes).
DMP_MYSQL_SETTINGS=(
  "innodb_buffer_pool_size 134217728 68719476736"
  "max_allowed_packet 1048576 1073741824"
  "innodb_redo_log_capacity 8388608 17179869184"
  "innodb_log_file_size 4194304 8589934592"
  "max_connections 10 2000"
  "tmp_table_size 1048576 4294967296"
  "max_heap_table_size 1048576 4294967296"
  "innodb_flush_log_at_trx_commit 1 2"
  "slow_query_log 0 1"
  "long_query_time 0 60"
)

# The folder MySQL reads last: MariaDB's mariadb.conf.d when there is one, MySQL's mysql.conf.d otherwise.
dmp_mysql_conf_dir() {
  if [[ -d "$MYSQL_CONF_DIR/mariadb.conf.d" ]]; then
    printf '%s' "$MYSQL_CONF_DIR/mariadb.conf.d"
  elif [[ -d "$MYSQL_CONF_DIR/mysql.conf.d" ]]; then
    printf '%s' "$MYSQL_CONF_DIR/mysql.conf.d"
  else
    return 1
  fi
}

# One name=value checked against the list; prints "name = value".
dmp_mysql_setting_line() {
  local pair="$1" name value entry n min max
  [[ "$pair" =~ ^([a-z_]{1,64})=(.{1,32})$ ]] || dmp_usage_error "a MySQL setting is name=value, not: $pair"
  name="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"
  for entry in "${DMP_MYSQL_SETTINGS[@]}"; do
    read -r n min max <<<"$entry"
    [[ "$n" == "$name" ]] || continue
    if [[ "$name" == long_query_time ]]; then
      [[ "$value" =~ ^([0-9]{1,2})(\.[0-9]{1,3})?$ ]] || dmp_usage_error "long_query_time is seconds like 2 or 0.5, not: $value"
      (( 10#${BASH_REMATCH[1]} <= max )) || dmp_usage_error "long_query_time is $max seconds at most"
    else
      [[ "$value" =~ ^[0-9]{1,12}$ ]] || dmp_usage_error "$name takes a whole number, not: $value"
      (( 10#$value >= min && 10#$value <= max )) || dmp_usage_error "$name must be between $min and $max"
      value="$((10#$value))"
    fi
    printf '%s = %s\n' "$name" "$value"
    return 0
  done
  dmp_usage_error "not a setting the panel keeps: $name"
}

# mysql-config-write [name=value...]: the panel's file with exactly these
# settings, in the list's order; none removes the file. MySQL reads it at its
# next start.
dmp_mysql_config_write() {
  local dir pair line name entry n body="" tmp
  local -A lines=()
  for pair in "$@"; do
    line="$(dmp_mysql_setting_line "$pair")" || exit 2
    name="${line%% = *}"
    [[ -z "${lines[$name]:-}" ]] || dmp_usage_error "$name is given twice"
    lines[$name]="$line"
  done
  dir="$(dmp_mysql_conf_dir)" || dmp_die "no mysql.conf.d or mariadb.conf.d in $MYSQL_CONF_DIR"
  if (( ${#lines[@]} == 0 )); then
    rm -f "${dir:?}/$DMP_MYSQL_CNF_NAME"
    dmp_ok "the panel's MySQL settings removed: MySQL's own apply from its next start"
    return 0
  fi
  for entry in "${DMP_MYSQL_SETTINGS[@]}"; do
    n="${entry%% *}"
    [[ -n "${lines[$n]:-}" ]] && body+="${lines[$n]}"$'\n'
  done
  tmp="$(mktemp "$dir/.dmp-cnf.XXXXXX")"
  printf '# Managed by devmagic-panel (the MySQL page). Edits here are overwritten.\n[mysqld]\n%s' "$body" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$dir/$DMP_MYSQL_CNF_NAME"
  dmp_ok "MySQL settings kept in $dir/$DMP_MYSQL_CNF_NAME: $(printf '%s' "$body" | tr '\n' ',' | sed 's/,$//; s/,/, /g')"
}
