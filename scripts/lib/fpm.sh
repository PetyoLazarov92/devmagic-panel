# shellcheck shell=bash
# PHP-FPM pools for sites with a PHP version or settings of their own. Each
# such site gets the pool dmp-<folder> in /etc/php/<version>/fpm/pool.d,
# where <folder> is its folder in WEB_DIR (a local name), and one block in
# Apache's devmagic-panel-php.conf that sends the .php files of that folder
# to the pool. The pool files are the record: the conf is written from them.
# Sites without a pool keep running on mod_php, as before, until
# php-switch-fpm turns mod_php off: then a default handler sends them to the
# pool of one version (STATE_DIR/php-default), and phpMyAdmin to its own.

DMP_PHP_RUN_DIR="/run/php"
DMP_PHP_CONF_NAME="devmagic-panel-php.conf"
DMP_POOL_MARKER="; Managed by devmagic-panel. Edits here are overwritten."

dmp_apache_dir() { dirname "$APACHE_SITES_AVAILABLE"; }

# APACHE_RUN_USER or APACHE_RUN_GROUP from Apache's envvars, so the pools run as mod_php does; www-data otherwise.
dmp_apache_run_as() {
  local key="$1" line value="www-data"
  if [[ -f "$(dmp_apache_dir)/envvars" ]]; then
    line="$(grep -E "^export $key=[a-z_][a-z0-9_-]{0,31}\$" "$(dmp_apache_dir)/envvars" | tail -n 1 || true)"
    [[ -n "$line" ]] && value="${line#*=}"
  fi
  printf '%s' "$value"
}

dmp_pool_file() { printf '%s/%s/fpm/pool.d/dmp-%s.conf' "$PHP_CONF_DIR" "$1" "$2"; }

# The panel's pools as "version folder" lines, from their files.
dmp_pools() {
  local file version folder
  for file in "$PHP_CONF_DIR"/*/fpm/pool.d/dmp-*.conf; do
    [[ -f "$file" ]] || continue
    [[ "$(head -n 1 "$file")" == "$DMP_POOL_MARKER" ]] || continue
    version="${file#"$PHP_CONF_DIR"/}"
    version="${version%%/*}"
    folder="$(basename "$file" .conf)"
    folder="${folder#dmp-}"
    [[ "$version" =~ ^[0-9]\.[0-9]$ ]] && dmp_is_local_name "$folder" && printf '%s %s\n' "$version" "$folder"
  done
  return 0
}

# A named worker for one FPM socket, with a long timeout so slow imports are
# not cut at Apache's 300 seconds, and a Location for the PHP tab's info
# through it, on the panel's vhost only.
dmp_php_conf_worker() {
  cat <<EOF
    <Proxy "unix:$2|fcgi://$1">
        ProxySet timeout=3600
    </Proxy>
    <Location "$DMP_PHP_INFO_PATH/$1/">
        Require local
        SetHandler "proxy:fcgi://$1"
    </Location>
EOF
}

# devmagic-panel-php.conf from the pools, and a worker per installed FPM for the PHP tab.
dmp_php_conf_render() {
  local version folder dir
  printf '%s\n' "# Managed by devmagic-panel. Edits here are overwritten."
  printf '%s\n' "# Sites with a PHP version or settings of their own, each sent to its PHP-FPM pool"
  printf '%s\n' "# (dmp-<folder> in $PHP_CONF_DIR/<version>/fpm/pool.d). Other sites run on mod_php,"
  printf '%s\n' "# or once it is off, on the default version at the end of this file."
  printf '%s\n' "<IfModule proxy_fcgi_module>"
  while read -r version folder; do
    printf '    # %s: PHP %s\n' "$folder" "$version"
    dmp_php_conf_worker "dmp-$folder" "$DMP_PHP_RUN_DIR/dmp-$folder.sock"
    cat <<EOF
    <Directory "$WEB_DIR/$folder">
        CGIPassAuth On
        <FilesMatch "\.php\$">
            SetHandler "proxy:fcgi://dmp-$folder"
        </FilesMatch>
    </Directory>
EOF
  done < <(dmp_pools)
  for dir in "$PHP_CONF_DIR"/*/fpm/pool.d; do
    [[ -d "$dir" ]] || continue
    version="${dir#"$PHP_CONF_DIR"/}"
    version="${version%%/*}"
    [[ "$version" =~ ^[0-9]\.[0-9]$ ]] || continue
    # apt remove leaves /etc/php/<version>; the marker of its FPM package goes with it.
    [[ -e "$PHP_LIB_DIR/$version/sapi/fpm" ]] || continue
    printf '    # PHP %s: its own pool, for the PHP tab\n' "$version"
    dmp_php_conf_worker "php$version" "$DMP_PHP_RUN_DIR/php$version-fpm.sock"
  done
  dmp_php_conf_default
  printf '%s\n' "</IfModule>"
}

# The version every site without a pool runs once mod_php is off (php-switch-fpm), from STATE_DIR.
dmp_php_default() {
  local version
  [[ -f "$STATE_DIR/php-default" ]] || return 1
  version="$(head -n 1 "$STATE_DIR/php-default")"
  [[ "$version" =~ ^[0-9]\.[0-9]$ && -e "$PHP_LIB_DIR/$version/sapi/fpm" ]] || return 1
  printf '%s' "$version"
}

# phpMyAdmin's folder, from the Alias its Apache config sets, when it is enabled.
dmp_phpmyadmin_dir() {
  local conf dir
  conf="$(dmp_apache_dir)/conf-enabled/phpmyadmin.conf"
  [[ -f "$conf" ]] || return 1
  dir="$(sed -nE 's#^[[:space:]]*Alias[[:space:]]+/phpmyadmin[[:space:]]+(/[A-Za-z0-9/._-]+)[[:space:]]*$#\1#p' "$conf" | head -n 1)"
  [[ -n "$dir" && -d "$dir" ]] || return 1
  printf '%s' "${dir%/}"
}

# With mod_php off: phpMyAdmin through its own pool, and every other .php file
# through the default version's, so no vhost ever sends PHP source.
dmp_php_conf_default() {
  local version dir
  version="$(dmp_php_default)" || return 0
  if dir="$(dmp_phpmyadmin_dir)" && [[ -f "$(dmp_pool_file "$version" phpmyadmin)" ]]; then
    printf '    # phpMyAdmin: its own pool, with the folder limits its config gave mod_php\n'
    dmp_php_conf_worker dmp-phpmyadmin "$DMP_PHP_RUN_DIR/dmp-phpmyadmin.sock"
    cat <<EOF
    <Directory "$dir">
        <FilesMatch "\.php\$">
            SetHandler "proxy:fcgi://dmp-phpmyadmin"
        </FilesMatch>
    </Directory>
EOF
  fi
  cat <<EOF
    # Every other site: PHP $version, now that mod_php is off.
    <IfModule setenvif_module>
        SetEnvIfNoCase ^Authorization\$ "(.+)" HTTP_AUTHORIZATION=\$1
    </IfModule>
    <FilesMatch ".+\.ph(?:ar|p|tml)\$">
        SetHandler "proxy:fcgi://php$version"
    </FilesMatch>
EOF
}

# phpMyAdmin's pool in a version, with the upload folder and folder limit its
# config sets for mod_php; none when phpMyAdmin is not enabled.
dmp_phpmyadmin_pool() {
  local version="$1" conf file tmp user group key value
  dmp_phpmyadmin_dir >/dev/null || return 0
  conf="$(dmp_apache_dir)/conf-enabled/phpmyadmin.conf"
  user="$(dmp_apache_run_as APACHE_RUN_USER)"
  group="$(dmp_apache_run_as APACHE_RUN_GROUP)"
  file="$(dmp_pool_file "$version" phpmyadmin)"
  tmp="$(mktemp "$(dirname "$file")/.dmp-pool.XXXXXX")"
  {
    printf '%s\n' "$DMP_POOL_MARKER"
    printf '; phpMyAdmin, with the settings its Apache config gives mod_php.\n[dmp-phpmyadmin]\n'
    printf 'user = %s\ngroup = %s\n' "$user" "$group"
    printf 'listen = %s/dmp-phpmyadmin.sock\n' "$DMP_PHP_RUN_DIR"
    printf 'listen.owner = %s\nlisten.group = %s\nlisten.mode = 0660\n' "$user" "$group"
    printf 'pm = ondemand\npm.max_children = 5\npm.process_idle_timeout = 10s\n'
    for key in upload_tmp_dir open_basedir; do
      value="$(sed -nE "s#^[[:space:]]*php_admin_value[[:space:]]+${key}[[:space:]]+([A-Za-z0-9/._:-]+)[[:space:]]*\$#\\1#p" "$conf" | head -n 1)"
      [[ -z "$value" ]] || printf 'php_admin_value[%s] = %s\n' "$key" "$value"
    done
  } > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
}

dmp_mod_enabled() { [[ -e "$(dmp_apache_dir)/mods-enabled/$1.load" ]]; }

# php-switch-fpm <version>: mod_php off, Apache on mpm_event, and every site
# without a pool of its own on PHP <version> through PHP-FPM (phpMyAdmin
# through its own pool). Everything goes back when a check fails.
dmp_php_switch_fpm() {
  local version="$1" modphp previous="" pmafile v
  dmp_php_version_arg "$version"
  dmp_php_require_installed "$version"
  [[ -e "$PHP_LIB_DIR/$version/sapi/fpm" ]] || dmp_die "PHP-FPM is not installed for PHP $version: apt install php$version-fpm"
  [[ -f "$(dmp_apache_dir)/mods-available/proxy_fcgi.load" ]] || dmp_die "Apache has no proxy_fcgi module"
  [[ -f "$(dmp_apache_dir)/mods-available/mpm_event.load" ]] || dmp_die "Apache has no mpm_event module"
  modphp="$(dmp_php_apache_version || true)"
  [[ -f "$STATE_DIR/php-default" ]] && previous="$(head -n 1 "$STATE_DIR/php-default")"
  install -d -m 0755 "$STATE_DIR"
  printf '%s\n' "$version" > "$STATE_DIR/php-default"
  chmod 0644 "$STATE_DIR/php-default"
  for v in "$PHP_CONF_DIR"/*/fpm/pool.d/dmp-phpmyadmin.conf; do
    [[ -f "$v" ]] && rm -f "${v:?}"
  done
  dmp_phpmyadmin_pool "$version"
  pmafile="$(dmp_pool_file "$version" phpmyadmin)"

  dmp_switch_back() {
    rm -f "${pmafile:?}"
    if [[ -n "$previous" ]]; then printf '%s\n' "$previous" > "$STATE_DIR/php-default"; else rm -f "${STATE_DIR:?}/php-default"; fi
    if [[ -n "$modphp" ]]; then
      a2dismod -q mpm_event >/dev/null 2>&1 || true
      a2enmod -q mpm_prefork "php$modphp" >/dev/null 2>&1 || true
    fi
    dmp_php_conf_write >/dev/null 2>&1 || true
  }
  if ! dmp_fpm_test "$version"; then
    dmp_switch_back
    dmp_die "php-fpm$version -t failed, nothing changed"
  fi
  if [[ -n "$modphp" ]]; then
    a2dismod -q "php$modphp" >/dev/null || { dmp_switch_back; dmp_die "a2dismod php$modphp failed"; }
  fi
  if dmp_mod_enabled mpm_prefork; then
    a2dismod -q mpm_prefork >/dev/null || { dmp_switch_back; dmp_die "a2dismod mpm_prefork failed"; }
  fi
  a2enmod -q mpm_event >/dev/null || { dmp_switch_back; dmp_die "a2enmod mpm_event failed"; }
  if ! dmp_php_conf_write; then
    dmp_switch_back
    dmp_die "Apache's configtest failed, mod_php is back on"
  fi
  dmp_fpm_apply "$version"
  if ! systemctl restart apache2; then
    dmp_switch_back
    systemctl restart apache2 || true
    dmp_die "Apache would not restart on PHP-FPM, mod_php is back on"
  fi
  dmp_ok "every site without a PHP of its own runs on PHP $version through PHP-FPM; Apache runs mpm_event${modphp:+, mod_php $modphp is off}"
}

# php-switch-modphp <version>: mod_php of a version back on, Apache back on
# mpm_prefork, and sites without a pool back on mod_php.
dmp_php_switch_modphp() {
  local version="$1" v
  dmp_php_version_arg "$version"
  [[ -f "$(dmp_apache_dir)/mods-available/php$version.load" ]] || dmp_die "mod_php is not installed for PHP $version: apt install libapache2-mod-php$version"
  rm -f "${STATE_DIR:?}/php-default"
  for v in "$PHP_CONF_DIR"/*/fpm/pool.d/dmp-phpmyadmin.conf; do
    [[ -f "$v" ]] && rm -f "${v:?}"
  done
  if dmp_mod_enabled mpm_event; then
    a2dismod -q mpm_event >/dev/null || dmp_die "a2dismod mpm_event failed"
  fi
  a2enmod -q mpm_prefork "php$version" >/dev/null || dmp_die "a2enmod mpm_prefork php$version failed"
  dmp_php_conf_write || dmp_die "Apache's configtest failed with mod_php $version back on"
  systemctl restart apache2 || dmp_die "apache restart failed"
  dmp_ok "sites without a PHP of their own run on mod_php $version again; Apache runs mpm_prefork"
}

# Writes the conf, enables it with proxy_fcgi and setenvif, and runs configtest.
# Returns 1 with the previous conf back when configtest fails.
dmp_php_conf_write() {
  local conf previous="" tmp
  conf="$(dmp_apache_dir)/conf-available/$DMP_PHP_CONF_NAME"
  install -d -m 0755 "$(dirname "$conf")"
  if [[ -f "$conf" ]]; then
    previous="$(mktemp "$(dirname "$conf")/.dmp-php-conf.prev.XXXXXX")"
    cp -p "$conf" "$previous"
  fi
  tmp="$(mktemp "$(dirname "$conf")/.dmp-php-conf.XXXXXX")"
  dmp_php_conf_render > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$conf"
  a2enmod -q proxy_fcgi setenvif >/dev/null || dmp_die "a2enmod proxy_fcgi setenvif failed"
  a2enconf -q "${DMP_PHP_CONF_NAME%.conf}" >/dev/null || dmp_die "a2enconf ${DMP_PHP_CONF_NAME%.conf} failed"
  if ! dmp_apache_configtest; then
    if [[ -n "$previous" ]]; then mv -f "$previous" "$conf"; else rm -f "${conf:?}"; fi
    return 1
  fi
  [[ -z "$previous" ]] || rm -f "${previous:?}"
  return 0
}

# php-fpm -t for a version, with its output when it fails.
dmp_fpm_test() {
  local out
  out="$("php-fpm$1" -t 2>&1)" && return 0
  printf '%s\n' "$out" >&2
  return 1
}

# PHP-FPM makes a new pool's socket a moment after its reload returns: waits
# up to 10 seconds for it, so what comes next does not meet a 503.
dmp_fpm_wait_socket() {
  local sock="$1" i
  for (( i = 0; i < 50; i++ )); do
    [[ -S "$sock" ]] && return 0
    sleep 0.2
  done
  dmp_warn "PHP-FPM has not made $sock yet"
}

# Starts a version's FPM (and keeps it on at boot) or reloads it when it runs.
dmp_fpm_apply() {
  local unit="php$1-fpm"
  if systemctl is-active --quiet "$unit"; then
    systemctl reload "$unit" || dmp_die "$unit reload failed"
    dmp_ok "$unit reloaded"
  else
    systemctl enable --now "$unit" >/dev/null 2>&1 || dmp_die "$unit would not start"
    dmp_ok "$unit started"
  fi
}

# php-pool-write <folder> <version> [key=value...]: the site in WEB_DIR/<folder>
# runs on PHP <version> through its own pool, with these settings on top of
# the version's. A pool it had in another version goes.
dmp_php_pool_write() {
  local folder="$1" version="$2" body file tmp user group v
  local -a others=() saved=()
  shift 2
  dmp_require_local_name "$folder"
  # A socket path has room for about 100 characters.
  (( ${#DMP_PHP_RUN_DIR} + ${#folder} + 10 <= 100 )) || dmp_usage_error "the folder name is too long for a PHP-FPM socket: $folder"
  dmp_php_version_arg "$version"
  body="$(dmp_php_ini_lines "$@")" || exit 2
  [[ -d "$WEB_DIR/$folder" ]] || dmp_die "no site folder $WEB_DIR/$folder"
  [[ -d "$PHP_CONF_DIR/$version/fpm/pool.d" ]] || dmp_die "PHP-FPM is not installed for PHP $version: apt install php$version-fpm"
  [[ -f "$(dmp_apache_dir)/mods-available/proxy_fcgi.load" ]] || dmp_die "Apache has no proxy_fcgi module"
  user="$(dmp_apache_run_as APACHE_RUN_USER)"
  group="$(dmp_apache_run_as APACHE_RUN_GROUP)"
  file="$(dmp_pool_file "$version" "$folder")"

  # The site's pools now, kept until everything checks out.
  local backup
  backup="$(mktemp -d "$STATE_DIR/.dmp-pools.XXXXXX" 2>/dev/null || mktemp -d)"
  while read -r v _; do
    [[ "$v" == "$version" ]] || others+=("$v")
    cp -p "$(dmp_pool_file "$v" "$folder")" "$backup/$v.conf"
    saved+=("$v")
  done < <(dmp_pools | awk -v f="$folder" '$2 == f')

  tmp="$(mktemp "$(dirname "$file")/.dmp-pool.XXXXXX")"
  {
    printf '%s\n' "$DMP_POOL_MARKER"
    printf '; The PHP-FPM pool of the site in %s/%s.\n' "$WEB_DIR" "$folder"
    printf '[dmp-%s]\n' "$folder"
    printf 'user = %s\ngroup = %s\n' "$user" "$group"
    printf 'listen = %s/dmp-%s.sock\n' "$DMP_PHP_RUN_DIR" "$folder"
    printf 'listen.owner = %s\nlisten.group = %s\nlisten.mode = 0660\n' "$user" "$group"
    # No process while the site gets no requests; a few at most while it does.
    printf 'pm = ondemand\npm.max_children = 10\npm.process_idle_timeout = 10s\npm.max_requests = 500\n'
    [[ -z "$body" ]] || printf '%s\n' "$body" | sed -E 's/^([^ ]+) = (.*)$/php_admin_value[\1] = \2/'
  } > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
  for v in "${others[@]}"; do
    rm -f "$(dmp_pool_file "$v" "$folder")"
  done

  dmp_pools_restore() {
    rm -f "$(dmp_pool_file "$version" "$folder")"
    for v in "${saved[@]}"; do
      cp -p "$backup/$v.conf" "$(dmp_pool_file "$v" "$folder")"
    done
    rm -rf "${backup:?}"
  }
  if ! dmp_fpm_test "$version"; then
    dmp_pools_restore
    dmp_die "php-fpm$version -t failed, the site's pools are as they were"
  fi
  if ! dmp_php_conf_write; then
    dmp_pools_restore
    dmp_php_conf_write >/dev/null 2>&1 || true
    dmp_die "Apache's configtest failed, the site's pools are as they were"
  fi
  rm -rf "${backup:?}"
  dmp_fpm_apply "$version"
  for v in "${others[@]}"; do
    dmp_fpm_apply "$v"
  done
  systemctl reload apache2 || dmp_die "apache reload failed"
  dmp_fpm_wait_socket "$DMP_PHP_RUN_DIR/dmp-$folder.sock"
  dmp_ok "$folder runs on PHP $version through its pool dmp-$folder${body:+, with $(printf '%s' "$body" | tr '\n' ',' | sed 's/,$//; s/,/, /g')}"
}

# php-pool-remove <folder>: the site goes back to the PHP every site runs.
dmp_php_pool_remove() {
  local folder="$1" v
  local -a versions=()
  dmp_require_local_name "$folder"
  while read -r v _; do
    versions+=("$v")
  done < <(dmp_pools | awk -v f="$folder" '$2 == f')
  if (( ${#versions[@]} == 0 )); then
    dmp_ok "$folder has no pool of its own"
    return 0
  fi
  for v in "${versions[@]}"; do
    rm -f "$(dmp_pool_file "$v" "$folder")"
  done
  dmp_php_conf_write || dmp_die "Apache's configtest failed after taking $folder's pool out"
  for v in "${versions[@]}"; do
    dmp_fpm_apply "$v"
  done
  systemctl reload apache2 || dmp_die "apache reload failed"
  dmp_ok "$folder runs on the PHP every site runs again"
}

# php-fpm-match <version>: PHP-FPM of a version gets what Apache's mod_php of
# it has: the same modules on, the panel's settings and Xdebug files, and the
# same php.ini (FPM's saved first, under the name it prints).
dmp_php_fpm_match() {
  local version="$1" base mod name saved tmp
  dmp_php_version_arg "$version"
  dmp_php_require_installed "$version"
  base="$PHP_CONF_DIR/$version"
  [[ -d "$base/apache2" ]] || dmp_die "PHP $version has no mod_php to match"
  [[ -d "$base/fpm" ]] || dmp_die "PHP-FPM is not installed for PHP $version: apt install php$version-fpm"
  for mod in "$base"/mods-available/*.ini; do
    name="$(basename "$mod" .ini)"
    [[ "$name" =~ ^[a-z0-9_]{1,40}$ ]] || continue
    if compgen -G "$base/apache2/conf.d/[0-9]*-$name.ini" >/dev/null; then
      compgen -G "$base/fpm/conf.d/[0-9]*-$name.ini" >/dev/null || phpenmod -v "$version" -s fpm "$name" || dmp_die "phpenmod $name for fpm failed"
    else
      ! compgen -G "$base/fpm/conf.d/[0-9]*-$name.ini" >/dev/null || phpdismod -v "$version" -s fpm "$name" || dmp_die "phpdismod $name for fpm failed"
    fi
  done
  install -d -m 0755 "$base/fpm/conf.d"
  for name in "$DMP_PHP_INI_NAME" "$DMP_XDEBUG_INI_NAME"; do
    if [[ -f "$base/apache2/conf.d/$name" ]]; then
      install -m 0644 "$base/apache2/conf.d/$name" "$base/fpm/conf.d/$name"
    else
      rm -f "${base:?}/fpm/conf.d/${name:?}"
    fi
  done
  if [[ -f "$base/apache2/php.ini" ]] && ! cmp -s "$base/apache2/php.ini" "$base/fpm/php.ini"; then
    install -d -m 0700 "$STATE_DIR/php-ini"
    saved="$version-fpm-$(date +%Y%m%d%H%M%S)"
    [[ ! -f "$base/fpm/php.ini" ]] || cp -p "$base/fpm/php.ini" "$STATE_DIR/php-ini/$saved.ini"
    tmp="$(mktemp "$base/fpm/.dmp-php-ini.XXXXXX")"
    cat "$base/apache2/php.ini" > "$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$base/fpm/php.ini"
    printf 'saved %s\n' "$saved"
  fi
  dmp_fpm_test "$version" || dmp_die "php-fpm$version -t failed after matching"
  dmp_fpm_apply "$version"
  dmp_ok "PHP-FPM $version has the modules, settings and php.ini of Apache's PHP $version"
}
