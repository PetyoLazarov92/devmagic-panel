# shellcheck shell=bash
# nginx next to Apache. Both answer on ports 80 and 443, each on its own
# loopback address: Apache on APACHE_ADDRESS (127.0.0.1), nginx on
# NGINX_ADDRESS (127.0.0.2). A site is served by the server its line in the
# hosts file points at, so nothing is proxied from one to the other.
#
# nginx-setup narrows Apache's ports.conf from every address to
# APACHE_ADDRESS (the original is kept in STATE_DIR/nginx), turns Debian's
# default nginx site off (it listens on every address, where Apache is) and
# writes conf.d/devmagic-panel.conf: the panel's settings and a server for
# names nginx has no site for. That file is the record that nginx is set up.
# nginx-teardown puts all of it back. The panel's own site, phpMyAdmin and
# vhosts made by hand stay on Apache.

DMP_NGINX_CONF_NAME="devmagic-panel.conf"
# The first nginx with ssl_reject_handshake, for the server of unknown names.
DMP_NGINX_REJECT_HANDSHAKE="1.19.4"

dmp_nginx_dir() { dirname "$NGINX_SITES_AVAILABLE"; }
dmp_nginx_conf() { printf '%s/conf.d/%s' "$(dmp_nginx_dir)" "$DMP_NGINX_CONF_NAME"; }
dmp_nginx_state() { printf '%s/nginx' "$STATE_DIR"; }
dmp_apache_ports_file() { printf '%s/ports.conf' "$(dmp_apache_dir)"; }

dmp_nginx_installed() { command -v nginx >/dev/null && [[ -f "$(dmp_nginx_dir)/nginx.conf" ]]; }
dmp_nginx_require_installed() { dmp_nginx_installed || dmp_die "nginx is not installed: sudo apt install nginx"; }
dmp_nginx_is_setup() { [[ -f "$(dmp_nginx_conf)" ]] && dmp_vhost_is_managed "$(dmp_nginx_conf)"; }

# nginx's version, like 1.24.0; nginx -v prints it on stderr.
dmp_nginx_version() { nginx -v 2>&1 | sed -nE 's#.*nginx/([0-9]+\.[0-9]+\.[0-9]+).*#\1#p' | head -n 1; }

# True when version $1 is $2 or newer.
dmp_version_at_least() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" == "$2" ]]; }

dmp_nginx_configtest() {
  local out
  if out="$(nginx -t 2>&1)"; then
    dmp_ok "nginx configtest passed"
    return 0
  fi
  dmp_error "nginx configtest failed:"
  printf '%s\n' "$out" >&2
  return 1
}

dmp_nginx_reload() {
  dmp_nginx_require_installed
  dmp_nginx_configtest || dmp_die "not reloading nginx, fix the config first"
  systemctl reload nginx || dmp_die "nginx reload failed: journalctl -u nginx"
  dmp_ok "nginx reloaded"
}

dmp_nginx_restart() {
  dmp_nginx_require_installed
  dmp_nginx_configtest || dmp_die "not restarting nginx, fix the config first"
  systemctl restart nginx || dmp_die "nginx restart failed: journalctl -u nginx"
  dmp_ok "nginx restarted"
}

# The listens of enabled nginx configs that are not the panel's and want port
# 80 or 443 somewhere but NGINX_ADDRESS, as "file: listen" lines. nginx binds
# a port on every address as soon as one listen of it has no address, so any
# of these keeps nginx from starting once Apache holds APACHE_ADDRESS. IPv6
# listens are left out: Apache answers on an IPv4 address only. Debian's
# default site is left out too, as nginx-setup turns it off.
dmp_nginx_conflicts() {
  local file spec addr port
  for file in "$NGINX_SITES_ENABLED"/* "$(dmp_nginx_dir)"/conf.d/*.conf; do
    [[ -f "$file" ]] || continue
    dmp_vhost_is_managed "$file" && continue
    [[ "$file" == "$NGINX_SITES_ENABLED/default" && -L "$file" ]] && continue
    while IFS= read -r spec; do
      [[ "$spec" == unix:* || "$spec" == \[* ]] && continue
      if [[ "$spec" =~ ^[0-9]+$ ]]; then
        addr="*"
        port="$spec"
      elif [[ "$spec" == *:* ]]; then
        addr="${spec%:*}"
        port="${spec##*:}"
      else
        addr="$spec"
        port=80
      fi
      if [[ ("$port" == 80 || "$port" == 443) && "$addr" != "$NGINX_ADDRESS" ]]; then
        printf '%s: listen %s\n' "$file" "$spec"
      fi
    done < <(sed -nE 's/^[[:space:]]*listen[[:space:]]+([^;[:space:]]+).*$/\1/p' "$file")
  done
  return 0
}

# Programs other than Apache and nginx on port 80 or 443 where nginx or
# Apache will listen, from ss (which names them when run as root).
dmp_nginx_port_users() {
  local port local_addr process addr
  for port in 80 443; do
    while read -r local_addr process; do
      [[ -n "$local_addr" ]] || continue
      addr="${local_addr%:*}"
      process="$(sed -nE 's/^users:\(\("([^"]+)".*/\1/p' <<< "$process")"
      [[ "$process" == apache2 || "$process" == nginx ]] && continue
      case "$addr" in
        "$NGINX_ADDRESS" | "$APACHE_ADDRESS" | 0.0.0.0 | "*" | "[::]") printf '%s on %s\n' "${process:-a program}" "$local_addr" ;;
      esac
    done < <(ss -ltnpH "sport = :$port" 2>/dev/null | awk '{ print $4, $6 }')
  done
  return 0
}

# Apache's ports.conf with Listen 80 and Listen 443 on APACHE_ADDRESS only, from the original.
dmp_apache_ports_render() {
  local original="$1" line seen=" "
  printf '%s\n' "$DMP_VHOST_MARKER"
  printf '# Apache answers on %s only, so nginx can answer on %s (devmagic-panel nginx-setup).\n' "$APACHE_ADDRESS" "$NGINX_ADDRESS"
  printf '# The original is in %s/ports.conf; nginx-teardown puts it back.\n' "$(dmp_nginx_state)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^([[:space:]]*)Listen[[:space:]]+(\*:|0\.0\.0\.0:|\[::\]:)?(80|443)([[:space:]]+[a-z]+)?[[:space:]]*$ ]]; then
      # Listen 80 and Listen [::]:80 both become one Listen on the address.
      [[ "$seen" == *" ${BASH_REMATCH[3]} "* ]] && continue
      seen+="${BASH_REMATCH[3]} "
      printf '%sListen %s:%s%s\n' "${BASH_REMATCH[1]}" "$APACHE_ADDRESS" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"
    else
      printf '%s\n' "$line"
    fi
  done < "$original"
}

# Refuses a ports.conf that still has Apache on port 80 or 443 somewhere but APACHE_ADDRESS.
dmp_apache_ports_check() {
  local line
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*Listen[[:space:]]+([^[:space:]]+) ]] || continue
    case "${BASH_REMATCH[1]}" in
      "$APACHE_ADDRESS":*) ;;
      80 | 443 | *:80 | *:443) dmp_die "Apache's ports.conf has '${line#"${line%%[![:space:]]*}"}', which the panel does not know how to move to $APACHE_ADDRESS: change it by hand" ;;
    esac
  done < "$1"
}

# One http-level setting, unless nginx.conf sets it already (twice is an error).
dmp_nginx_http_setting() {
  if grep -Eq "^[[:space:]]*$1[[:space:]]" "$(dmp_nginx_dir)/nginx.conf"; then
    printf '# %s: nginx.conf sets it.\n' "$1"
  else
    printf '%s %s;\n' "$1" "$2"
  fi
}

dmp_nginx_conf_render() {
  local version tls
  version="$(dmp_nginx_version)"
  if [[ -n "$version" ]] && dmp_version_at_least "$version" "$DMP_NGINX_REJECT_HANDSHAKE"; then
    tls="    ssl_reject_handshake on;"
  else
    [[ -f "$(dmp_cert_file "$PANEL_DOMAIN")" ]] || dmp_die "no certificate for $PANEL_DOMAIN yet, which nginx ${version:-of this age} needs for names it has no site for"
    tls="    ssl_certificate $(dmp_cert_file "$PANEL_DOMAIN");"$'\n'"    ssl_certificate_key $(dmp_cert_key_file "$PANEL_DOMAIN");"
  fi
  printf '%s\n' "$DMP_VHOST_MARKER"
  cat <<EOF
# nginx next to Apache, set up by devmagic-panel: nginx answers on $NGINX_ADDRESS,
# Apache on $APACHE_ADDRESS, both on ports 80 and 443. A site is served by the
# server its line in /etc/hosts points at. nginx-teardown removes this file.

EOF
  printf '# Long local names, like local.shop.wandworks.example.\n'
  dmp_nginx_http_setting server_names_hash_bucket_size 128
  printf "# No upload limit of nginx's own: PHP's upload_max_filesize and post_max_size apply.\n"
  dmp_nginx_http_setting client_max_body_size 0
  printf '# Imports and other slow requests run as long as PHP lets them, with room for big headers.\n'
  dmp_nginx_http_setting fastcgi_read_timeout 3600s
  dmp_nginx_http_setting fastcgi_buffers "16 16k"
  dmp_nginx_http_setting fastcgi_buffer_size 32k
  cat <<EOF

# Names nginx has no site for.
server {
    listen $NGINX_ADDRESS:80 default_server;
    listen $NGINX_ADDRESS:443 ssl default_server;
    server_name _;
$tls
    default_type text/plain;
    return 404 "No site on nginx answers to \$host. Sites are set up at https://$PANEL_DOMAIN\n";
}
EOF
}

# Writes stdin to a file through a temp file in its folder.
dmp_nginx_put() {
  local file="$1" tmp
  tmp="$(mktemp "$(dirname "$file")/.dmp-nginx.XXXXXX")"
  cat > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
}

# The link Debian's default site had, from STATE_DIR, when it is a plain site in sites-available.
dmp_nginx_default_target() {
  local file="$1" target
  [[ -f "$file" ]] || return 1
  target="$(head -n 1 "$file")"
  [[ "$target" =~ ^(\.\./sites-available|${NGINX_SITES_AVAILABLE})/[A-Za-z0-9._-]+$ && "$target" != */.* ]] || return 1
  printf '%s' "$target"
}

# nginx-setup: nginx on NGINX_ADDRESS next to Apache on APACHE_ADDRESS. Run
# again, it writes the panel's settings anew. Everything goes back when a
# check fails.
dmp_nginx_setup() {
  dmp_nginx_require_installed
  local ports conf state link work first=0 apache_changed=0 default_off=0 was_active=0 was_enabled=0
  local -a conflicts=() users=()
  ports="$(dmp_apache_ports_file)"
  conf="$(dmp_nginx_conf)"
  state="$(dmp_nginx_state)"
  link="$NGINX_SITES_ENABLED/default"
  [[ -f "$ports" ]] || dmp_die "no $ports: is Apache installed?"
  if [[ -f "$conf" ]] && ! dmp_vhost_is_managed "$conf"; then
    dmp_die "$conf was not created by devmagic-panel; leaving it as is"
  fi
  mapfile -t conflicts < <(dmp_nginx_conflicts)
  if (( ${#conflicts[@]} > 0 )); then
    dmp_error "these nginx configs listen on port 80 or 443 on every address or on Apache's:"
    printf '   %s\n' "${conflicts[@]}" >&2
    dmp_die "make them listen on $NGINX_ADDRESS, or turn them off, then set nginx up again"
  fi
  mapfile -t users < <(dmp_nginx_port_users)
  if (( ${#users[@]} > 0 )); then
    dmp_die "port 80 or 443 is taken: ${users[*]}; stop it first"
  fi

  dmp_step "Setting nginx up on $NGINX_ADDRESS, next to Apache on $APACHE_ADDRESS"
  install -d -m 0755 "$state" "$(dirname "$conf")"
  # The original ports.conf, once: a later run starts from it again.
  if ! dmp_vhost_is_managed "$ports"; then
    cp -p "$ports" "$state/ports.conf"
    first=1
  fi
  [[ -f "$state/ports.conf" ]] || dmp_die "$ports is the panel's, but the original is gone from $state: put Apache's ports.conf back by hand"
  work="$(mktemp -d "$state/.setup.XXXXXX")"
  cp -p "$ports" "$work/ports.now"
  [[ ! -f "$conf" ]] || cp -p "$conf" "$work/conf.now"
  dmp_apache_ports_render "$state/ports.conf" > "$work/ports.new"
  # In subshells, so a refusal still clears the work folder.
  (dmp_apache_ports_check "$work/ports.new") || { rm -rf "${work:?}"; exit 1; }
  (dmp_nginx_conf_render > "$work/conf.new") || { rm -rf "${work:?}"; exit 1; }
  cmp -s "$work/ports.new" "$ports" || apache_changed=1
  systemctl is-active --quiet nginx && was_active=1
  systemctl is-enabled --quiet nginx 2>/dev/null && was_enabled=1

  dmp_nginx_setup_back() {
    cat "$work/ports.now" > "$ports"
    if [[ -f "$work/conf.now" ]]; then cp -p "$work/conf.now" "$conf"; else rm -f "${conf:?}"; fi
    if (( default_off )); then
      ln -s "$(head -n 1 "$state/default-site")" "$link"
      rm -f "${state:?}/default-site"
    fi
    (( first )) && rm -f "${state:?}/ports.conf"
    rm -rf "${work:?}"
  }

  # Debian's default site listens on every address; the link it had comes back with nginx-teardown.
  if [[ -L "$link" ]]; then
    readlink "$link" > "$state/default-site"
    rm -f "$link"
    default_off=1
  fi
  dmp_nginx_put "$ports" < "$work/ports.new"
  dmp_nginx_put "$conf" < "$work/conf.new"
  if ! dmp_apache_configtest; then
    dmp_nginx_setup_back
    dmp_die "Apache's configtest failed, nothing changed"
  fi
  if ! dmp_nginx_configtest; then
    dmp_nginx_setup_back
    dmp_die "nginx's configtest failed, nothing changed"
  fi

  # Apache lets go of every address before nginx takes its own.
  if (( apache_changed )); then
    systemctl stop nginx >/dev/null 2>&1 || true
    if ! systemctl restart apache2; then
      dmp_nginx_setup_back
      systemctl restart apache2 || true
      (( was_active )) && { systemctl start nginx || true; }
      dmp_die "Apache would not restart on $APACHE_ADDRESS, ports.conf is as it was"
    fi
  fi
  if ! systemctl enable nginx >/dev/null 2>&1 || ! systemctl restart nginx; then
    dmp_nginx_setup_back
    systemctl stop nginx >/dev/null 2>&1 || true
    (( was_enabled )) || systemctl disable nginx >/dev/null 2>&1 || true
    (( apache_changed )) && { systemctl restart apache2 || true; }
    dmp_die "nginx would not start on $NGINX_ADDRESS (journalctl -u nginx); everything is as it was"
  fi
  rm -rf "${work:?}"
  dmp_ok "nginx answers on $NGINX_ADDRESS and Apache on $APACHE_ADDRESS, both on ports 80 and 443"
}

# nginx-teardown: Apache back on every address, Debian's default nginx site
# back on, nginx stopped. Refused while a site runs on nginx.
dmp_nginx_teardown() {
  local ports conf state link work file target
  local -a sites=()
  ports="$(dmp_apache_ports_file)"
  conf="$(dmp_nginx_conf)"
  state="$(dmp_nginx_state)"
  link="$NGINX_SITES_ENABLED/default"
  if ! dmp_nginx_is_setup; then
    dmp_ok "nginx is not set up next to Apache"
    return 0
  fi
  for file in "$NGINX_SITES_AVAILABLE"/*; do
    [[ -f "$file" ]] && dmp_vhost_is_managed "$file" && sites+=("$(basename "$file" .conf)")
  done
  (( ${#sites[@]} == 0 )) || dmp_die "these sites run on nginx: ${sites[*]}; move them to Apache first"
  if dmp_vhost_is_managed "$ports" && [[ ! -f "$state/ports.conf" ]]; then
    dmp_die "the original ports.conf is gone from $state: put Apache's ports.conf back by hand"
  fi

  dmp_step "Turning nginx off; Apache answers on every address again"
  dmp_nginx_remoteip_remove
  work="$(mktemp -d "$state/.teardown.XXXXXX")"
  cp -p "$ports" "$work/ports.now"
  cp -p "$conf" "$work/conf.now"
  if dmp_vhost_is_managed "$ports"; then
    dmp_nginx_put "$ports" < "$state/ports.conf"
  fi
  rm -f "${conf:?}"
  if ! dmp_apache_configtest; then
    cat "$work/ports.now" > "$ports"
    cp -p "$work/conf.now" "$conf"
    rm -rf "${work:?}"
    dmp_die "Apache's configtest failed with its original ports.conf, nothing changed"
  fi
  systemctl stop nginx >/dev/null 2>&1 || true
  systemctl disable nginx >/dev/null 2>&1 || true
  if ! systemctl restart apache2; then
    cat "$work/ports.now" > "$ports"
    cp -p "$work/conf.now" "$conf"
    rm -rf "${work:?}"
    systemctl restart apache2 || true
    systemctl enable --now nginx >/dev/null 2>&1 || true
    dmp_die "Apache would not restart on every address, nginx is set up as it was"
  fi
  if target="$(dmp_nginx_default_target "$state/default-site")" && [[ ! -e "$link" && ! -L "$link" ]]; then
    ln -s "$target" "$link"
  fi
  rm -rf "${work:?}" "${state:?}"
  dmp_ok "nginx is stopped and Apache answers on every address again; sudo apt remove nginx removes nginx itself"
}

# ── Sites on nginx ───────────────────────────────────────────
#
# A site on nginx has the file sites-available/<domain>.conf with the panel's
# marker, linked from sites-enabled, and its hosts line on NGINX_ADDRESS
# (hosts-add reads where the site runs from these files). Its PHP goes
# through PHP-FPM only: the upstream dmp-php-<domain> in
# conf.d/devmagic-panel-php.conf points at the site's own pool, or at the
# default version's FPM (php-default once mod_php is off, else mod_php's).

DMP_NGINX_PHP_CONF_NAME="devmagic-panel-php.conf"
# The first nginx with the http2 directive; older ones take "listen ... ssl http2".
DMP_NGINX_HTTP2_DIRECTIVE="1.25.1"
# shellcheck disable=SC2034 # read by dmp-root, which checks --kind against it
DMP_NGINX_KINDS=(single subdirectory subdomain)

dmp_nginx_site_file() { printf '%s/%s.conf' "$NGINX_SITES_AVAILABLE" "$1"; }
dmp_nginx_site_link() { printf '%s/%s.conf' "$NGINX_SITES_ENABLED" "$1"; }
dmp_nginx_php_conf() { printf '%s/conf.d/%s' "$(dmp_nginx_dir)" "$DMP_NGINX_PHP_CONF_NAME"; }

# True when the site runs on nginx: the panel's file, enabled.
dmp_nginx_site_on() {
  local file
  file="$(dmp_nginx_site_file "$1")"
  [[ -f "$file" && -e "$(dmp_nginx_site_link "$1")" ]] && dmp_vhost_is_managed "$file"
}

# The domains of the panel's site files in sites-available, one per line.
dmp_nginx_sites() {
  local file domain
  for file in "$NGINX_SITES_AVAILABLE"/*.conf; do
    [[ -f "$file" ]] || continue
    dmp_vhost_is_managed "$file" || continue
    domain="$(basename "$file" .conf)"
    dmp_is_local_name "$domain" && printf '%s\n' "$domain"
  done
  return 0
}

# The PHP-FPM socket a folder's PHP goes to on nginx: its own pool's, else
# the default version's. Nothing when no FPM can run it.
dmp_nginx_php_socket() {
  local folder="$1" version
  if dmp_pools | awk -v f="$folder" '$2 == f { found = 1 } END { exit !found }'; then
    printf '%s/dmp-%s.sock' "$DMP_PHP_RUN_DIR" "$folder"
    return 0
  fi
  version="$(dmp_php_default || dmp_php_apache_version || true)"
  [[ -n "$version" && -e "$PHP_LIB_DIR/$version/sapi/fpm" ]] || return 1
  printf '%s/php%s-fpm.sock' "$DMP_PHP_RUN_DIR" "$version"
}

# Sites under paths of a site on nginx: "/learn=local.learn.shop.com"
# entries, each a folder in WEB_DIR. dmp-root sets them after checking each one.
DMP_NGINX_MOUNTS=()

# ── .htaccess rules on nginx ─────────────────────────────────
#
# The panel translates a site's .htaccess into rules of a few fixed kinds;
# dmp-root checks every field of each and writes the nginx directives itself,
# so no text from an .htaccess reaches nginx as it is (nginx opens log files
# as root: a free-form line could write any file). Each rule is kept in the
# site's file as a "# rule:" line, and each .htaccess it came from as a
# "# htaccess: /folder <sha256>" line, so the panel sees when one changed.
#
#   redirect <301|302> <regex> <target>   rewrite ... permanent|redirect
#   rewrite <regex> <path>                 rewrite ... last
#   deny <regex>                           location ~ <regex> { deny all; }
#   header set <Name> <value...>           add_header <Name> "<value>" always
#   header unset <Name>                    fastcgi_hide_header <Name>
#   error-page <code> <path>               error_page <code> <path>
DMP_NGINX_RULES=()
DMP_NGINX_SUMS=()
# shellcheck disable=SC2034 # read by dmp-root, which caps --rule at it
DMP_NGINX_MAX_RULES=500
# Headers a rule may set or unset: security, cross-origin and robots headers.
DMP_NGINX_HEADERS=(X-Frame-Options X-Content-Type-Options X-XSS-Protection Referrer-Policy Strict-Transport-Security
  Content-Security-Policy Content-Security-Policy-Report-Only Permissions-Policy Cross-Origin-Opener-Policy
  Cross-Origin-Embedder-Policy Cross-Origin-Resource-Policy Access-Control-Allow-Origin Access-Control-Allow-Methods
  Access-Control-Allow-Headers Access-Control-Allow-Credentials Access-Control-Expose-Headers X-Robots-Tag X-Powered-By)

# A regex nginx takes unquoted: no space, quote, brace, ; or #, and no
# backslash pair nginx would read as an escape of its own.
dmp_nginx_regex_ok() {
  local r="$1" re='^[][A-Za-z0-9/._~%^$*+?()|\,=:@!&-]+$'
  (( ${#r} <= 512 )) && [[ "$r" =~ $re ]] || return 1
  # shellcheck disable=SC1003 # the backslashes in single quotes are the literal text looked for
  [[ "$r" != *'\\'* && "$r" != *'\t'* && "$r" != *'\r'* && "$r" != *'\n'* && "$r" != *'\' ]]
}

# A redirect or rewrite target: a path, or an https or http address, with
# only $1 to $9 and a few of nginx's own variables in it.
dmp_nginx_target_ok() {
  # shellcheck disable=SC2016 # $ is a character of the target here, not an expansion
  local t="$1" rest re='^(https?://[a-z0-9.$_-]+(:[0-9]{1,5})?)?(/[A-Za-z0-9/._~%?&=+:@!,()*$-]*)?$'
  (( ${#t} <= 1024 )) && [[ -n "$t" && "$t" =~ $re ]] || return 1
  [[ "$t" == /* || "$t" == http://* || "$t" == https://* ]] || return 1
  # shellcheck disable=SC2016 # the $ names nginx variables, not shell ones
  rest="$(sed -E 's/\$([1-9]|host|scheme|request_uri|args|is_args)//g' <<< "$t")"
  [[ "$rest" != *'$'* ]]
}

# True for one rule of the kinds the comment at the top of this part lists.
dmp_nginx_rule_ok() {
  local rule="$1" kind a b c name printable='^[ -~]+$' LC_ALL=C
  [[ "$rule" =~ $printable ]] || return 1
  read -r kind a b c <<< "$rule"
  case "$kind" in
    redirect) [[ "$a" == 301 || "$a" == 302 ]] && dmp_nginx_regex_ok "$b" && dmp_nginx_target_ok "$c" && [[ "$rule" == "redirect $a $b $c" ]] ;;
    rewrite) [[ -z "$c" ]] && dmp_nginx_regex_ok "$a" && dmp_nginx_target_ok "$b" && [[ "$b" == /* && "$rule" == "rewrite $a $b" ]] ;;
    deny) [[ -z "$b" && "$rule" == "deny $a" ]] && dmp_nginx_regex_ok "$a" ;;
    error-page) [[ -z "$c" && "$a" =~ ^[45][0-9]{2}$ && "$b" =~ ^/[A-Za-z0-9/._-]*$ && "$rule" == "error-page $a $b" ]] ;;
    header)
      for name in "${DMP_NGINX_HEADERS[@]}"; do
        [[ "$b" == "$name" ]] || continue
        if [[ "$a" == unset ]]; then
          [[ -z "$c" && "$rule" == "header unset $b" ]]
          return
        fi
        # shellcheck disable=SC1003 # a backslash in single quotes is the literal character refused
        [[ "$a" == set && -n "$c" && "$rule" == "header set $b $c" && ${#c} -le 1024 && "$c" != *'"'* && "$c" != *'\'* && "$c" != *'$'* ]]
        return
      done
      return 1
      ;;
    *) return 1 ;;
  esac
}

# The directives of the rules: DMP_NGINX_RULE_SERVER (server level, in the
# order of the .htaccess) and DMP_NGINX_RULE_DENY (locations before PHP's).
dmp_nginx_rules_render() {
  local rule kind a b c
  DMP_NGINX_RULE_SERVER=""
  DMP_NGINX_RULE_DENY=""
  for rule in "${DMP_NGINX_RULES[@]}"; do
    read -r kind a b c <<< "$rule"
    case "$kind" in
      redirect) DMP_NGINX_RULE_SERVER+=$'\n'"    rewrite $b $c $([[ "$a" == 301 ]] && echo permanent || echo redirect);" ;;
      rewrite) DMP_NGINX_RULE_SERVER+=$'\n'"    rewrite $a $b last;" ;;
      deny) DMP_NGINX_RULE_DENY+=$'\n'"    location ~ $a {"$'\n'"        deny all;"$'\n'"    }" ;;
      error-page) DMP_NGINX_RULE_SERVER+=$'\n'"    error_page $a $b;" ;;
      header)
        if [[ "$a" == set ]]; then
          DMP_NGINX_RULE_SERVER+=$'\n'"    add_header $b \"${rule#"header set $b "}\" always;"
        else
          DMP_NGINX_RULE_SERVER+=$'\n'"    fastcgi_hide_header $b;"
        fi
        ;;
    esac
  done
  [[ -z "$DMP_NGINX_RULE_SERVER" ]] || DMP_NGINX_RULE_SERVER=$'\n'"    # The site's .htaccess rules, as the panel translated them."$DMP_NGINX_RULE_SERVER$'\n'
  [[ -z "$DMP_NGINX_RULE_DENY" ]] || DMP_NGINX_RULE_DENY=$'\n'"    # Denied by the site's .htaccess files."$DMP_NGINX_RULE_DENY
  return 0
}

# The folders of the sites on nginx: each site's, then the ones it serves
# under paths (its "# mount:" lines), one per line.
dmp_nginx_php_folders() {
  local domain spec folder
  while IFS= read -r domain; do
    # A site with nginx in front of Apache runs on Apache's PHP.
    dmp_nginx_front_file "$(dmp_nginx_site_file "$domain")" && continue
    printf '%s\n' "$domain"
    while IFS= read -r spec; do
      folder="${spec#*=}"
      dmp_is_local_name "$folder" && printf '%s\n' "$folder"
    done < <(sed -nE 's/^# mount: (\/[A-Za-z0-9._\/-]+=[a-z0-9.-]+)$/\1/p' "$(dmp_nginx_site_file "$domain")")
  done < <(dmp_nginx_sites)
}

# conf.d/devmagic-panel-php.conf: one upstream per site on nginx, and per site under one of its paths.
dmp_nginx_php_render() {
  local domain socket
  printf '%s\n' "$DMP_VHOST_MARKER"
  printf '# The PHP of each site on nginx: its own PHP-FPM pool, or the default version'\''s.\n'
  # Sites with nginx in front of Apache: their Apache vhost, on HTTPS with the site's name, connections kept open.
  printf 'upstream dmp-apache {\n    server %s:443;\n    keepalive 16;\n}\n' "$APACHE_ADDRESS"
  while IFS= read -r domain; do
    if socket="$(dmp_nginx_php_socket "$domain")"; then
      printf 'upstream dmp-php-%s {\n    server unix:%s;\n}\n' "$domain" "$socket"
    else
      # No FPM for it: nginx still starts, and the site answers 502 until there is one.
      printf '# %s: no PHP-FPM for its PHP version\nupstream dmp-php-%s {\n    server unix:%s/dmp-none.sock down;\n}\n' "$domain" "$domain" "$DMP_PHP_RUN_DIR"
    fi
  done < <(dmp_nginx_php_folders | awk '!seen[$0]++')
}

# Writes the upstreams and runs nginx -t; returns 1 with the previous file back when it fails.
dmp_nginx_php_write() {
  local conf previous=""
  dmp_nginx_is_setup || return 0
  conf="$(dmp_nginx_php_conf)"
  if [[ -f "$conf" ]]; then
    previous="$(mktemp "$(dirname "$conf")/.dmp-php.prev.XXXXXX")"
    cp -p "$conf" "$previous"
  fi
  dmp_nginx_php_render | dmp_nginx_put "$conf"
  if ! dmp_nginx_configtest; then
    if [[ -n "$previous" ]]; then mv -f "$previous" "$conf"; else rm -f "${conf:?}"; fi
    return 1
  fi
  [[ -z "$previous" ]] || rm -f "${previous:?}"
  return 0
}

# Reloads nginx when it runs; the caller ran nginx -t.
dmp_nginx_reload_if_active() {
  systemctl is-active --quiet nginx || return 0
  systemctl reload nginx || dmp_die "nginx reload failed: journalctl -u nginx"
}

# Usage: dmp_nginx_site_render <domain> <kind> <uploads-proxy-host or ""> [alias...]
dmp_nginx_site_render() {
  local domain="$1" kind="$2" proxy="$3" version names listen443 http2="" rewrites="" uploads="" mounts="" headers="" mount at dir folder
  shift 3
  for mount in "${DMP_NGINX_MOUNTS[@]}"; do
    at="${mount%%=*}"
    folder="${mount#*=}"
    dir="$WEB_DIR/$folder"
    headers+=$'\n'"# mount: $at=$folder"
    mounts+=$'\n'"    # A site of its own, served under $at, with its own PHP."
    mounts+=$'\n'"    location = $at {"
    mounts+=$'\n'"        return 301 https://\$host$at/;"
    mounts+=$'\n'"    }"
    mounts+=$'\n'"    location ^~ $at/ {"
    mounts+=$'\n'"        alias $dir/;"
    mounts+=$'\n'"        index index.php index.html;"
    mounts+=$'\n'"        location ~ /\.(?!well-known/) {"
    mounts+=$'\n'"            deny all;"
    mounts+=$'\n'"        }"
    mounts+=$'\n'"        location ~* ^$at/wp-content/uploads/.*\.php\$ {"
    mounts+=$'\n'"            deny all;"
    mounts+=$'\n'"        }"
    mounts+=$'\n'"        location ~ \.php\$ {"
    mounts+=$'\n'"            if (!-f \$request_filename) {"
    mounts+=$'\n'"                return 404;"
    mounts+=$'\n'"            }"
    mounts+=$'\n'"            include fastcgi_params;"
    mounts+=$'\n'"            fastcgi_param SCRIPT_FILENAME \$request_filename;"
    mounts+=$'\n'"            fastcgi_pass dmp-php-$folder;"
    mounts+=$'\n'"        }"
    # A missing file goes to WordPress through a named location: try_files
    # with alias does not take a URI as its last choice.
    mounts+=$'\n'"        try_files \$uri \$uri/ @dmp-$folder;"
    mounts+=$'\n'"    }"
    mounts+=$'\n'"    location @dmp-$folder {"
    mounts+=$'\n'"        rewrite ^ $at/index.php last;"
    mounts+=$'\n'"    }"$'\n'
  done
  for mount in "${DMP_NGINX_SUMS[@]}"; do
    headers+=$'\n'"# htaccess: ${mount%=*} ${mount##*=}"
  done
  for mount in "${DMP_NGINX_RULES[@]}"; do
    headers+=$'\n'"# rule: $mount"
  done
  dmp_nginx_rules_render
  names="$domain${*:+ $*}"
  version="$(dmp_nginx_version)"
  if [[ -n "$version" ]] && dmp_version_at_least "$version" "$DMP_NGINX_HTTP2_DIRECTIVE"; then
    listen443="listen $NGINX_ADDRESS:443 ssl;"
    http2=$'\n'"    http2 on;"
  else
    listen443="listen $NGINX_ADDRESS:443 ssl http2;"
  fi
  if [[ "$kind" == subdirectory ]]; then
    # WordPress's rules for a network whose sites live under paths, any
    # number of folders deep (/learn/potions/): WordPress's own rule strips
    # one folder only, so a site two deep would get 404 for its core files.
    rewrites=$'\n'"    # A network whose sites live under paths, one folder deep or more: /site/wp-admin, /a/site/wp-includes and the rest go to WordPress's own files."
    rewrites+=$'\n'"    if (!-e \$request_filename) {"
    rewrites+=$'\n'"        rewrite /wp-admin\$ \$scheme://\$host\$uri/ permanent;"
    rewrites+=$'\n'"        rewrite ^/(?:[^/]+/)+?(wp-(?:admin|includes|content)/.*|wp-[a-z-]+\\.php)\$ /\$1 last;"
    rewrites+=$'\n'"        rewrite ^/(?:[^/]+/)+?(xmlrpc\\.php)\$ /\$1 last;"
    rewrites+=$'\n'"        rewrite ^(/[^/]+)?(/.*\\.php) \$2 last;"
    rewrites+=$'\n'"    }"$'\n'
  fi
  if [[ -n "$proxy" ]]; then
    uploads=$'\n'"    # Uploads missing locally load from production."
    uploads+=$'\n'"    location ^~ /wp-content/uploads/ {"
    uploads+=$'\n'"        location ~ \\.php\$ { deny all; }"
    uploads+=$'\n'"        try_files \$uri @dmp_uploads;"
    uploads+=$'\n'"    }"
    uploads+=$'\n'"    location @dmp_uploads {"
    uploads+=$'\n'"        return 302 https://$proxy\$request_uri;"
    uploads+=$'\n'"    }"$'\n'
  fi
  cat <<EOF
$DMP_VHOST_MARKER
# kind: $kind$headers
server {
    listen $NGINX_ADDRESS:80;
    server_name $names;
    return 301 https://\$host\$request_uri;
}

server {
    $listen443$http2
    server_name $names;
    root $(dmp_site_folder "$domain");
    index index.php index.html;

    ssl_certificate $(dmp_cert_file "$domain");
    ssl_certificate_key $(dmp_cert_key_file "$domain");

    access_log $NGINX_LOG_DIR/$domain-access.log;
    error_log $NGINX_LOG_DIR/$domain-error.log;
$DMP_NGINX_RULE_SERVER
    # Never served: .htaccess, .git and the like, but .well-known.
    location ~ /\.(?!well-known/) {
        deny all;
    }
    # PHP never runs from uploads.
    location ~* ^/wp-content/uploads/.*\.php\$ {
        deny all;
    }$DMP_NGINX_RULE_DENY
$uploads$rewrites$mounts
    location / {
        try_files \$uri \$uri/ /index.php?\$args;
    }

    location ~ \.php\$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass dmp-php-$domain;
    }
}
EOF
}

# The names in a hosts line outside the panel's block, among the given ones.
# glibc answers with the first line naming a host, so one of those keeps the
# panel's line from deciding where the site goes.
dmp_hosts_outside_block() {
  local line state=before name field
  local -a fields
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$DMP_HOSTS_BEGIN" ]]; then state=block; continue; fi
    if [[ "$line" == "$DMP_HOSTS_END" ]]; then state=after; continue; fi
    [[ "$state" == block ]] && continue
    line="${line%%#*}"
    read -r -a fields <<< "$line"
    (( ${#fields[@]} > 1 )) || continue
    for name in "$@"; do
      for field in "${fields[@]:1}"; do
        [[ "$field" == "$name" ]] && printf '%s\n' "$name"
      done
    done
  done < "$HOSTS_FILE"
  return 0
}

# Refuses a site whose PHP has no PHP-FPM to run on nginx.
dmp_nginx_socket_or_die() {
  dmp_nginx_php_socket "$1" >/dev/null && return 0
  dmp_die "$1 has no PHP-FPM to run on: install PHP-FPM for the PHP version sites run (apt install php<version>-fpm)"
}

# nginx-site-write <domain> <kind> <uploads-proxy-host or ""> [alias...]:
# the site on nginx, with these names, its folder WEB_DIR/<domain> and its
# certificate; then nginx -t and a reload, or the file as it was.
dmp_nginx_site_write() {
  local domain="$1" kind="$2" proxy="$3" file link apache previous="" tmp outside
  shift 3
  local -a aliases
  mapfile -t aliases < <(dmp_unique_aliases "$domain" "$@")
  dmp_nginx_is_setup || dmp_die "nginx is not set up next to Apache: run dmp-root nginx-setup first"
  [[ "$domain" != "$PANEL_DOMAIN" ]] || dmp_usage_error "the panel's own site stays on Apache"
  [[ -d "$(dmp_site_folder "$domain")" && ! -L "$(dmp_site_folder "$domain")" ]] || dmp_die "no site folder $(dmp_site_folder "$domain")"
  [[ -f "$(dmp_cert_file "$domain")" ]] || dmp_die "no certificate for $domain yet, run: dmp-root cert-issue $domain"
  # A site whose vhost was made by hand stays on Apache, as it is.
  for apache in "$APACHE_SITES_AVAILABLE/$domain-ssl.conf" "$APACHE_SITES_AVAILABLE/$domain.conf"; do
    dmp_vhost_require_managed "$apache"
  done
  outside="$(dmp_hosts_outside_block "$domain" "${aliases[@]}" | sort -u | tr '\n' ' ')"
  [[ -z "$outside" ]] || dmp_die "${outside% } in $HOSTS_FILE outside the panel's block would keep the site on Apache; remove that line first"
  dmp_nginx_socket_or_die "$domain"
  local mount
  for mount in "${DMP_NGINX_MOUNTS[@]}"; do
    dmp_nginx_socket_or_die "${mount#*=}"
  done

  file="$(dmp_nginx_site_file "$domain")"
  link="$(dmp_nginx_site_link "$domain")"
  dmp_vhost_require_managed "$file"
  dmp_step "Writing the nginx site for $domain"
  install -d -m 0755 "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED" "$NGINX_LOG_DIR"
  if [[ -f "$file" ]]; then
    previous="$(mktemp "$NGINX_SITES_AVAILABLE/.$domain.prev.XXXXXX")"
    cp -p "$file" "$previous"
  fi
  tmp="$(mktemp "$NGINX_SITES_AVAILABLE/.$domain.XXXXXX")"
  dmp_nginx_site_render "$domain" "$kind" "$proxy" "${aliases[@]}" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
  ln -sfn "$file" "$link"
  if ! dmp_nginx_php_write; then
    if [[ -n "$previous" ]]; then
      mv -f "$previous" "$file"
    else
      rm -f "${file:?}" "${link:?}"
    fi
    dmp_nginx_php_write >/dev/null 2>&1 || true
    dmp_die "nginx refused the site for $domain; it is as it was"
  fi
  [[ -z "$previous" ]] || rm -f "${previous:?}"
  dmp_nginx_reload_if_active
  dmp_ok "nginx site enabled: $file"
}

# nginx-site-remove <domain>: the site leaves nginx (only the panel's file).
dmp_nginx_site_remove() {
  local domain="$1" file
  file="$(dmp_nginx_site_file "$domain")"
  if [[ ! -f "$file" ]]; then
    dmp_ok "no nginx site for $domain"
    return 0
  fi
  dmp_vhost_require_managed "$file"
  dmp_step "Removing the nginx site for $domain"
  rm -f "$(dmp_nginx_site_link "$domain")" "${file:?}"
  dmp_nginx_php_write || dmp_die "nginx -t failed after taking $domain out"
  dmp_nginx_reload_if_active
  dmp_ok "nginx site removed for $domain"
}

# ── nginx in front of Apache ─────────────────────────────────
#
# A site can also keep its Apache vhost and have nginx in front of it, as
# hosts that run both do: nginx answers on NGINX_ADDRESS with the site's
# certificate and sends requests to the vhost on APACHE_ADDRESS over HTTPS,
# with the site's name, so Apache reads every .htaccess and runs the site's
# PHP as before. Its file is sites-available/<domain>.conf with the marker
# and "# mode: apache". With "# static: on" nginx serves images, CSS, JS and
# fonts itself, but in the folders of "# apache-path:" lines (folders with
# an .htaccess of their own), and a missing file goes to Apache.

# What nginx serves itself in front of Apache; anything else goes to Apache.
DMP_NGINX_STATIC_EXT='css|js|mjs|map|jpe?g|png|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|pdf'
DMP_REMOTEIP_CONF_NAME="devmagic-panel-remoteip.conf"
# Folders with an .htaccess of their own, which always go to Apache. dmp-root sets them after checking each one.
DMP_NGINX_APACHE_PATHS=()

dmp_remoteip_conf() { printf '%s/conf-available/%s' "$(dmp_apache_dir)" "$DMP_REMOTEIP_CONF_NAME"; }

# True when the file is the panel's nginx file of a site with nginx in front of Apache.
dmp_nginx_front_file() { [[ -f "$1" ]] && dmp_vhost_is_managed "$1" && grep -qx '# mode: apache' "$1"; }
dmp_nginx_front_on() { dmp_nginx_front_file "$(dmp_nginx_site_file "$1")"; }

# Apache logs and PHP see the visitor's address, not nginx's: X-Forwarded-For,
# trusted from NGINX_ADDRESS only. Written with the first site in front of
# Apache; nginx-teardown takes it out again, and the module when it turned it on.
dmp_nginx_remoteip_ensure() {
  local conf name state
  conf="$(dmp_remoteip_conf)"
  name="${DMP_REMOTEIP_CONF_NAME%.conf}"
  state="$(dmp_nginx_state)"
  if [[ -f "$conf" ]] && grep -qx "    RemoteIPInternalProxy $NGINX_ADDRESS" "$conf" && [[ -e "$(dmp_apache_dir)/conf-enabled/$DMP_REMOTEIP_CONF_NAME" ]]; then
    return 0
  fi
  dmp_vhost_require_managed "$conf"
  install -d -m 0755 "$(dirname "$conf")" "$state"
  if [[ ! -e "$(dmp_apache_dir)/mods-enabled/remoteip.load" ]]; then
    a2enmod -q remoteip >/dev/null || dmp_die "a2enmod remoteip failed"
    : > "$state/remoteip-module"
  fi
  {
    printf '%s\n' "$DMP_VHOST_MARKER"
    printf '# nginx answers in front of Apache for some sites: Apache sees the visitor'\''s\n'
    printf '# address from X-Forwarded-For, only when nginx (%s) sends it.\n' "$NGINX_ADDRESS"
    printf '<IfModule remoteip_module>\n    RemoteIPHeader X-Forwarded-For\n    RemoteIPInternalProxy %s\n</IfModule>\n' "$NGINX_ADDRESS"
  } | dmp_nginx_put "$conf"
  a2enconf -q "$name" >/dev/null || dmp_die "a2enconf $name failed"
  if ! dmp_apache_configtest; then
    a2disconf -q "$name" >/dev/null 2>&1 || true
    rm -f "${conf:?}"
    dmp_die "Apache's configtest failed with the remoteip settings; they are taken out"
  fi
  dmp_apache_reload
}

# nginx-teardown: the remoteip settings go, and the module when the panel turned it on.
dmp_nginx_remoteip_remove() {
  local conf
  conf="$(dmp_remoteip_conf)"
  [[ -f "$conf" ]] && dmp_vhost_is_managed "$conf" || return 0
  a2disconf -q "${DMP_REMOTEIP_CONF_NAME%.conf}" >/dev/null 2>&1 || true
  rm -f "${conf:?}"
  if [[ -f "$(dmp_nginx_state)/remoteip-module" ]]; then
    a2dismod -q remoteip >/dev/null 2>&1 || true
  fi
}

# Usage: dmp_nginx_front_render <domain> <on|off> [alias...]
dmp_nginx_front_render() {
  local domain="$1" static="$2" version names listen443 http2="" headers="" locations="" at
  shift 2
  names="$domain${*:+ $*}"
  version="$(dmp_nginx_version)"
  if [[ -n "$version" ]] && dmp_version_at_least "$version" "$DMP_NGINX_HTTP2_DIRECTIVE"; then
    listen443="listen $NGINX_ADDRESS:443 ssl;"
    http2=$'\n'"    http2 on;"
  else
    listen443="listen $NGINX_ADDRESS:443 ssl http2;"
  fi
  if [[ "$static" == on ]]; then
    for at in "${DMP_NGINX_APACHE_PATHS[@]}"; do
      headers+=$'\n'"# apache-path: $at"
      locations+=$'\n'"    location ^~ $at/ {"
      locations+=$'\n'"        proxy_pass https://dmp-apache;"
      locations+=$'\n'"    }"
    done
    [[ -z "$locations" ]] || locations=$'\n'"    # Folders with an .htaccess of their own: Apache, files and all.$locations"
    locations+=$'\n'"    # Dot files: Apache decides, as it would on its own."
    locations+=$'\n'"    location ~ /\\. {"
    locations+=$'\n'"        proxy_pass https://dmp-apache;"
    locations+=$'\n'"    }"
    locations+=$'\n'"    # Images, CSS, JS and fonts that exist come from nginx; a missing one goes to Apache."
    locations+=$'\n'"    location ~* \\.(?:$DMP_NGINX_STATIC_EXT)\$ {"
    locations+=$'\n'"        try_files \$uri @dmp-apache;"
    locations+=$'\n'"    }"
    locations+=$'\n'"    location @dmp-apache {"
    locations+=$'\n'"        proxy_pass https://dmp-apache;"
    locations+=$'\n'"    }"$'\n'
  fi
  cat <<EOF
$DMP_VHOST_MARKER
# mode: apache
# static: $static$headers
server {
    listen $NGINX_ADDRESS:80;
    server_name $names;
    return 301 https://\$host\$request_uri;
}

server {
    $listen443$http2
    server_name $names;
    root $(dmp_site_folder "$domain");

    ssl_certificate $(dmp_cert_file "$domain");
    ssl_certificate_key $(dmp_cert_key_file "$domain");

    access_log $NGINX_LOG_DIR/$domain-access.log;
    error_log $NGINX_LOG_DIR/$domain-error.log;

    # Requests go to the site's Apache vhost, which reads .htaccess and runs its PHP.
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_ssl_server_name on;
    proxy_ssl_name \$host;
    proxy_redirect off;
    proxy_buffers 16 16k;
    proxy_buffer_size 32k;
    # Imports and step debugging run as long as PHP lets them.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
$locations
    location / {
        proxy_pass https://dmp-apache;
    }
}
EOF
}

# The settings a front file was written with: its "static" and "apache-path" lines, each checked again.
dmp_nginx_front_settings() {
  local file="$1" domain="$2" line
  DMP_NGINX_APACHE_PATHS=()
  DMP_NGINX_FRONT_STATIC=on
  grep -qx '# static: off' "$file" && DMP_NGINX_FRONT_STATIC=off
  while IFS= read -r line; do
    dmp_nginx_apache_path_ok "$domain" "$line" && DMP_NGINX_APACHE_PATHS+=("$line")
  done < <(sed -nE 's/^# apache-path: (\/[A-Za-z0-9._\/-]+)$/\1/p' "$file")
  return 0
}

# A folder of the site, no link on the way, with an .htaccess of its own.
dmp_nginx_apache_path_ok() {
  local domain="$1" at="$2" dir real
  [[ "$at" =~ ^(/[A-Za-z0-9._-]+)+$ && "$at/" != */./* && "$at/" != */../* ]] || return 1
  dir="$(dmp_site_folder "$domain")$at"
  [[ -d "$dir" && -f "$dir/.htaccess" ]] || return 1
  real="$(realpath -e -- "$dir" 2>/dev/null)" || return 1
  [[ "$real" == "$dir" ]]
}

# nginx-site-write <domain> --upstream apache [--static on|off] [--apache-path /path]... [alias...]:
# nginx in front of the site's Apache vhost, which must be the panel's and
# enabled; then nginx -t and a reload, or the file as it was.
dmp_nginx_front_write() {
  local domain="$1" static="$2" file link apache previous="" tmp outside
  shift 2
  local -a aliases
  mapfile -t aliases < <(dmp_unique_aliases "$domain" "$@")
  dmp_nginx_is_setup || dmp_die "nginx is not set up next to Apache: run dmp-root nginx-setup first"
  [[ "$domain" != "$PANEL_DOMAIN" ]] || dmp_usage_error "the panel's own site stays on Apache"
  [[ -d "$(dmp_site_folder "$domain")" && ! -L "$(dmp_site_folder "$domain")" ]] || dmp_die "no site folder $(dmp_site_folder "$domain")"
  [[ -f "$(dmp_cert_file "$domain")" ]] || dmp_die "no certificate for $domain yet, run: dmp-root cert-issue $domain"
  apache="$APACHE_SITES_AVAILABLE/$domain-ssl.conf"
  [[ -f "$apache" ]] || dmp_die "no Apache vhost for $domain: nginx in front of Apache needs it, run: dmp-root vhost-write $domain"
  dmp_vhost_is_managed "$apache" || dmp_die "$apache was not created by devmagic-panel; the site stays on Apache as it is"
  [[ -e "$APACHE_SITES_ENABLED/$domain-ssl.conf" ]] || dmp_die "the Apache vhost of $domain is not enabled"
  outside="$(dmp_hosts_outside_block "$domain" "${aliases[@]}" | sort -u | tr '\n' ' ')"
  [[ -z "$outside" ]] || dmp_die "${outside% } in $HOSTS_FILE outside the panel's block would keep the site on Apache; remove that line first"

  file="$(dmp_nginx_site_file "$domain")"
  link="$(dmp_nginx_site_link "$domain")"
  dmp_vhost_require_managed "$file"
  dmp_nginx_remoteip_ensure
  dmp_step "Writing nginx in front of Apache for $domain"
  install -d -m 0755 "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED" "$NGINX_LOG_DIR"
  if [[ -f "$file" ]]; then
    previous="$(mktemp "$NGINX_SITES_AVAILABLE/.$domain.prev.XXXXXX")"
    cp -p "$file" "$previous"
  fi
  tmp="$(mktemp "$NGINX_SITES_AVAILABLE/.$domain.XXXXXX")"
  dmp_nginx_front_render "$domain" "$static" "${aliases[@]}" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
  ln -sfn "$file" "$link"
  # The upstreams: dmp-apache, and none for this site's PHP any more.
  if ! dmp_nginx_php_write; then
    if [[ -n "$previous" ]]; then
      mv -f "$previous" "$file"
    else
      rm -f "${file:?}" "${link:?}"
    fi
    dmp_nginx_php_write >/dev/null 2>&1 || true
    dmp_die "nginx refused the site for $domain; it is as it was"
  fi
  [[ -z "$previous" ]] || rm -f "${previous:?}"
  dmp_nginx_reload_if_active
  dmp_ok "nginx answers for $domain in front of Apache: $file"
}

# After vhost-write: the front file takes the vhost's names, with the settings it has.
dmp_nginx_front_refresh() {
  local domain="$1"
  shift
  dmp_nginx_front_on "$domain" || return 0
  dmp_nginx_front_settings "$(dmp_nginx_site_file "$domain")" "$domain"
  dmp_nginx_front_write "$domain" "$DMP_NGINX_FRONT_STATIC" "$@"
}
