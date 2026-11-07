# shellcheck shell=bash
# PHP per version: Xdebug on or off for its web part (Apache's mod_php and
# PHP-FPM; the CLI keeps its own settings), the other installed modules on or
# off for every part of the version together, and the panel's own ini file
# with the settings it manages. A command without a version works on the one
# Apache's mod_php loads, as before versions were picked.

DMP_XDEBUG_MODES=(debug develop profile trace coverage)
DMP_XDEBUG_STARTS=(trigger yes)
DMP_XDEBUG_INI_NAME="99-devmagic-panel-xdebug.ini"
# Modules WordPress cannot run without: never switched off. Same list as PHP_REQUIRED_MODULES in shared/src/actions.ts.
DMP_PHP_REQUIRED=(mysqli mysqlnd pdo xml)
DMP_PHP_INI_NAME="99-devmagic-panel.ini"
# The settings the panel writes, name:kind. Same list as PHP_INI_SETTINGS in shared/src/php.ts.
# size: 512M; size-: a size or -1; int: a whole number; flag: On or Off;
# choice: one of DMP_PHP_ERROR_REPORTING; timezone: Area/City or UTC.
DMP_PHP_INI_SETTINGS=(
  memory_limit:size- upload_max_filesize:size post_max_size:size max_execution_time:int
  max_input_time:int max_input_vars:int max_file_uploads:int default_socket_timeout:int
  display_errors:flag display_startup_errors:flag log_errors:flag html_errors:flag error_reporting:choice
  opcache.enable:flag opcache.validate_timestamps:flag opcache.revalidate_freq:int
  opcache.memory_consumption:int opcache.max_accelerated_files:int
  date.timezone:timezone session.gc_maxlifetime:int realpath_cache_size:size
  short_open_tag:flag allow_url_fopen:flag file_uploads:flag
)
DMP_PHP_ERROR_REPORTING=("E_ALL" "E_ALL & ~E_DEPRECATED & ~E_STRICT" "E_ALL & ~E_NOTICE" "E_ALL & ~E_NOTICE & ~E_DEPRECATED & ~E_STRICT")

# The PHP version of the enabled mod_php, like 8.3, from mods-enabled/php8.3.load.
dmp_php_apache_version() {
  local mods load
  mods="$(dirname "$APACHE_SITES_AVAILABLE")/mods-enabled"
  for load in "$mods"/php*.load; do
    [[ -e "$load" ]] || continue
    load="${load##*/php}"
    load="${load%.load}"
    [[ "$load" =~ ^[0-9]+\.[0-9]+$ ]] && { printf '%s' "$load"; return 0; }
  done
  return 1
}

# A comma list of allowed modes, each once, like debug,develop.
dmp_xdebug_modes_ok() {
  local list="$1" mode seen=","
  local -a modes
  [[ "$list" =~ ^[a-z]+(,[a-z]+)*$ ]] || return 1
  IFS=',' read -ra modes <<< "$list"
  for mode in "${modes[@]}"; do
    dmp_in_list "$mode" "${DMP_XDEBUG_MODES[@]}" || return 1
    [[ "$seen" != *",$mode,"* ]] || return 1
    seen+="$mode,"
  done
}

dmp_in_list() {
  local value="$1" item
  shift
  for item in "$@"; do
    [[ "$item" == "$value" ]] && return 0
  done
  return 1
}

# A PHP version as an argument, like 8.3; whether it is installed is checked later.
dmp_php_version_arg() {
  [[ "$1" =~ ^[0-9]\.[0-9]$ ]] || dmp_usage_error "not a PHP version: $1"
}

dmp_php_require_installed() {
  [[ -d "$PHP_CONF_DIR/$1/mods-available" ]] || dmp_die "PHP $1 is not installed"
}

# Whether a version has a part (apache2, fpm, cli): its package's marker in
# PHP_LIB_DIR/<version>/sapi and its config folder. Removing mod_php leaves
# /etc/php/<version>/apache2/php.ini behind, so the folder alone is not enough.
dmp_php_has_sapi() {
  [[ -e "$PHP_LIB_DIR/$1/sapi/$2" && -d "$PHP_CONF_DIR/$1/$2" ]]
}

# The web parts a version has: apache2 (mod_php) and fpm.
dmp_php_web_sapis() {
  local sapi
  for sapi in apache2 fpm; do
    dmp_php_has_sapi "$1" "$sapi" && printf '%s\n' "$sapi"
  done
  return 0
}

# After a change to a version: Apache restarts when it loads that version, and
# that version's FPM reloads when it runs, once php-fpm -t passes.
dmp_php_apply() {
  local version="$1" apache out
  apache="$(dmp_php_apache_version || true)"
  if [[ "$apache" == "$version" ]]; then
    dmp_apache_restart
  fi
  if dmp_php_has_sapi "$version" fpm && systemctl is-active --quiet "php$version-fpm"; then
    out="$("php-fpm$version" -t 2>&1)" || { printf '%s\n' "$out" >&2; dmp_die "php-fpm$version -t failed, not reloading it"; }
    systemctl reload "php$version-fpm" || dmp_die "php$version-fpm reload failed"
    dmp_ok "php$version-fpm reloaded"
  fi
}

# The folder a version's profiles and traces go to, made when missing:
# $STATE_DIR/profiles/<version>, the panel user's with the web server's group
# (setgid, 2770), so PHP writes there and the panel reads and deletes; no
# path from the caller.
dmp_xdebug_output_dir() {
  local version="$1" dir
  dir="$STATE_DIR/profiles/$version"
  # Root-owned in real use; the bats tests run as a normal user against a temp tree.
  if [[ $EUID -eq 0 ]]; then
    install -d -m 0755 -o root -g root "$STATE_DIR" "$STATE_DIR/profiles"
    install -d -m 2770 -o "$PANEL_USER" -g "$WEB_GROUP" "$dir"
  else
    install -d -m 0755 "$STATE_DIR" "$STATE_DIR/profiles"
    install -d -m 2770 "$dir"
  fi
  printf '%s' "$dir"
}

# xdebug-enable [version] <mode> <start>: Xdebug on for a version's web parts with the panel's settings.
dmp_xdebug_enable() {
  local version="" mode start dir ini tmp sapi out
  local -a sapis
  if (( $# == 3 )); then
    version="$1"
    dmp_php_version_arg "$version"
    shift
  fi
  mode="$1" start="$2"
  dmp_xdebug_modes_ok "$mode" || dmp_usage_error "xdebug modes not allowed: $mode (a comma list of: ${DMP_XDEBUG_MODES[*]}, each once)"
  dmp_in_list "$start" "${DMP_XDEBUG_STARTS[@]}" || dmp_usage_error "start_with_request must be one of: ${DMP_XDEBUG_STARTS[*]}"
  if [[ -z "$version" ]]; then
    version="$(dmp_php_apache_version)" || dmp_die "Apache does not load mod_php, so there is no PHP for it to debug"
  fi
  dmp_php_require_installed "$version"
  [[ -f "$PHP_CONF_DIR/$version/mods-available/xdebug.ini" ]] || dmp_die "Xdebug is not installed for PHP $version: apt install php$version-xdebug"
  mapfile -t sapis < <(dmp_php_web_sapis "$version")
  (( ${#sapis[@]} > 0 )) || dmp_die "PHP $version has no web part (mod_php or FPM) to debug"

  # Profiles and traces go to a folder of the panel's that PHP can write (Apache's /tmp is its own, so the panel would not see them there).
  out=""
  if [[ ",$mode," == *",profile,"* || ",$mode," == *",trace,"* ]]; then
    out="$(dmp_xdebug_output_dir "$version")"
  fi
  for sapi in "${sapis[@]}"; do
    dir="$PHP_CONF_DIR/$version/$sapi/conf.d"
    install -d -m 0755 "$dir"
    ini="$dir/$DMP_XDEBUG_INI_NAME"
    tmp="$(mktemp "$dir/.dmp-xdebug.XXXXXX")"
    cat > "$tmp" <<INI
; Managed by devmagic-panel. Edits here are overwritten.
xdebug.mode=$mode
xdebug.start_with_request=$start
xdebug.client_host=127.0.0.1
xdebug.client_port=9003
INI
    if [[ -n "$out" ]]; then
      cat >> "$tmp" <<INI
xdebug.output_dir=$out
xdebug.profiler_output_name=cachegrind.out.%u.%H%R
xdebug.trace_output_name=trace.%u.%H%R
INI
    fi
    chmod 0644 "$tmp"
    mv -f "$tmp" "$ini"
    phpenmod -v "$version" -s "$sapi" xdebug || dmp_die "phpenmod xdebug for $sapi failed"
  done
  dmp_php_apply "$version"
  dmp_ok "xdebug on for PHP $version (${sapis[*]}, mode $mode, start $start)"
}

# xdebug-disable [version]
dmp_xdebug_disable() {
  local version="${1:-}" sapi
  local -a sapis
  if [[ -n "$version" ]]; then
    dmp_php_version_arg "$version"
  else
    version="$(dmp_php_apache_version)" || dmp_die "Apache does not load mod_php"
  fi
  dmp_php_require_installed "$version"
  mapfile -t sapis < <(dmp_php_web_sapis "$version")
  for sapi in "${sapis[@]}"; do
    phpdismod -v "$version" -s "$sapi" xdebug || dmp_die "phpdismod xdebug for $sapi failed"
    rm -f "${PHP_CONF_DIR:?}/${version:?}/${sapi:?}/conf.d/${DMP_XDEBUG_INI_NAME:?}"
  done
  dmp_php_apply "$version"
  dmp_ok "xdebug off for PHP $version"
}

# False when a module's ini loads a library its version does not have: apt
# remove takes the library and keeps the ini. True when it cannot tell.
dmp_php_module_library() {
  local version="$1" name="$2" lib dir
  command -v "php$version" >/dev/null || return 0
  lib="$(sed -n 's/^[[:space:]]*\(zend_\)\{0,1\}extension[[:space:]]*=[[:space:]]*"\{0,1\}\([^";[:space:]]*\).*/\2/p' "$PHP_CONF_DIR/$version/mods-available/$name.ini" | head -n 1)"
  [[ -n "$lib" ]] || return 0
  [[ "$lib" == /* ]] && { [[ -f "$lib" ]]; return; }
  dir="$("php$version" -n -r 'echo PHP_EXTENSION_DIR;' 2>/dev/null)" || return 0
  [[ "$dir" == /* ]] || return 0
  [[ "$lib" == *.so ]] || lib="$lib.so"
  [[ -f "$dir/$lib" ]]
}

# php-module [version] <name> <on|off>: a module installed for a version on or
# off for every part of it (apache2, fpm, cli), then Apache and FPM pick it up.
dmp_php_module() {
  local version="" name state sapi
  local -a sapis=()
  if (( $# == 3 )); then
    version="$1"
    dmp_php_version_arg "$version"
    shift
  fi
  name="$1" state="$2"
  [[ "$name" =~ ^[a-z0-9_]{1,40}$ ]] || dmp_usage_error "not a PHP module name: $name"
  dmp_in_list "$state" on off || dmp_usage_error "php-module takes on or off, not: $state"
  [[ "$name" != xdebug ]] || dmp_usage_error "xdebug has its own commands: xdebug-enable and xdebug-disable"
  if [[ "$state" == off ]] && dmp_in_list "$name" "${DMP_PHP_REQUIRED[@]}"; then
    dmp_usage_error "WordPress cannot run without $name, so it stays on"
  fi
  if [[ -z "$version" ]]; then
    version="$(dmp_php_apache_version)" || dmp_die "Apache does not load mod_php, so there is no PHP to change"
  fi
  dmp_php_require_installed "$version"
  [[ -f "$PHP_CONF_DIR/$version/mods-available/$name.ini" ]] || dmp_die "$name is not installed for PHP $version"
  if [[ "$state" == on ]] && ! dmp_php_module_library "$version" "$name"; then
    dmp_die "the package of $name is not installed for PHP $version (apt remove keeps its ini): install php$version-$name first"
  fi
  for sapi in apache2 fpm cli; do
    dmp_php_has_sapi "$version" "$sapi" && sapis+=("$sapi")
  done
  # Before anything changes: a module switched with Apache unable to restart would wait for the next restart.
  if [[ "$(dmp_php_apache_version || true)" == "$version" ]]; then
    dmp_apache_configtest || dmp_die "not changing PHP modules, fix the Apache config first"
  fi
  for sapi in "${sapis[@]}"; do
    if [[ "$state" == on ]]; then
      phpenmod -v "$version" -s "$sapi" "$name" || dmp_die "phpenmod $name for $sapi failed"
    else
      phpdismod -v "$version" -s "$sapi" "$name" || dmp_die "phpdismod $name for $sapi failed"
    fi
  done
  dmp_php_apply "$version"
  dmp_ok "$name $state for PHP $version (${sapis[*]})"
}

# The kind of a setting the panel writes, from DMP_PHP_INI_SETTINGS.
dmp_php_ini_kind() {
  local entry
  for entry in "${DMP_PHP_INI_SETTINGS[@]}"; do
    [[ "${entry%%:*}" == "$1" ]] && { printf '%s' "${entry#*:}"; return 0; }
  done
  return 1
}

dmp_php_ini_value_ok() {
  local kind
  kind="$(dmp_php_ini_kind "$1")" || return 1
  case "$kind" in
    size) [[ "$2" =~ ^[1-9][0-9]{0,5}[KMG]?$ ]] ;;
    size-) [[ "$2" == -1 || "$2" =~ ^[1-9][0-9]{0,5}[KMG]?$ ]] ;;
    int) [[ "$2" =~ ^-?[0-9]{1,7}$ ]] ;;
    flag) [[ "$2" == On || "$2" == Off ]] ;;
    choice) dmp_in_list "$2" "${DMP_PHP_ERROR_REPORTING[@]}" ;;
    timezone) [[ "$2" == UTC || "$2" =~ ^[A-Z][A-Za-z_]+(/[A-Z][A-Za-z0-9_+-]+){1,2}$ ]] ;;
    *) return 1 ;;
  esac
}

# Checked "key = value" lines for an ini file, each setting once; a usage error otherwise.
dmp_php_ini_lines() {
  local pair key value seen=","
  for pair in "$@"; do
    [[ "$pair" == *=* ]] || dmp_usage_error "not key=value: $pair"
    key="${pair%%=*}"
    value="${pair#*=}"
    dmp_php_ini_value_ok "$key" "$value" || dmp_usage_error "not a setting the panel writes, or not a value it takes: $pair"
    [[ "$seen" != *",$key,"* ]] || dmp_usage_error "$key given twice"
    seen+="$key,"
    printf '%s = %s\n' "$key" "$value"
  done
}

# php-ini <version> <web|cli> [key=value...]: the panel's ini file for a
# version's web parts (apache2 and fpm) or its command line, with exactly
# these settings; none removes it.
dmp_php_ini() {
  local version="$1" scope="$2" body sapi dir tmp
  local -a sapis=()
  shift 2
  dmp_php_version_arg "$version"
  dmp_in_list "$scope" web cli || dmp_usage_error "php-ini takes web or cli, not: $scope"
  body="$(dmp_php_ini_lines "$@")" || exit 2
  dmp_php_require_installed "$version"
  if [[ "$scope" == web ]]; then
    mapfile -t sapis < <(dmp_php_web_sapis "$version")
  elif dmp_php_has_sapi "$version" cli; then
    sapis=(cli)
  fi
  (( ${#sapis[@]} > 0 )) || dmp_die "PHP $version has no $scope part"
  for sapi in "${sapis[@]}"; do
    dir="$PHP_CONF_DIR/$version/$sapi/conf.d"
    if [[ -z "$body" ]]; then
      rm -f "${dir:?}/${DMP_PHP_INI_NAME:?}"
      continue
    fi
    install -d -m 0755 "$dir"
    tmp="$(mktemp "$dir/.dmp-ini.XXXXXX")"
    printf '; Managed by devmagic-panel. Edits here are overwritten.\n%s\n' "$body" > "$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$dir/$DMP_PHP_INI_NAME"
  done
  if [[ "$scope" == web ]]; then
    dmp_php_apply "$version"
  fi
  dmp_ok "PHP $version $scope settings written for ${sapis[*]}: $(printf '%s' "${body:-none}" | tr '\n' ',' | sed 's/,/, /g')"
}

# The php.ini a version's package ships for one part: the command line has its own copy.
dmp_php_packaged_ini() {
  local file="$PHP_LIB_DIR/$1/php.ini-production"
  if [[ "$2" == cli && -f "$file.cli" ]]; then
    file="$file.cli"
  fi
  [[ -f "$file" ]] || return 1
  printf '%s' "$file"
}

# php-ini-reset <version> <apache2|fpm|cli>: the packaged php.ini again. The
# current one is saved in STATE_DIR/php-ini under the name it prints, for
# php-ini-put-back.
dmp_php_ini_reset() {
  local version="$1" sapi="$2" file packaged saved tmp
  dmp_php_version_arg "$version"
  dmp_in_list "$sapi" apache2 fpm cli || dmp_usage_error "php-ini-reset takes apache2, fpm or cli, not: $sapi"
  dmp_php_require_installed "$version"
  file="$PHP_CONF_DIR/$version/$sapi/php.ini"
  [[ -f "$file" ]] || dmp_die "PHP $version has no php.ini for $sapi"
  packaged="$(dmp_php_packaged_ini "$version" "$sapi")" || dmp_die "the packaged php.ini of PHP $version is missing in $PHP_LIB_DIR/$version"
  install -d -m 0700 "$STATE_DIR/php-ini"
  saved="$version-$sapi-$(date +%Y%m%d%H%M%S)"
  cp -p "$file" "$STATE_DIR/php-ini/$saved.ini"
  tmp="$(mktemp "$(dirname "$file")/.dmp-php-ini.XXXXXX")"
  cat "$packaged" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
  if [[ "$sapi" != cli ]]; then
    dmp_php_apply "$version"
  fi
  printf 'saved %s\n' "$saved"
  dmp_ok "php.ini of PHP $version ($sapi) is the packaged one again; yours is saved as $saved"
}

# php-ini-put-back <version> <apache2|fpm|cli> <saved>: the php.ini php-ini-reset saved.
dmp_php_ini_put_back() {
  local version="$1" sapi="$2" saved="$3" file tmp
  dmp_php_version_arg "$version"
  dmp_in_list "$sapi" apache2 fpm cli || dmp_usage_error "php-ini-put-back takes apache2, fpm or cli, not: $sapi"
  [[ "$saved" =~ ^[0-9]\.[0-9]-(apache2|fpm|cli)-[0-9]{14}$ && "$saved" == "$version-$sapi-"* ]] || dmp_usage_error "not a saved php.ini of PHP $version ($sapi): $saved"
  [[ -f "$STATE_DIR/php-ini/$saved.ini" ]] || dmp_die "no saved php.ini called $saved"
  file="$PHP_CONF_DIR/$version/$sapi/php.ini"
  [[ -d "$(dirname "$file")" ]] || dmp_die "PHP $version has no $sapi part"
  tmp="$(mktemp "$(dirname "$file")/.dmp-php-ini.XXXXXX")"
  cat "$STATE_DIR/php-ini/$saved.ini" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
  if [[ "$sapi" != cli ]]; then
    dmp_php_apply "$version"
  fi
  dmp_ok "php.ini of PHP $version ($sapi) put back from $saved"
}
