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
  printf '# Long local names, like local.shop.acme.com.\n'
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
