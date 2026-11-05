#!/usr/bin/env bats

load helpers

setup() { setup_tree; }

@test "usage errors exit 2" {
  run dmp
  [ "$status" -eq 2 ]
  run dmp nope
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown command"* ]]
}

@test "rejects names that are not clearly local" {
  for bad in example.com google.com LOCAL.Upper.com "local.a b.com" "../etc" local "local.-x.com" "local.x.com;rm"; do
    run dmp hosts-add "$bad"
    [ "$status" -eq 2 ]
  done
  run dmp hosts-add local.ok.com real.example.com
  [ "$status" -eq 2 ]
}

@test "accepts local, test and localhost names" {
  run dmp hosts-add local.site.com www.local.site.com shop.test app.localhost
  [ "$status" -eq 0 ]
}

@test "refuses a config with unknown keys or shell syntax" {
  echo 'EVIL=$(id)' >> "$DMP_CONFIG"
  run dmp hosts-add local.site.com
  [ "$status" -eq 1 ]
  [[ "$output" == *"invalid line"* ]]
}

@test "ca-create makes a root-only key and is idempotent" {
  run dmp ca-create
  [ "$status" -eq 0 ]
  [ "$(stat -c %a "$T/certs/devmagic-panel-ca/ca.key")" = 600 ]
  before="$(sha256sum "$T/certs/devmagic-panel-ca/ca.pem")"
  run dmp ca-create
  [ "$status" -eq 0 ]
  [[ "$output" == *"already exists"* ]]
  [ "$(sha256sum "$T/certs/devmagic-panel-ca/ca.pem")" = "$before" ]
  openssl x509 -in "$T/certs/devmagic-panel-ca/ca.pem" -noout -ext basicConstraints | grep -q 'CA:TRUE'
}

@test "ca-trust installs the CA into the system store" {
  dmp ca-create
  run dmp ca-trust
  [ "$status" -eq 0 ]
  [ -f "$T/system-ca/devmagic-panel-ca.crt" ]
  grep -q '^update-ca-certificates' "$STUB_LOG"
}

@test "ca-untrust-legacy removes only LocalhostCA" {
  touch "$T/system-ca/LocalhostCA.crt" "$T/system-ca/other.crt"
  run dmp ca-untrust-legacy
  [ "$status" -eq 0 ]
  [ ! -e "$T/system-ca/LocalhostCA.crt" ]
  [ -e "$T/system-ca/other.crt" ]
}

@test "cert-issue fails without a CA" {
  run dmp cert-issue local.site.com
  [ "$status" -eq 1 ]
}

@test "cert-issue covers the domain and every alias, signed by the CA" {
  dmp ca-create
  run dmp cert-issue local.site.com local.site.de local.site.com www.local.site.com
  [ "$status" -eq 0 ]
  crt="$T/certs/local.site.com/local.site.com.crt"
  [ "$(san_of "$crt")" = "DNS:local.site.com,DNS:local.site.de,DNS:www.local.site.com" ]
  openssl verify -CAfile "$T/certs/devmagic-panel-ca/ca.pem" "$crt"
  [ "$(stat -c %a "$T/certs/local.site.com/local.site.com.key")" = 600 ]
  [ -z "$(find "$T/certs/local.site.com" -name '.issue.*')" ]
}

@test "vhost-write uses one alias list for both blocks and per-site logs" {
  dmp ca-create
  dmp cert-issue local.site.com local.site.de
  run dmp vhost-write local.site.com local.site.de
  [ "$status" -eq 0 ]
  file="$T/sites-available/local.site.com-ssl.conf"
  [ "$(grep -c 'ServerAlias local.site.de' "$file")" -eq 2 ]
  grep -q 'local.site.com-error.log' "$file"
  grep -q 'https://%{HTTP_HOST}%{REQUEST_URI}' "$file"
  [ -L "$T/sites-enabled/local.site.com-ssl.conf" ]
  grep -q '^systemctl reload apache2' "$STUB_LOG"
}

@test "vhost-write serves folders in WEB_DIR under a path, each with its own Directory block" {
  dmp ca-create
  dmp cert-issue local.site.com
  mkdir -p "$T/www/local.learn.site.com"
  run dmp vhost-write local.site.com --uploads-proxy www.site.com --mount /learn=local.learn.site.com local.site.de
  [ "$status" -eq 0 ]
  file="$T/sites-available/local.site.com-ssl.conf"
  grep -q "^    Alias /learn $T/www/local.learn.site.com\$" "$file"
  grep -q "^    <Directory $T/www/local.learn.site.com>\$" "$file"
  [ "$(grep -c 'ServerAlias local.site.de' "$file")" -eq 2 ]
  grep -q 'https://www.site.com/' "$file"
}

@test "vhost-write refuses mounts outside WEB_DIR, odd paths and missing folders" {
  dmp ca-create
  dmp cert-issue local.site.com
  mkdir -p "$T/www/local.learn.site.com"
  for spec in "/learn=/etc" "/learn=../local.learn.site.com" "/../x=local.learn.site.com" "/./x=local.learn.site.com" "learn=local.learn.site.com" "/learn=local.gone.site.com" "/le arn=local.learn.site.com" "/learn=local.site.com" "/learn"; do
    run dmp vhost-write local.site.com --mount "$spec"
    [ "$status" -ne 0 ]
  done
  [ ! -e "$T/sites-available/local.site.com-ssl.conf" ]
}

@test "vhost-write needs the cert first" {
  run dmp vhost-write local.site.com
  [ "$status" -eq 1 ]
  [ ! -e "$T/sites-available/local.site.com-ssl.conf" ]
}

@test "vhost-write restores the previous file when configtest fails" {
  dmp ca-create
  dmp cert-issue local.site.com
  dmp vhost-write local.site.com
  before="$(cat "$T/sites-available/local.site.com-ssl.conf")"
  STUB_CONFIGTEST_FAIL=1 run dmp vhost-write local.site.com local.site.de
  [ "$status" -eq 1 ]
  [ "$(cat "$T/sites-available/local.site.com-ssl.conf")" = "$before" ]
}

@test "vhost-write removes a new file when configtest fails" {
  dmp ca-create
  dmp cert-issue local.site.com
  STUB_CONFIGTEST_FAIL=1 run dmp vhost-write local.site.com
  [ "$status" -eq 1 ]
  [ ! -e "$T/sites-available/local.site.com-ssl.conf" ]
  [ ! -e "$T/sites-enabled/local.site.com-ssl.conf" ]
}

@test "vhost-write leaves a vhost it did not create as is" {
  dmp ca-create
  dmp cert-issue local.site.com
  printf '<VirtualHost *:443>\n  ServerName local.site.com\n</VirtualHost>\n' > "$T/sites-available/local.site.com-ssl.conf"
  before="$(cat "$T/sites-available/local.site.com-ssl.conf")"
  run dmp vhost-write local.site.com
  [ "$status" -eq 1 ]
  [[ "$output" == *"leaving it as is"* ]]
  [ "$(cat "$T/sites-available/local.site.com-ssl.conf")" = "$before" ]
}

@test "vhost-remove leaves a vhost it did not create as is" {
  printf 'ServerName local.site.com\n' > "$T/sites-available/local.site.com-ssl.conf"
  ln -s ../sites-available/local.site.com-ssl.conf "$T/sites-enabled/local.site.com-ssl.conf"
  run dmp vhost-remove local.site.com
  [ "$status" -eq 1 ]
  [ -f "$T/sites-available/local.site.com-ssl.conf" ]
  [ -L "$T/sites-enabled/local.site.com-ssl.conf" ]
}

@test "vhost-write-panel proxies to the configured port" {
  dmp ca-create
  dmp cert-issue local.devmagic
  run dmp vhost-write-panel
  [ "$status" -eq 0 ]
  grep -q 'ProxyPass / http://127.0.0.1:4710/' "$T/sites-available/local.devmagic-ssl.conf"
  grep -q 'ProxyPass /api/ws ws://127.0.0.1:4710/api/ws' "$T/sites-available/local.devmagic-ssl.conf"
}

@test "vhost-write-panel answers with a waiting page while the panel starts, and asks it again at once" {
  dmp ca-create
  dmp cert-issue local.devmagic
  run dmp vhost-write-panel
  [ "$status" -eq 0 ]
  local file="$T/sites-available/local.devmagic-ssl.conf" php
  php="$(cd "$BATS_TEST_DIRNAME/.." && pwd)/php"
  [ -f "$php/starting.html" ]
  grep -q "Alias /.devmagic-panel-starting.html $php/starting.html" "$file"
  grep -q 'ErrorDocument 502 /.devmagic-panel-starting.html' "$file"
  grep -q 'ErrorDocument 503 /.devmagic-panel-starting.html' "$file"
  # The page is not passed to the panel, and comes before the catch-all.
  grep -n 'ProxyPass ' "$file" | head -n 1 | grep -q 'ProxyPass /.devmagic-panel-starting.html !'
  # No minute of 503s after the panel is up again.
  grep -q 'ProxyPass / http://127.0.0.1:4710/ retry=0' "$file"
  grep -q 'ProxyPass /api/ws ws://127.0.0.1:4710/api/ws retry=0' "$file"
  # The 443 vhost serves it to this computer only.
  sed -n '/<VirtualHost \*:443>/,/<\/VirtualHost>/p' "$file" | grep -q 'Require local'
  # Only the panel's vhost: a site's has no such page.
  dmp cert-issue local.site.com
  dmp vhost-write local.site.com
  ! grep -q 'devmagic-panel-starting' "$T/sites-available/local.site.com-ssl.conf"
}

@test "vhost-write-panel serves the PHP info script on port 80 to this computer only" {
  dmp ca-create
  dmp cert-issue local.devmagic
  run dmp vhost-write-panel
  [ "$status" -eq 0 ]
  local file="$T/sites-available/local.devmagic-ssl.conf"
  grep -q "Alias /.devmagic-panel-php/info.php $(cd "$BATS_TEST_DIRNAME/.." && pwd)/php/info.php" "$file"
  grep -qF 'AliasMatch "^/\.devmagic-panel-php/[a-z0-9.-]+/info\.php\z"' "$file"
  grep -q 'Require local' "$file"
  # The info path is not redirected to https; everything else on port 80 is.
  grep -B1 'RewriteRule ^ https' "$file" | grep -q 'devmagic-panel-php/" - \[L\]'
  # Only the panel's vhost: a site's has no such path.
  dmp cert-issue local.site.com
  dmp vhost-write local.site.com
  ! grep -q 'devmagic-panel-php' "$T/sites-available/local.site.com-ssl.conf"
}

@test "vhost-remove disables and deletes" {
  dmp ca-create
  dmp cert-issue local.site.com
  dmp vhost-write local.site.com
  run dmp vhost-remove local.site.com
  [ "$status" -eq 0 ]
  [ ! -e "$T/sites-available/local.site.com-ssl.conf" ]
  [ ! -e "$T/sites-enabled/local.site.com-ssl.conf" ]
}

@test "cert-reissue-from-vhost covers names from both blocks and skips public ones" {
  dmp ca-create
  mkdir -p "$T/certs/local.big.com"
  cat > "$T/sites-available/local.big.com-ssl.conf" <<EOF
<VirtualHost *:80>
  ServerName local.big.com
  ServerAlias www.local.big.com local.only80.com
</VirtualHost>
<VirtualHost *:443>
  ServerName local.big.com
  ServerAlias local.big.de real.example.com
  SSLCertificateFile $T/certs/local.big.com/local.big.com.crt
</VirtualHost>
EOF
  run dmp cert-reissue-from-vhost local.big.com
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipping non-local name"*"real.example.com"* ]]
  [ "$(san_of "$T/certs/local.big.com/local.big.com.crt")" = "DNS:local.big.com,DNS:www.local.big.com,DNS:local.only80.com,DNS:local.big.de" ]
}

@test "cert-reissue-from-vhost refuses a vhost using another cert path" {
  dmp ca-create
  printf 'ServerName local.other.com\nSSLCertificateFile /elsewhere/x.crt\n' > "$T/sites-available/local.other.com-ssl.conf"
  run dmp cert-reissue-from-vhost local.other.com
  [ "$status" -eq 1 ]
}

@test "hosts-add creates the marked block at the end and leaves other lines alone" {
  before="$(cat "$T/hosts")"
  run dmp hosts-add local.site.com local.site.de
  [ "$status" -eq 0 ]
  [ "$(head -n 3 "$T/hosts")" = "$before" ]
  [ "$(tail -n 3 "$T/hosts")" = "$(printf '%s\n' '# BEGIN devmagic-panel (managed by the panel, edit sites there)' '127.0.0.1 local.site.com local.site.de' '# END devmagic-panel')" ]
}

@test "hosts-add replaces the site's line inside the block on rerun" {
  dmp hosts-add local.site.com local.site.de
  dmp hosts-add local.other.com
  dmp hosts-add local.site.com local.site.fr
  [ "$(grep -c 'local.site.com' "$T/hosts")" -eq 1 ]
  grep -q '^127.0.0.1 local.site.com local.site.fr$' "$T/hosts"
  grep -q '^127.0.0.1 local.other.com$' "$T/hosts"
  [ "$(grep -c '^# BEGIN devmagic-panel' "$T/hosts")" -eq 1 ]
}

@test "hosts-add keeps the block where it is and text after it" {
  printf '# BEGIN devmagic-panel (managed by the panel, edit sites there)\n127.0.0.1 local.a.com\n# END devmagic-panel\n127.0.0.1 after.test\n' >> "$T/hosts"
  dmp hosts-add local.b.com
  [ "$(tail -n 1 "$T/hosts")" = '127.0.0.1 after.test' ]
  grep -B1 '^# END devmagic-panel' "$T/hosts" | grep -q '^127.0.0.1 local.b.com$'
}

@test "hosts-remove removes only the site's line, and the block when empty" {
  dmp hosts-add local.site.com
  dmp hosts-add www.local.site.com
  run dmp hosts-remove local.site.com
  [ "$status" -eq 0 ]
  [ "$(grep -c '^127.0.0.1 local.site.com$' "$T/hosts")" -eq 0 ]
  grep -q '^127.0.0.1 www.local.site.com$' "$T/hosts"
  dmp hosts-remove www.local.site.com
  [ "$(grep -c 'devmagic-panel' "$T/hosts")" -eq 0 ]
  grep -q '^127.0.0.1 local.manual.com$' "$T/hosts"
}

@test "hosts-add refuses a broken block" {
  printf '# BEGIN devmagic-panel (managed by the panel, edit sites there)\n127.0.0.1 local.a.com\n' >> "$T/hosts"
  before="$(cat "$T/hosts")"
  run dmp hosts-add local.b.com
  [ "$status" -eq 1 ]
  [ "$(cat "$T/hosts")" = "$before" ]
}

@test "backup archives certs, vhosts and hosts, readable only by the user" {
  dmp ca-create
  run dmp backup
  [ "$status" -eq 0 ]
  archive="$(ls "$T"/backups/devmagic-panel-backup-*.tar.gz)"
  [ "$(stat -c %a "$archive")" = 600 ]
  [ "$(stat -c %a "$T/backups")" = 700 ]
  tar -tzf "$archive" | grep -q 'hosts$'
  tar -tzf "$archive" | grep -q 'devmagic-panel-ca/ca.key$'
}

@test "apache-module-enable allows only listed modules" {
  run dmp apache-module-enable proxy_http
  [ "$status" -eq 0 ]
  run dmp apache-module-enable php8.3
  [ "$status" -eq 2 ]
}

mods_tree() {
  mkdir -p "$T/mods-available" "$T/mods-enabled"
  for m in expires http2 ssl dir; do : > "$T/mods-available/$m.load"; done
  : > "$T/mods-enabled/ssl.load"
  : > "$T/mods-enabled/dir.load"
  stub a2enmod 'ln -sf "../mods-available/${@: -1}.load" "'"$T"'/mods-enabled/${@: -1}.load"'
  stub a2dismod 'rm -f "'"$T"'/mods-enabled/${@: -1}.load"'
}

@test "apache-module turns a module on or off, with a configtest before and after, then restarts Apache" {
  mods_tree
  run dmp apache-module expires on
  [ "$status" -eq 0 ]
  [ -L "$T/mods-enabled/expires.load" ]
  grep -qx 'a2enmod -q expires' "$STUB_LOG"
  [ "$(grep -c '^apache2ctl configtest' "$STUB_LOG")" -ge 2 ]
  grep -qx 'systemctl restart apache2' "$STUB_LOG"
  : > "$STUB_LOG"
  run dmp apache-module expires off
  [ "$status" -eq 0 ]
  [ ! -e "$T/mods-enabled/expires.load" ]
  grep -qx 'a2dismod -q -f expires' "$STUB_LOG"
}

@test "apache-module does nothing for a module already in that state" {
  mods_tree
  run dmp apache-module ssl on
  [ "$status" -eq 0 ]
  [[ "$output" == *"already on"* ]]
  [ "$(grep -c 'a2enmod\|systemctl' "$STUB_LOG")" -eq 0 ]
}

@test "apache-module takes the change back when the configtest after it fails" {
  mods_tree
  stub apache2ctl '[[ ! -e "'"$T"'/mods-enabled/http2.load" ]] || { echo "AH00534: apache2: Configuration error: http2 needs another MPM" >&2; exit 1; }; echo "Syntax OK"'
  run dmp apache-module http2 on
  [ "$status" -eq 1 ]
  [[ "$output" == *"breaks the Apache config, so it is off again"* ]]
  [[ "$output" == *"AH00534"* ]]
  [ ! -e "$T/mods-enabled/http2.load" ]
  [ "$(grep -c 'systemctl' "$STUB_LOG")" -eq 0 ]
}

@test "apache-module refuses bad names, php and mpm modules, locked modules off, and modules not installed" {
  mods_tree
  for args in "../x on" "Expires on" "expires maybe" "expires" "php8.3 on" "php8.3 off" "mpm_event on" "mpm_prefork off" "ssl off" "proxy off" "dir off" "authz_core off"; do
    # shellcheck disable=SC2086
    run dmp apache-module $args
    [ "$status" -eq 2 ]
  done
  run dmp apache-module status on
  [ "$status" -eq 1 ]
  [[ "$output" == *"status is not in mods-available"* ]]
  [ "$(grep -c 'a2enmod\|a2dismod\|systemctl' "$STUB_LOG")" -eq 0 ]
}

@test "site-dir-create makes a setgid group-writable folder" {
  run dmp site-dir-create local.site.com
  [ "$status" -eq 0 ]
  [ "$(stat -c %a "$T/www/local.site.com")" = 2775 ]
}

@test "vhost-write --uploads-proxy redirects missing uploads to that host" {
  dmp ca-create
  dmp cert-issue local.site.com local.site.de
  run dmp vhost-write local.site.com --uploads-proxy www.site.com local.site.de
  [ "$status" -eq 0 ]
  file="$T/sites-available/local.site.com-ssl.conf"
  grep -qF 'RewriteCond %{DOCUMENT_ROOT}%{REQUEST_URI} !-f' "$file"
  grep -qF 'RewriteRule ^/?(.*)$ https://www.site.com/$1 [R=302,L]' "$file"
  [ "$(grep -c 'ServerAlias local.site.de' "$file")" -eq 2 ]
}

@test "vhost-write refuses an uploads proxy that is not a plain hostname" {
  dmp ca-create
  dmp cert-issue local.site.com
  for bad in "https://x.com" "x.com/evil" "x.com [R]" "-x" ""; do
    run dmp vhost-write local.site.com --uploads-proxy "$bad"
    [ "$status" -eq 2 ]
  done
  [ ! -e "$T/sites-available/local.site.com-ssl.conf" ]
}

@test "site-dir-create records the folder in the registry and puts nothing in the folder" {
  run dmp site-dir-create local.site.com
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$T/www/local.site.com")" ]
  entry="$T/state/sites/local.site.com"
  [ "$(sed -n 1p "$entry")" = "$T/www/local.site.com" ]
  [ "$(sed -n 2p "$entry")" = "$(stat -c '%d:%i' "$T/www/local.site.com")" ]
  [ "$(stat -c %a "$entry")" = 644 ]
}

@test "site-dir-remove deletes a folder the panel created, and its registry entry" {
  dmp site-dir-create local.site.com
  touch "$T/www/local.site.com/index.php"
  run dmp site-dir-remove local.site.com
  [ "$status" -eq 0 ]
  [ ! -e "$T/www/local.site.com" ]
  [ ! -e "$T/state/sites/local.site.com" ]
}

@test "site-dir-remove leaves folders the registry does not list alone" {
  mkdir -p "$T/www/local.hand.com"
  touch "$T/www/local.hand.com/index.php" "$T/www/local.hand.com/.devmagic-panel-site"
  run dmp site-dir-remove local.hand.com
  [ "$status" -eq 1 ]
  [[ "$output" == *"not created by devmagic-panel"* ]]
  [ -e "$T/www/local.hand.com/index.php" ]
}

@test "site-dir-remove refuses a folder swapped in place, an entry for another site and a symlinked folder" {
  dmp site-dir-create local.a.com
  mv "$T/www/local.a.com" "$T/www/old"
  mkdir "$T/www/local.a.com"
  run dmp site-dir-remove local.a.com
  [ "$status" -eq 1 ]
  [[ "$output" == *"not the folder devmagic-panel created"* ]]
  [ -d "$T/www/local.a.com" ]

  dmp site-dir-create local.b.com
  mkdir -p "$T/www/local.c.com"
  cp "$T/state/sites/local.b.com" "$T/state/sites/local.c.com"
  run dmp site-dir-remove local.c.com
  [ "$status" -eq 1 ]
  [ -d "$T/www/local.c.com" ]

  ln -s "$T/www/local.b.com" "$T/www/local.d.com"
  run dmp site-dir-remove local.d.com
  [ "$status" -eq 1 ]
  [ -d "$T/www/local.b.com" ]
}

@test "site-marker-migrate moves markers it wrote into the registry and leaves others" {
  mkdir -p "$T/www/local.old.com" "$T/www/local.other.com" "$T/www/www.example.com"
  printf 'local.old.com\n' > "$T/www/local.old.com/.devmagic-panel-site"
  printf 'local.old.com\n' > "$T/www/local.other.com/.devmagic-panel-site"
  printf 'www.example.com\n' > "$T/www/www.example.com/.devmagic-panel-site"
  run dmp site-marker-migrate
  [ "$status" -eq 0 ]
  [[ "$output" == *"moved out of site folders: 1"* ]]
  [ ! -e "$T/www/local.old.com/.devmagic-panel-site" ]
  [ "$(sed -n 1p "$T/state/sites/local.old.com")" = "$T/www/local.old.com" ]
  [ -e "$T/www/local.other.com/.devmagic-panel-site" ]
  [ ! -e "$T/state/sites/local.other.com" ]
  [ ! -e "$T/state/sites/www.example.com" ]
  # The migrated folder can now be removed like a new one.
  run dmp site-dir-remove local.old.com
  [ "$status" -eq 0 ]
}

@test "cert-remove refuses while a vhost uses the cert, then removes it" {
  dmp ca-create
  dmp cert-issue local.site.com
  dmp vhost-write local.site.com
  run dmp cert-remove local.site.com
  [ "$status" -eq 1 ]
  [ -f "$T/certs/local.site.com/local.site.com.crt" ]
  dmp vhost-remove local.site.com
  run dmp cert-remove local.site.com
  [ "$status" -eq 0 ]
  [ ! -e "$T/certs/local.site.com" ]
}

# Apache loading mod_php 8.3 with Xdebug installed.
php_tree() {
  mkdir -p "$T/mods-enabled" "$T/php/8.3/mods-available" "$T/php/8.3/apache2/conf.d" "$T/php-lib/8.3/sapi"
  : > "$T/mods-enabled/php8.3.load"
  # The packages' markers: a part counts only with its marker and its config folder.
  : > "$T/php-lib/8.3/sapi/apache2"
  : > "$T/php-lib/8.3/sapi/cli"
  : > "$T/php/8.3/mods-available/xdebug.ini"
}

@test "xdebug-enable writes the panel's settings, enables the module for Apache and restarts it" {
  php_tree
  run dmp xdebug-enable debug trigger
  [ "$status" -eq 0 ]
  ini="$T/php/8.3/apache2/conf.d/99-devmagic-panel-xdebug.ini"
  grep -qx 'xdebug.mode=debug' "$ini"
  grep -qx 'xdebug.start_with_request=trigger' "$ini"
  [ "$(stat -c %a "$ini")" = 644 ]
  grep -qx 'phpenmod -v 8.3 -s apache2 xdebug' "$STUB_LOG"
  grep -qx 'systemctl restart apache2' "$STUB_LOG"
}

@test "xdebug-enable takes several modes at once" {
  php_tree
  run dmp xdebug-enable debug,develop,profile yes
  [ "$status" -eq 0 ]
  grep -qx 'xdebug.mode=debug,develop,profile' "$T/php/8.3/apache2/conf.d/99-devmagic-panel-xdebug.ini"
}

@test "xdebug-enable refuses modes and start values outside the allow-list" {
  php_tree
  for args in "debug,gcstats trigger" "debug,debug trigger" "debug, trigger" ",debug trigger" "debug always" "x;id trigger" "--help yes"; do
    # shellcheck disable=SC2086
    run dmp xdebug-enable $args
    [ "$status" -eq 2 ]
  done
  run dmp xdebug-enable debug
  [ "$status" -eq 2 ]
  [ ! -e "$T/php/8.3/apache2/conf.d/99-devmagic-panel-xdebug.ini" ]
  [ "$(grep -c 'phpenmod' "$STUB_LOG")" -eq 0 ]
}

@test "xdebug-enable fails without mod_php or without the xdebug package" {
  run dmp xdebug-enable debug trigger
  [ "$status" -eq 1 ]
  [[ "$output" == *"does not load mod_php"* ]]
  php_tree
  rm "$T/php/8.3/mods-available/xdebug.ini"
  run dmp xdebug-enable debug trigger
  [ "$status" -eq 1 ]
  [[ "$output" == *"apt install php8.3-xdebug"* ]]
}

@test "xdebug-disable removes the panel's settings and does not restart a broken config" {
  php_tree
  dmp xdebug-enable develop yes
  run dmp xdebug-disable
  [ "$status" -eq 0 ]
  [ ! -e "$T/php/8.3/apache2/conf.d/99-devmagic-panel-xdebug.ini" ]
  grep -qx 'phpdismod -v 8.3 -s apache2 xdebug' "$STUB_LOG"
  : > "$STUB_LOG"
  STUB_CONFIGTEST_FAIL=1 run dmp xdebug-disable
  [ "$status" -eq 1 ]
  [ "$(grep -c 'systemctl restart' "$STUB_LOG")" -eq 0 ]
}

@test "php-module turns a module on or off for Apache and the CLI of Apache's PHP, then restarts Apache" {
  php_tree
  mkdir -p "$T/php/8.3/cli/conf.d"
  : > "$T/php/8.3/mods-available/soap.ini"
  run dmp php-module soap on
  [ "$status" -eq 0 ]
  grep -qx 'phpenmod -v 8.3 -s apache2 soap' "$STUB_LOG"
  grep -qx 'phpenmod -v 8.3 -s cli soap' "$STUB_LOG"
  grep -qx 'systemctl restart apache2' "$STUB_LOG"
  : > "$STUB_LOG"
  run dmp php-module soap off
  [ "$status" -eq 0 ]
  grep -qx 'phpdismod -v 8.3 -s apache2 soap' "$STUB_LOG"
  grep -qx 'phpdismod -v 8.3 -s cli soap' "$STUB_LOG"
}

@test "php-module leaves the CLI out when that version has none" {
  php_tree
  : > "$T/php/8.3/mods-available/soap.ini"
  run dmp php-module soap on
  [ "$status" -eq 0 ]
  grep -qx 'phpenmod -v 8.3 -s apache2 soap' "$STUB_LOG"
  [ "$(grep -c -- '-s cli' "$STUB_LOG")" -eq 0 ]
}

@test "php-module refuses bad names, xdebug, required modules off, and modules not installed" {
  php_tree
  : > "$T/php/8.3/mods-available/mysqli.ini"
  for args in "../soap on" "Soap on" "soap maybe" "xdebug on" "mysqli off" "pdo off" "soap"; do
    # shellcheck disable=SC2086
    run dmp php-module $args
    [ "$status" -eq 2 ]
  done
  run dmp php-module intl on
  [ "$status" -eq 1 ]
  [[ "$output" == *"intl is not installed for PHP 8.3"* ]]
  [ "$(grep -c 'phpenmod\|phpdismod' "$STUB_LOG")" -eq 0 ]
  # A required module can still be turned on.
  run dmp php-module mysqli on
  [ "$status" -eq 0 ]
}

@test "php-module changes nothing while the Apache config is broken" {
  php_tree
  : > "$T/php/8.3/mods-available/soap.ini"
  STUB_CONFIGTEST_FAIL=1 run dmp php-module soap on
  [ "$status" -eq 1 ]
  [ "$(grep -c 'phpenmod' "$STUB_LOG")" -eq 0 ]
}

# PHP 8.1 on FPM only, next to the mod_php 8.3 of php_tree.
fpm_tree() {
  php_tree
  mkdir -p "$T/php/8.1/mods-available" "$T/php/8.1/fpm/conf.d" "$T/php/8.1/cli/conf.d" "$T/php-lib/8.1/sapi"
  : > "$T/php-lib/8.1/sapi/fpm"
  : > "$T/php-lib/8.1/sapi/cli"
  : > "$T/php/8.1/mods-available/soap.ini"
  : > "$T/php/8.1/mods-available/xdebug.ini"
  stub php-fpm8.1 '[[ -z "${STUB_FPM_FAIL:-}" ]] || { echo "ERROR: bad pool" >&2; exit 1; }'
}

@test "php-module with a version switches every part of it and reloads its FPM, not Apache" {
  fpm_tree
  run dmp php-module 8.1 soap on
  [ "$status" -eq 0 ]
  grep -qx 'phpenmod -v 8.1 -s fpm soap' "$STUB_LOG"
  grep -qx 'phpenmod -v 8.1 -s cli soap' "$STUB_LOG"
  grep -qx 'php-fpm8.1 -t' "$STUB_LOG"
  grep -qx 'systemctl reload php8.1-fpm' "$STUB_LOG"
  [ "$(grep -c 'systemctl restart apache2' "$STUB_LOG")" -eq 0 ]
  for args in "8 soap on" "8.1.2 soap on" "x;id soap on"; do
    # shellcheck disable=SC2086
    run dmp php-module $args
    [ "$status" -eq 2 ]
  done
  run dmp php-module 7.4 soap on
  [ "$status" -eq 1 ]
  [[ "$output" == *"PHP 7.4 is not installed"* ]]
}

@test "php-module refuses to turn on a module whose library apt removed, and turns it off" {
  fpm_tree
  mkdir -p "$T/ext"
  printf 'extension=redis.so\n' > "$T/php/8.1/mods-available/redis.ini"
  stub php8.1 'printf "%s" "'"$T"'/ext"'
  run dmp php-module 8.1 redis on
  [ "$status" -eq 1 ]
  [[ "$output" == *"install php8.1-redis first"* ]]
  [ "$(grep -c 'phpenmod' "$STUB_LOG")" -eq 0 ]
  run dmp php-module 8.1 redis off
  [ "$status" -eq 0 ]
  : > "$T/ext/redis.so"
  run dmp php-module 8.1 redis on
  [ "$status" -eq 0 ]
  grep -qx 'phpenmod -v 8.1 -s fpm redis' "$STUB_LOG"
}

@test "php-module and php-ini skip the apache2 folder a removed mod_php left behind" {
  fpm_tree
  mkdir -p "$T/php/8.1/apache2"
  : > "$T/php/8.1/apache2/php.ini"
  run dmp php-module 8.1 soap on
  [ "$status" -eq 0 ]
  [[ "$output" == *"(fpm cli)"* ]]
  [ "$(grep -c -- '-s apache2' "$STUB_LOG")" -eq 0 ]
  run dmp php-ini 8.1 web memory_limit=512M
  [ "$status" -eq 0 ]
  [ -f "$T/php/8.1/fpm/conf.d/99-devmagic-panel.ini" ]
  [ ! -e "$T/php/8.1/apache2/conf.d" ]
}

@test "xdebug-enable with a version writes the settings for its FPM and reloads it; a failing php-fpm -t stops the reload" {
  fpm_tree
  run dmp xdebug-enable 8.1 debug trigger
  [ "$status" -eq 0 ]
  grep -qx 'xdebug.mode=debug' "$T/php/8.1/fpm/conf.d/99-devmagic-panel-xdebug.ini"
  grep -qx 'phpenmod -v 8.1 -s fpm xdebug' "$STUB_LOG"
  grep -qx 'systemctl reload php8.1-fpm' "$STUB_LOG"
  : > "$STUB_LOG"
  STUB_FPM_FAIL=1 run dmp xdebug-disable 8.1
  [ "$status" -eq 1 ]
  [[ "$output" == *"php-fpm8.1 -t failed"* ]]
  [ "$(grep -c 'systemctl reload' "$STUB_LOG")" -eq 0 ]
}

@test "php-ini writes the panel's settings for the web parts or the command line, and none removes them" {
  fpm_tree
  mkdir -p "$T/php/8.3/cli/conf.d"
  run dmp php-ini 8.3 web memory_limit=512M "error_reporting=E_ALL & ~E_DEPRECATED & ~E_STRICT" display_errors=On
  [ "$status" -eq 0 ]
  ini="$T/php/8.3/apache2/conf.d/99-devmagic-panel.ini"
  grep -qx 'memory_limit = 512M' "$ini"
  grep -qx 'error_reporting = E_ALL & ~E_DEPRECATED & ~E_STRICT' "$ini"
  [ "$(stat -c %a "$ini")" = 644 ]
  [ ! -e "$T/php/8.3/cli/conf.d/99-devmagic-panel.ini" ]
  grep -qx 'systemctl restart apache2' "$STUB_LOG"

  run dmp php-ini 8.1 web upload_max_filesize=64M
  [ "$status" -eq 0 ]
  grep -qx 'upload_max_filesize = 64M' "$T/php/8.1/fpm/conf.d/99-devmagic-panel.ini"
  grep -qx 'systemctl reload php8.1-fpm' "$STUB_LOG"

  : > "$STUB_LOG"
  run dmp php-ini 8.1 cli memory_limit=-1
  [ "$status" -eq 0 ]
  grep -qx 'memory_limit = -1' "$T/php/8.1/cli/conf.d/99-devmagic-panel.ini"
  [ "$(grep -c 'systemctl' "$STUB_LOG")" -eq 0 ]

  run dmp php-ini 8.3 web
  [ "$status" -eq 0 ]
  [ ! -e "$ini" ]
}

@test "php-ini refuses settings outside the allow-list, bad values and repeats, and writes nothing" {
  fpm_tree
  for pair in "auto_prepend_file=/tmp/x.php" "memory_limit=512M;x" "memory_limit=0" "upload_max_filesize=-1" "display_errors=1" \
    "error_reporting=E_ALL|E_STRICT" "date.timezone=../x" "max_input_vars=1e9" "memory_limit" $'memory_limit=1M\nauto_prepend_file=x'; do
    run dmp php-ini 8.1 web "$pair"
    [ "$status" -eq 2 ]
  done
  run dmp php-ini 8.1 web memory_limit=1G memory_limit=2G
  [ "$status" -eq 2 ]
  run dmp php-ini 8.1 site memory_limit=1G
  [ "$status" -eq 2 ]
  [ ! -e "$T/php/8.1/fpm/conf.d/99-devmagic-panel.ini" ]
}

@test "php-ini-reset puts the packaged php.ini back and php-ini-put-back restores yours" {
  fpm_tree
  mkdir -p "$T/php-lib/8.3" "$T/php/8.3/cli"
  printf 'memory_limit = 128M\n' > "$T/php-lib/8.3/php.ini-production"
  printf 'memory_limit = -1\n' > "$T/php-lib/8.3/php.ini-production.cli"
  printf 'memory_limit = 512M\n' > "$T/php/8.3/apache2/php.ini"
  printf 'memory_limit = 2G\n' > "$T/php/8.3/cli/php.ini"
  run dmp php-ini-reset 8.3 apache2
  [ "$status" -eq 0 ]
  saved="$(printf '%s\n' "$output" | sed -n 's/^saved //p')"
  [[ "$saved" =~ ^8\.3-apache2-[0-9]{14}$ ]]
  grep -qx 'memory_limit = 128M' "$T/php/8.3/apache2/php.ini"
  grep -qx 'memory_limit = 512M' "$T/state/php-ini/$saved.ini"
  [ "$(stat -c %a "$T/state/php-ini")" = 700 ]
  run dmp php-ini-reset 8.3 cli
  [ "$status" -eq 0 ]
  grep -qx 'memory_limit = -1' "$T/php/8.3/cli/php.ini"

  run dmp php-ini-put-back 8.3 apache2 "$saved"
  [ "$status" -eq 0 ]
  grep -qx 'memory_limit = 512M' "$T/php/8.3/apache2/php.ini"
  for name in "../x" "8.3-cli-20260101000000" "8.1-apache2-20260101000000" "$saved;id"; do
    run dmp php-ini-put-back 8.3 apache2 "$name"
    [ "$status" -eq 2 ]
  done
  run dmp php-ini-put-back 8.3 apache2 8.3-apache2-20200101000000
  [ "$status" -eq 1 ]
}

# A site folder, PHP-FPM 8.1 and 8.3 installed, and Apache with proxy_fcgi.
pool_tree() {
  fpm_tree
  mkdir -p "$T/www/local.shop.com" "$T/php/8.3/fpm/pool.d" "$T/php/8.1/fpm/pool.d" "$T/mods-available" "$T/conf-available"
  : > "$T/mods-available/proxy_fcgi.load"
  mkdir -p "$T/php-lib/8.1/sapi" "$T/php-lib/8.3/sapi"
  : > "$T/php-lib/8.1/sapi/fpm"
  : > "$T/php-lib/8.3/sapi/fpm"
  printf 'export APACHE_RUN_USER=www-data\nexport APACHE_RUN_GROUP=www-data\n' > "$T/envvars"
  stub a2enconf ':'
  stub php-fpm8.3 ':'
  # No real PHP-FPM makes the pool's socket here: the wait for it goes by at once.
  stub sleep ':'
}

@test "php-pool-write gives a site its own pool with its settings and sends its PHP there" {
  pool_tree
  run dmp php-pool-write local.shop.com 8.1 memory_limit=1G display_errors=On
  [ "$status" -eq 0 ]
  pool="$T/php/8.1/fpm/pool.d/dmp-local.shop.com.conf"
  head -n 1 "$pool" | grep -qx '; Managed by devmagic-panel. Edits here are overwritten.'
  grep -qx '\[dmp-local.shop.com\]' "$pool"
  grep -qx 'listen = /run/php/dmp-local.shop.com.sock' "$pool"
  grep -qx 'pm = ondemand' "$pool"
  grep -qx 'user = www-data' "$pool"
  grep -qx 'php_admin_value\[memory_limit\] = 1G' "$pool"
  grep -qx 'php_admin_value\[display_errors\] = On' "$pool"
  conf="$T/conf-available/devmagic-panel-php.conf"
  grep -q "<Directory \"$T/www/local.shop.com\">" "$conf"
  grep -q 'SetHandler "proxy:fcgi://dmp-local.shop.com"' "$conf"
  grep -q '<Proxy "unix:/run/php/dmp-local.shop.com.sock|fcgi://dmp-local.shop.com">' "$conf"
  grep -q '<Location "/.devmagic-panel-php/php8.1/">' "$conf"
  grep -q 'CGIPassAuth On' "$conf"
  grep -qx 'a2enmod -q proxy_fcgi setenvif' "$STUB_LOG"
  grep -qx 'a2enconf -q devmagic-panel-php' "$STUB_LOG"
  grep -qx 'php-fpm8.1 -t' "$STUB_LOG"
  grep -qx 'systemctl reload php8.1-fpm' "$STUB_LOG"
  grep -qx 'systemctl reload apache2' "$STUB_LOG"
}

@test "php-pool-write waits for the pool's socket and says when PHP-FPM has not made it" {
  pool_tree
  run dmp php-pool-write local.shop.com 8.3
  [ "$status" -eq 0 ]
  [[ "$output" == *"PHP-FPM has not made /run/php/dmp-local.shop.com.sock yet"* ]]
  [ "$(grep -c '^sleep 0.2$' "$STUB_LOG")" -eq 50 ]
}

@test "php-pool-write to another version moves the pool and reloads both" {
  pool_tree
  dmp php-pool-write local.shop.com 8.1
  : > "$STUB_LOG"
  run dmp php-pool-write local.shop.com 8.3 upload_max_filesize=64M
  [ "$status" -eq 0 ]
  [ ! -e "$T/php/8.1/fpm/pool.d/dmp-local.shop.com.conf" ]
  [ -f "$T/php/8.3/fpm/pool.d/dmp-local.shop.com.conf" ]
  grep -qx 'systemctl reload php8.3-fpm' "$STUB_LOG"
  grep -qx 'systemctl reload php8.1-fpm' "$STUB_LOG"
  grep -q '# local.shop.com: PHP 8.3' "$T/conf-available/devmagic-panel-php.conf"
}

@test "php-pool-write puts the site's pools back when php-fpm -t or the configtest fails" {
  pool_tree
  dmp php-pool-write local.shop.com 8.1 memory_limit=1G
  STUB_FPM_FAIL=1 run dmp php-pool-write local.shop.com 8.1 memory_limit=2G
  [ "$status" -eq 1 ]
  grep -qx 'php_admin_value\[memory_limit\] = 1G' "$T/php/8.1/fpm/pool.d/dmp-local.shop.com.conf"
  STUB_CONFIGTEST_FAIL=1 run dmp php-pool-write local.shop.com 8.3
  [ "$status" -eq 1 ]
  [ -f "$T/php/8.1/fpm/pool.d/dmp-local.shop.com.conf" ]
  [ ! -e "$T/php/8.3/fpm/pool.d/dmp-local.shop.com.conf" ]
  grep -q '# local.shop.com: PHP 8.1' "$T/conf-available/devmagic-panel-php.conf"
}

@test "php-pool-write refuses bad folders, versions and settings, and folders or FPM that are not there" {
  pool_tree
  for args in "../x 8.1" "example.com 8.1" "local.shop.com 8" "local.shop.com 8.1 auto_prepend_file=/x.php" "local.shop.com 8.1 memory_limit=1G;x" \
    "local.$(printf 'a%.0s' {1..60}).$(printf 'b%.0s' {1..30}).com 8.1"; do
    # shellcheck disable=SC2086
    run dmp php-pool-write $args
    [ "$status" -eq 2 ]
  done
  run dmp php-pool-write local.none.com 8.1
  [ "$status" -eq 1 ]
  [[ "$output" == *"no site folder"* ]]
  run dmp php-pool-write local.shop.com 7.4
  [ "$status" -eq 1 ]
  [[ "$output" == *"apt install php7.4-fpm"* ]]
  [ ! -e "$T/conf-available/devmagic-panel-php.conf" ]
}

@test "php-pool-remove takes the site's pool out and leaves the others" {
  pool_tree
  mkdir -p "$T/www/local.blog.com"
  dmp php-pool-write local.shop.com 8.1
  dmp php-pool-write local.blog.com 8.1
  run dmp php-pool-remove local.shop.com
  [ "$status" -eq 0 ]
  [ ! -e "$T/php/8.1/fpm/pool.d/dmp-local.shop.com.conf" ]
  ! grep -q 'local.shop.com' "$T/conf-available/devmagic-panel-php.conf"
  grep -q 'local.blog.com' "$T/conf-available/devmagic-panel-php.conf"
  run dmp php-pool-remove local.shop.com
  [ "$status" -eq 0 ]
  [[ "$output" == *"has no pool of its own"* ]]
}

@test "php-fpm-match gives FPM the modules, panel files and php.ini of mod_php" {
  pool_tree
  mkdir -p "$T/php/8.3/fpm/conf.d"
  : > "$T/php/8.3/mods-available/soap.ini"
  : > "$T/php/8.3/mods-available/intl.ini"
  ln -s ../../mods-available/soap.ini "$T/php/8.3/apache2/conf.d/20-soap.ini"
  ln -s ../../mods-available/intl.ini "$T/php/8.3/fpm/conf.d/20-intl.ini"
  printf 'memory_limit = 512M\n' > "$T/php/8.3/apache2/conf.d/99-devmagic-panel.ini"
  printf 'memory_limit = 512M\n' > "$T/php/8.3/apache2/php.ini"
  printf 'memory_limit = 128M\n' > "$T/php/8.3/fpm/php.ini"
  run dmp php-fpm-match 8.3
  [ "$status" -eq 0 ]
  grep -qx 'phpenmod -v 8.3 -s fpm soap' "$STUB_LOG"
  grep -qx 'phpdismod -v 8.3 -s fpm intl' "$STUB_LOG"
  cmp "$T/php/8.3/apache2/conf.d/99-devmagic-panel.ini" "$T/php/8.3/fpm/conf.d/99-devmagic-panel.ini"
  cmp "$T/php/8.3/apache2/php.ini" "$T/php/8.3/fpm/php.ini"
  saved="$(printf '%s\n' "$output" | sed -n 's/^saved //p')"
  grep -qx 'memory_limit = 128M' "$T/state/php-ini/$saved.ini"
  run dmp php-fpm-match 8.1
  [ "$status" -eq 1 ]
  [[ "$output" == *"no mod_php to match"* ]]
}

# apt with PHP 8.4 in its sources (but no imagick for it), and php8.1 packages installed.
apt_tree() {
  pool_tree
  stub apt-cache 'case "$2" in php8.4-imagick|php7.0-*) printf "%s:\n  Installed: (none)\n  Candidate: (none)\n" "$2" ;; *) printf "%s:\n  Installed: (none)\n  Candidate: 1.0-1\n" "$2" ;; esac'
  stub apt-get ':'
  stub apt-mark 'case "$1" in showauto) printf "php8.3-imagick\nphp8.1-xdebug\nlibonig5\n" ;; esac'
  stub update-alternatives ':'
  stub dpkg-query 'printf "php8.1-fpm ii \nphp8.1-cli ii \nphp8.1-soap rc \nphp8.1-common:amd64 ii \n"'
}

@test "php-install installs a version's base packages from the sources apt has, skipping what it lacks" {
  apt_tree
  run dmp php-install 8.4
  [ "$status" -eq 0 ]
  grep -q '^apt-get -y -q .* install php8.4-fpm php8.4-cli php8.4-mysql php8.4-xml php8.4-mbstring php8.4-curl php8.4-zip php8.4-gd php8.4-intl php8.4-bcmath$' "$STUB_LOG"
  grep -q -- '--force-confold' "$STUB_LOG"
  [[ "$output" == *"left out: php8.4-imagick"* ]]
  run dmp php-install 7.0
  [ "$status" -eq 1 ]
  [[ "$output" == *"add the PPA"* ]]
  run dmp php-install 8
  [ "$status" -eq 2 ]
}

@test "php-install stops before apt brings in another PHP version or mod_php, naming the php-* packages behind it" {
  apt_tree
  stub apt-get 'if [[ "$1" == -s ]]; then printf "Inst php-common [2:93] (2:101 x)\nInst php-imagick [3.7] (3.8 x)\nInst php8.5-common (8.5.1 x)\nInst libapache2-mod-php8.4 (8.4.1 x)\nInst php8.4-fpm (8.4.1 x)\n"; fi'
  run dmp php-install 8.4
  [ "$status" -eq 1 ]
  [[ "$output" == *"apt would also install php8.5-common libapache2-mod-php8.4."* ]]
  [[ "$output" == *"an update of php-common php-imagick"* ]]
  [[ "$output" == *"sudo apt-mark manual php8.3-imagick php8.1-xdebug"* ]]
  [[ "$output" == *"sudo apt-get remove php-common php-imagick"* ]]
  [ "$(grep -c '^apt-get -y' "$STUB_LOG")" -eq 0 ]
}

@test "php-install keeps php on the command line where it was, and php-cli moves it" {
  apt_tree
  mkdir -p "$T/bin"
  : > "$T/bin/php8.1"
  : > "$T/bin/php8.4"
  chmod +x "$T/bin/php8.1" "$T/bin/php8.4"
  ln -s "$T/bin/php8.1" "$T/stub/php"
  # apt-get install moves the alternative to the new version, as apt does.
  stub apt-get '[[ "$1" == -s ]] || ln -sfn "'"$T"'/bin/php8.4" "'"$T"'/stub/php"'
  run env PATH="$T/bin:$PATH" "$DMP_ROOT_BIN" php-install 8.4
  [ "$status" -eq 0 ]
  grep -qx "update-alternatives --set php $T/bin/php8.1" "$STUB_LOG"
  [[ "$output" == *"stays PHP 8.1"* ]]
  mkdir -p "$T/php/8.4/mods-available" "$T/php/8.4/cli" "$T/php-lib/8.4/sapi"
  run env PATH="$T/bin:$PATH" "$DMP_ROOT_BIN" php-cli 8.4
  [ "$status" -eq 1 ]
  [[ "$output" == *"no command line"* ]]
  : > "$T/php-lib/8.4/sapi/cli"
  run env PATH="$T/bin:$PATH" "$DMP_ROOT_BIN" php-cli 8.4
  [ "$status" -eq 0 ]
  grep -qx "update-alternatives --set php $T/bin/php8.4" "$STUB_LOG"
  run dmp php-cli 8
  [ "$status" -eq 2 ]
}

@test "php-package installs or removes one package, never a core one or a bad name" {
  apt_tree
  run dmp php-package 8.1 redis install
  [ "$status" -eq 0 ]
  grep -q 'install php8.1-redis$' "$STUB_LOG"
  run dmp php-package 8.1 redis remove
  [ "$status" -eq 0 ]
  grep -q 'remove php8.1-redis$' "$STUB_LOG"
  for args in "8.1 fpm remove" "8.1 mysql remove" "8.1 ../x install" "8.1 redis;id install" "8.1 redis purge"; do
    # shellcheck disable=SC2086
    run dmp php-package $args
    [ "$status" -eq 2 ]
  done
}

@test "php-upgrade updates the installed packages of a version only" {
  apt_tree
  run dmp php-upgrade 8.1
  [ "$status" -eq 0 ]
  grep -q 'install --only-upgrade php8.1-fpm php8.1-cli php8.1-common$' "$STUB_LOG"
}

@test "php-remove removes a version's packages, and refuses while Apache, the command line or a site uses it" {
  apt_tree
  run dmp php-remove 8.3
  [ "$status" -eq 1 ]
  [[ "$output" == *"Apache runs PHP 8.3 as mod_php"* ]]
  dmp php-pool-write local.shop.com 8.1
  run dmp php-remove 8.1
  [ "$status" -eq 1 ]
  [[ "$output" == *"these sites run on it: local.shop.com"* ]]
  [ "$(grep -c ' remove ' "$STUB_LOG")" -eq 0 ]
  dmp php-pool-remove local.shop.com
  run dmp php-remove 8.1
  [ "$status" -eq 0 ]
  grep -q 'remove php8.1-fpm php8.1-cli php8.1-common$' "$STUB_LOG"
  [ -d "$T/php/8.1" ]
  # The other versions' packages apt counts as automatic are kept from autoremove.
  grep -qx 'apt-mark manual php8.3-imagick' "$STUB_LOG"
}

@test "php-remove refuses when apt would take out more than PHP packages" {
  apt_tree
  stub apt-get 'if [[ "$1" == -s ]]; then printf "Remv php8.1-common [8.1]\nRemv php-imagick [3.8]\nRemv phpmyadmin [5.2]\n"; fi'
  run dmp php-remove 8.1
  [ "$status" -eq 1 ]
  [[ "$output" == *"apt would also take out phpmyadmin"* ]]
  [ "$(grep -c '^apt-get -y' "$STUB_LOG")" -eq 0 ]
}

# mod_php 8.3 on mpm_prefork, with mpm_event and phpMyAdmin there to switch to.
switch_tree() {
  pool_tree
  : > "$T/mods-available/mpm_event.load"
  : > "$T/mods-available/mpm_prefork.load"
  : > "$T/mods-available/php8.3.load"
  : > "$T/mods-enabled/mpm_prefork.load"
  stub a2dismod 'rm -f "'"$T"'/mods-enabled/${@: -1}.load"'
  stub a2enmod 'for m in "$@"; do [[ "$m" == -* ]] || : > "'"$T"'/mods-enabled/$m.load"; done'
  mkdir -p "$T/conf-enabled" "$T/phpmyadmin"
  printf 'Alias /phpmyadmin %s\n<IfModule mod_php.c>\n  php_admin_value open_basedir /usr/share/phpmyadmin/:/etc/phpmyadmin/\n</IfModule>\n' "$T/phpmyadmin" > "$T/conf-enabled/phpmyadmin.conf"
}

@test "php-switch-fpm turns mod_php off and sends every site without a pool, and phpMyAdmin, to PHP-FPM" {
  switch_tree
  run dmp php-switch-fpm 8.3
  [ "$status" -eq 0 ]
  [ "$(cat "$T/state/php-default")" = 8.3 ]
  grep -qx 'a2dismod -q php8.3' "$STUB_LOG"
  grep -qx 'a2dismod -q mpm_prefork' "$STUB_LOG"
  grep -qx 'a2enmod -q mpm_event' "$STUB_LOG"
  grep -qx 'systemctl restart apache2' "$STUB_LOG"
  conf="$T/conf-available/devmagic-panel-php.conf"
  grep -q 'SetHandler "proxy:fcgi://php8.3"' "$conf"
  grep -q 'SetEnvIfNoCase ^Authorization' "$conf"
  grep -q "<Directory \"$T/phpmyadmin\">" "$conf"
  grep -qx 'php_admin_value\[open_basedir\] = /usr/share/phpmyadmin/:/etc/phpmyadmin/' "$T/php/8.3/fpm/pool.d/dmp-phpmyadmin.conf"
  run dmp php-remove 8.3
  [ "$status" -eq 1 ]
  [[ "$output" == *"every site without a PHP of its own runs on PHP 8.3"* ]]
  # Make default on another version: the default and phpMyAdmin's pool move to it.
  run dmp php-switch-fpm 8.1
  [ "$status" -eq 0 ]
  [ "$(cat "$T/state/php-default")" = 8.1 ]
  grep -q 'SetHandler "proxy:fcgi://php8.1"' "$conf"
  [ -f "$T/php/8.1/fpm/pool.d/dmp-phpmyadmin.conf" ]
  [ ! -e "$T/php/8.3/fpm/pool.d/dmp-phpmyadmin.conf" ]
}

@test "php-switch-fpm puts mod_php back when the configtest fails, and refuses a version without FPM" {
  switch_tree
  STUB_CONFIGTEST_FAIL=1 run dmp php-switch-fpm 8.3
  [ "$status" -eq 1 ]
  [ ! -e "$T/state/php-default" ]
  [ ! -e "$T/php/8.3/fpm/pool.d/dmp-phpmyadmin.conf" ]
  grep -qx 'a2enmod -q mpm_prefork php8.3' "$STUB_LOG"
  rm "$T/php-lib/8.1/sapi/fpm"
  run dmp php-switch-fpm 8.1
  [ "$status" -eq 1 ]
  [[ "$output" == *"apt install php8.1-fpm"* ]]
}

@test "php-switch-modphp brings mod_php and mpm_prefork back, without the default handler" {
  switch_tree
  dmp php-switch-fpm 8.3
  : > "$STUB_LOG"
  run dmp php-switch-modphp 8.3
  [ "$status" -eq 0 ]
  [ ! -e "$T/state/php-default" ]
  [ ! -e "$T/php/8.3/fpm/pool.d/dmp-phpmyadmin.conf" ]
  grep -qx 'a2dismod -q mpm_event' "$STUB_LOG"
  grep -qx 'a2enmod -q mpm_prefork php8.3' "$STUB_LOG"
  ! grep -q 'Every other site' "$T/conf-available/devmagic-panel-php.conf"
  run dmp php-switch-modphp 8.1
  [ "$status" -eq 1 ]
  [[ "$output" == *"apt install libapache2-mod-php8.1"* ]]
}

@test "service-restart restarts mariadb when there is no mysql unit, and only known services" {
  stub systemctl '[[ "$1" == cat && "$2" == mysql.service ]] && exit 1; exit 0'
  run dmp service-restart mysql
  [ "$status" -eq 0 ]
  grep -qx 'systemctl restart mariadb' "$STUB_LOG"
  run dmp service-restart sshd
  [ "$status" -eq 2 ]
  run dmp service-restart
  [ "$status" -eq 2 ]
}

@test "a config without PHP_CONF_DIR still loads, with /etc/php as the default" {
  sed -i '/^PHP_CONF_DIR=/d' "$DMP_CONFIG"
  run dmp hosts-add local.site.com
  [ "$status" -eq 0 ]
}

# A site the panel made: folder in the registry, vhost, cert, hosts line, and a dump exported for removal.
trash_site_tree() {
  dmp ca-create
  dmp cert-issue local.site.com local.site.de
  dmp site-dir-create local.site.com
  dmp vhost-write local.site.com local.site.de
  dmp hosts-add local.site.com local.site.de
  printf '<?php echo 1;\n' > "$T/www/local.site.com/index.php"
  mkdir -p "$T/backups/sites"
  printf 'CREATE TABLE x;\n' | gzip > "$T/backups/sites/local.site.com-20261024-120000.sql.gz"
}

@test "trash-site archives the folder, vhost, cert and dump with checksums, and changes nothing else" {
  trash_site_tree
  run dmp trash-site local.site.com 20261024-120000 site_com site_com
  [ "$status" -eq 0 ]
  entry="$T/state/trash/local.site.com-20261024-120000"
  [ -f "$entry/site.tar.gz" ] && [ -f "$entry/config.tar.gz" ] && [ -f "$entry/db.sql.gz" ]
  [ ! -e "$T/backups/sites/local.site.com-20261024-120000.sql.gz" ]
  (cd "$entry" && sha256sum --quiet -c SHA256SUMS)
  grep -qx 'PANEL_MADE=1' "$entry/manifest.env"
  grep -qx 'NAMES=local.site.com local.site.de' "$entry/manifest.env"
  grep -qx 'ENABLED=local.site.com-ssl.conf' "$entry/manifest.env"
  [ "$(stat -c %a "$entry")" = 700 ]
  # Archiving alone removes nothing.
  [ -f "$T/www/local.site.com/index.php" ] && [ -f "$T/sites-available/local.site.com-ssl.conf" ]
  run dmp trash-site local.site.com 20261024-120000 site_com site_com
  [ "$status" -eq 1 ]
}

@test "trash-remove refuses without a matching archive, then removes the site and lists it" {
  trash_site_tree
  run dmp trash-remove local.site.com 20261024-120000
  [ "$status" -eq 1 ]
  [ -d "$T/www/local.site.com" ]
  dmp trash-site local.site.com 20261024-120000 - -
  run dmp trash-remove local.site.com 20261024-120000
  [ "$status" -eq 0 ]
  [ ! -e "$T/www/local.site.com" ] && [ ! -e "$T/sites-available/local.site.com-ssl.conf" ] && [ ! -e "$T/certs/local.site.com" ]
  [ ! -e "$T/state/sites/local.site.com" ]
  ! grep -q 'local.site.com' "$T/hosts"
  grep -qx '127.0.0.1 local.manual.com' "$T/hosts"
  run dmp trash-list
  [[ "$output" == "local.site.com-20261024-120000"$'\t'"local.site.com"$'\t'* ]]
  # No reason given: deleted; the database export went into it.
  [[ "$output" == *$'\t'"deleted"$'\t'"1" ]]
}

@test "trash-site records why the site went to the archive, and trash-list reads it" {
  trash_site_tree
  run dmp trash-site local.site.com 20261024-120000 - - reinstall
  [ "$status" -eq 0 ]
  grep -qx 'REASON=reinstall' "$T/state/trash/local.site.com-20261024-120000/manifest.env"
  run dmp trash-list
  [[ "$output" == *$'\t'"reinstall"$'\t'"1" ]]
  # An archive from before reasons reads as deleted.
  sed -i '/^REASON=/d' "$T/state/trash/local.site.com-20261024-120000/manifest.env"
  rm "$T/state/trash/local.site.com-20261024-120000/db.sql.gz"
  run dmp trash-list
  [[ "$output" == *$'\t'"deleted"$'\t'"0" ]]
}

@test "trash-restore puts everything back, hands the dump to the panel and refuses when the site exists again" {
  trash_site_tree
  dmp trash-site local.site.com 20261024-120000 site_com site_com
  dmp trash-remove local.site.com 20261024-120000
  run dmp trash-restore local.site.com-20261024-120000
  [ "$status" -eq 0 ]
  [[ "$output" == *"DUMP=$T/backups/sites/restore-local.site.com-20261024-120000.sql.gz"* ]]
  [ "$(cat "$T/www/local.site.com/index.php")" = '<?php echo 1;' ]
  [ -L "$T/sites-enabled/local.site.com-ssl.conf" ] && [ -f "$T/certs/local.site.com/local.site.com.crt" ]
  grep -q '^127.0.0.1 local.site.com local.site.de$' "$T/hosts"
  [ "$(sed -n 2p "$T/state/sites/local.site.com")" = "$(stat -c '%d:%i' "$T/www/local.site.com")" ]
  run dmp trash-restore local.site.com-20261024-120000
  [ "$status" -eq 1 ]
  [[ "$output" == *"exists again"* ]]
}

@test "trash-restore refuses an archive that does not match its checksums" {
  trash_site_tree
  dmp trash-site local.site.com 20261024-120000 - -
  dmp trash-remove local.site.com 20261024-120000
  printf 'x' >> "$T/state/trash/local.site.com-20261024-120000/config.tar.gz"
  run dmp trash-restore local.site.com-20261024-120000
  [ "$status" -eq 1 ]
  [ ! -e "$T/www/local.site.com" ]
}

@test "a site made by hand is archived and removed too, as not panel-made" {
  dmp ca-create
  dmp cert-issue local.hand.com
  mkdir -p "$T/www/local.hand.com"
  printf '<VirtualHost *:443>\n ServerName local.hand.com\n DocumentRoot %s\n</VirtualHost>\n' "$T/www/local.hand.com" > "$T/sites-available/local.hand.com-ssl.conf"
  run dmp trash-site local.hand.com 20261024-130000 - -
  [ "$status" -eq 0 ]
  grep -qx 'PANEL_MADE=0' "$T/state/trash/local.hand.com-20261024-130000/manifest.env"
  run dmp trash-remove local.hand.com 20261024-130000
  [ "$status" -eq 0 ]
  [ ! -e "$T/www/local.hand.com" ]
}

@test "trash-purge deletes old entries only, trash-delete one, and bad input is refused" {
  trash_site_tree
  dmp trash-site local.site.com 20261024-120000 - -
  entry="$T/state/trash/local.site.com-20261024-120000"
  run dmp trash-purge 14
  [ -d "$entry" ]
  sed -i "s/^DELETED_AT=.*/DELETED_AT=$(( $(date +%s) - 15 * 86400 ))/" "$entry/manifest.env"
  run dmp trash-purge 14
  [ "$status" -eq 0 ]
  [ ! -e "$entry" ]
  for args in "trash-site www.site.com 20261024-120000 - -" "trash-site local.site.com 2026 - -" "trash-site local.site.com 20261024-120000 x;y -" \
    "trash-site local.site.com 20261024-120000 - - moved" "trash-site local.site.com 20261024-120000 - - deleted extra" \
    "trash-delete ../etc" "trash-delete local.site.com" "trash-restore www.x.com-20261024-120000" "trash-purge 0" "trash-purge x"; do
    # shellcheck disable=SC2086
    run dmp $args
    [ "$status" -eq 2 ]
  done
}
