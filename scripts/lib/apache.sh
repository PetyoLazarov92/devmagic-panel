# shellcheck shell=bash
# Apache control. Reloads always run a configtest first.

DMP_APACHE_MODULES=(ssl rewrite headers proxy proxy_http proxy_wstunnel)
# Modules apache-module never turns off: the panel's own (it runs behind
# Apache through them) and the ones every vhost needs. php* and mpm_* are
# never switched either way. Mirrored by APACHE_LOCKED_MODULES in
# shared/src/apache.ts; change both together.
DMP_APACHE_KEEP_ON=(ssl rewrite headers proxy proxy_http proxy_wstunnel socache_shmcb authz_core authz_host authn_core dir mime alias)

dmp_apache_configtest() {
  local out
  if out="$(apache2ctl configtest 2>&1)"; then
    dmp_ok "apache configtest passed"
    return 0
  fi
  dmp_error "apache configtest failed:"
  printf '%s\n' "$out" >&2
  return 1
}

dmp_apache_reload() {
  dmp_apache_configtest || dmp_die "not reloading apache, fix the config first"
  systemctl reload apache2 || dmp_die "apache reload failed"
  dmp_ok "apache reloaded"
}

# A full restart, for PHP extension changes that a graceful reload may not pick up.
dmp_apache_restart() {
  dmp_apache_configtest || dmp_die "not restarting apache, fix the config first"
  systemctl restart apache2 || dmp_die "apache restart failed"
  dmp_ok "apache restarted"
}

# service-restart <apache|mysql>: MySQL runs as mysql or mariadb, whichever unit exists.
dmp_service_restart() {
  case "$1" in
    apache) dmp_apache_restart ;;
    mysql)
      local unit
      for unit in mysql mariadb; do
        if systemctl cat "$unit.service" >/dev/null 2>&1; then
          systemctl restart "$unit" || dmp_die "$unit restart failed"
          dmp_ok "$unit restarted"
          return 0
        fi
      done
      dmp_die "no mysql or mariadb service found"
      ;;
    *) dmp_usage_error "service-restart takes apache or mysql" ;;
  esac
}

dmp_apache_module_enable() {
  local module="$1" m allowed=0
  for m in "${DMP_APACHE_MODULES[@]}"; do
    [[ "$m" == "$module" ]] && allowed=1
  done
  (( allowed )) || dmp_usage_error "module not allowed: $module (allowed: ${DMP_APACHE_MODULES[*]})"
  a2enmod -q "$module" >/dev/null || dmp_die "a2enmod $module failed"
  dmp_ok "apache module enabled: $module"
}

# apache-module <name> <on|off>: any module in mods-available on or off, but
# the locked ones. A configtest runs before and after; when the one after
# fails the change is taken back, so Apache never restarts on a broken config.
dmp_apache_module() {
  local name="$1" state="$2" mods out
  [[ "$name" =~ ^[a-z][a-z0-9_]{0,39}$ || "$name" =~ ^php[0-9]+\.[0-9]+$ ]] || dmp_usage_error "not an Apache module name: $name"
  dmp_in_list "$state" on off || dmp_usage_error "apache-module takes on or off, not: $state"
  [[ "$name" != php* && "$name" != mpm_* ]] || dmp_usage_error "$name runs your sites; the panel never switches it"
  if [[ "$state" == off ]] && dmp_in_list "$name" "${DMP_APACHE_KEEP_ON[@]}"; then
    dmp_usage_error "$name stays on: the panel or every vhost needs it"
  fi
  mods="$(dirname "$APACHE_SITES_AVAILABLE")"
  [[ -f "$mods/mods-available/$name.load" ]] || dmp_die "$name is not in mods-available"
  if [[ "$state" == on && -e "$mods/mods-enabled/$name.load" ]] || [[ "$state" == off && ! -e "$mods/mods-enabled/$name.load" ]]; then
    dmp_ok "apache module $name is already $state"
    return 0
  fi
  # Before anything changes: a config that fails already would hide what this change does.
  dmp_apache_configtest || dmp_die "not changing Apache modules, fix the Apache config first"
  if [[ "$state" == on ]]; then
    a2enmod -q "$name" >/dev/null || dmp_die "a2enmod $name failed"
  else
    a2dismod -q -f "$name" >/dev/null || dmp_die "a2dismod $name failed"
  fi
  if ! out="$(apache2ctl configtest 2>&1)"; then
    if [[ "$state" == on ]]; then a2dismod -q -f "$name" >/dev/null || true; else a2enmod -q "$name" >/dev/null || true; fi
    printf '%s\n' "$out" >&2
    dmp_die "turning $name $state breaks the Apache config, so it is $([[ "$state" == on ]] && echo off || echo on) again"
  fi
  dmp_apache_restart
  dmp_ok "apache module $name $state"
}
