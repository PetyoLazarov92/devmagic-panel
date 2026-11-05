# shellcheck shell=bash
# Apache virtual hosts. Based on devmagic includes/mkconfig-ssl.sh, changed so
# that both blocks share one alias list, HTTP redirects keep the requested
# host, every site logs to its own files, and a failed configtest restores
# the previous file instead of leaving Apache broken.
#
# Existing vhosts are left as is: the panel only rewrites or removes a file
# whose first line is its own marker. Sites set up by hand or by devmagic keep
# their vhost; the panel still reissues their cert and manages their hosts line.

DMP_VHOST_MARKER="# Managed by devmagic-panel. Edits here are overwritten."
# Where the panel's vhost serves PHP's info script (INFO_PATH in server/src/php/info.ts).
DMP_PHP_INFO_PATH="/.devmagic-panel-php"

dmp_vhost_file() { printf '%s/%s-ssl.conf' "$APACHE_SITES_AVAILABLE" "$1"; }

dmp_vhost_is_managed() {
  local line=""
  IFS= read -r line < "$1" || true
  [[ "$line" == "$DMP_VHOST_MARKER" ]]
}

# Refuses to touch an existing vhost the panel did not create.
dmp_vhost_require_managed() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  dmp_vhost_is_managed "$file" || dmp_die "$file was not created by devmagic-panel; leaving it as is"
}

# Sites served under a path of the vhost's domain: "/learn=local.learn.shop.com"
# entries, each a folder in WEB_DIR. dmp-root sets them after checking each one.
DMP_VHOST_MOUNTS=()

# Usage: dmp_vhost_render_site <domain> <uploads-proxy-host or ""> [alias...]
# Renders the mounts in DMP_VHOST_MOUNTS as an Alias each.
dmp_vhost_render_site() {
  local domain="$1" proxy="$2"
  shift 2
  local docroot="$WEB_DIR/$domain" alias_line="" proxy_block="" mount_block="" mount at dir
  (( $# > 0 )) && alias_line="    ServerAlias $*"$'\n'
  for mount in "${DMP_VHOST_MOUNTS[@]}"; do
    at="${mount%%=*}"
    dir="$WEB_DIR/${mount#*=}"
    mount_block+=$'\n'"    # A site of its own, served under $at."
    mount_block+=$'\n'"    Alias $at $dir"
    mount_block+=$'\n'"    <Directory $dir>"
    mount_block+=$'\n'"        Options FollowSymLinks"
    mount_block+=$'\n'"        AllowOverride All"
    mount_block+=$'\n'"        Require all granted"
    mount_block+=$'\n'"    </Directory>"$'\n'
  done
  if [[ -n "$proxy" ]]; then
    proxy_block=$'\n\n'"    # Uploads missing locally load from production."
    proxy_block+=$'\n'"    RewriteEngine On"
    proxy_block+=$'\n'"    RewriteCond %{REQUEST_URI} ^/wp-content/uploads/"
    proxy_block+=$'\n'"    RewriteCond %{DOCUMENT_ROOT}%{REQUEST_URI} !-f"
    proxy_block+=$'\n'"    RewriteRule ^/?(.*)\$ https://$proxy/\$1 [R=302,L]"
  fi
  cat <<EOF
$DMP_VHOST_MARKER
<VirtualHost *:80>
    ServerName $domain
${alias_line}    RewriteEngine On
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>

<VirtualHost *:443>
    ServerName $domain
${alias_line}    DocumentRoot $docroot

    <Directory $docroot>
        Options FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>
${mount_block}
    SSLEngine on
    SSLCertificateFile $(dmp_cert_file "$domain")
    SSLCertificateKeyFile $(dmp_cert_key_file "$domain")

    ErrorLog \${APACHE_LOG_DIR}/$domain-error.log
    CustomLog \${APACHE_LOG_DIR}/$domain-access.log combined$proxy_block
</VirtualHost>
EOF
}

dmp_vhost_render_panel() {
  local domain="$PANEL_DOMAIN" port="$PANEL_PORT"
  cat <<EOF
$DMP_VHOST_MARKER
<VirtualHost *:80>
    ServerName $domain

    # PHP's view of itself for the panel's PHP tab, to this computer only:
    # info.php is mod_php, <pool>/info.php an FPM pool (devmagic-panel-php.conf).
    Alias $DMP_PHP_INFO_PATH/info.php $DMP_HOME/php/info.php
    AliasMatch "^/\.devmagic-panel-php/[a-z0-9.-]+/info\.php\z" $DMP_HOME/php/info.php
    <Directory $DMP_HOME/php>
        Require local
        Options None
        AllowOverride None
    </Directory>

    RewriteEngine On
    RewriteRule "^/\.devmagic-panel-php/" - [L]
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>

<VirtualHost *:443>
    ServerName $domain

    SSLEngine on
    SSLCertificateFile $(dmp_cert_file "$domain")
    SSLCertificateKeyFile $(dmp_cert_key_file "$domain")

    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    ProxyPass /api/ws ws://127.0.0.1:$port/api/ws
    ProxyPass / http://127.0.0.1:$port/
    ProxyPassReverse / http://127.0.0.1:$port/

    ErrorLog \${APACHE_LOG_DIR}/$domain-error.log
    CustomLog \${APACHE_LOG_DIR}/$domain-access.log combined
</VirtualHost>
EOF
}

# Writes the vhost from stdin, enables it, runs configtest and reloads.
# On a failed configtest the previous file (or no file) is restored.
dmp_vhost_install() {
  local domain="$1" file previous="" tmp
  file="$(dmp_vhost_file "$domain")"
  dmp_vhost_require_managed "$file"
  install -d -m 0755 "$APACHE_SITES_AVAILABLE"
  tmp="$(mktemp "$APACHE_SITES_AVAILABLE/.$domain.XXXXXX")"
  cat > "$tmp"
  chmod 0644 "$tmp"

  if [[ -f "$file" ]]; then
    previous="$(mktemp "$APACHE_SITES_AVAILABLE/.$domain.prev.XXXXXX")"
    cp -p "$file" "$previous"
  fi
  mv "$tmp" "$file"
  a2ensite -q "$domain-ssl.conf" >/dev/null || dmp_die "a2ensite $domain-ssl.conf failed"

  if ! dmp_apache_configtest; then
    if [[ -n "$previous" ]]; then
      mv "$previous" "$file"
      dmp_warn "restored the previous vhost for $domain"
    else
      a2dissite -q "$domain-ssl.conf" >/dev/null || true
      rm -f "$file"
      dmp_warn "removed the new vhost for $domain"
    fi
    dmp_die "vhost for $domain was not applied"
  fi
  [[ -n "$previous" ]] && rm -f "$previous"
  systemctl reload apache2 || dmp_die "apache reload failed"
  dmp_ok "vhost enabled: $file"
}

# Usage: dmp_vhost_write_site <domain> <uploads-proxy-host or ""> [alias...]
dmp_vhost_write_site() {
  local domain="$1" proxy="$2"
  shift 2
  local -a aliases
  mapfile -t aliases < <(dmp_unique_aliases "$domain" "$@")
  [[ -f "$(dmp_cert_file "$domain")" ]] || dmp_die "no certificate for $domain yet, run: dmp-root cert-issue $domain"
  dmp_step "Writing vhost for $domain"
  dmp_vhost_render_site "$domain" "$proxy" "${aliases[@]}" | dmp_vhost_install "$domain"
}

dmp_vhost_write_panel() {
  [[ -f "$(dmp_cert_file "$PANEL_DOMAIN")" ]] || dmp_die "no certificate for $PANEL_DOMAIN yet"
  dmp_step "Writing panel vhost for $PANEL_DOMAIN"
  dmp_vhost_render_panel | dmp_vhost_install "$PANEL_DOMAIN"
}

dmp_vhost_remove() {
  local domain="$1" file
  file="$(dmp_vhost_file "$domain")"
  if [[ ! -f "$file" ]]; then
    dmp_ok "no vhost for $domain"
    return 0
  fi
  dmp_vhost_require_managed "$file"
  dmp_step "Removing vhost for $domain"
  a2dissite -q "$domain-ssl.conf" >/dev/null || true
  rm -f "$file"
  dmp_apache_reload
}
