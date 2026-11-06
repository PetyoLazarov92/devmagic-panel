# Shared setup for dmp-root tests: a throwaway filesystem tree, a config
# pointing into it, and stub Apache and system commands on PATH. Nothing
# here touches the real system.

DMP_ROOT_BIN="$BATS_TEST_DIRNAME/../bin/dmp-root"

setup_tree() {
  T="$BATS_TEST_TMPDIR/sys"
  mkdir -p "$T"/{sites-available,sites-enabled,certs,system-ca,www,log,stub} "$T"/nginx/{sites-available,sites-enabled,conf.d}
  printf 'http {\n\tinclude %s/nginx/conf.d/*.conf;\n}\n' "$T" > "$T/nginx/nginx.conf"
  printf 'Listen 80\n\n<IfModule ssl_module>\n\tListen 443\n</IfModule>\n' > "$T/ports.conf"
  printf '127.0.0.1 localhost\n# hand-written\n127.0.0.1 local.manual.com\n' > "$T/hosts"

  export DMP_CONFIG="$T/config.env"
  cat > "$DMP_CONFIG" <<EOF
PANEL_USER=$(id -un)
PANEL_GROUP=$(id -gn)
PANEL_PORT=4710
PANEL_DOMAIN=local.devmagic
WEB_DIR=$T/www
WEB_GROUP=$(id -gn)
CERTS_DIR=$T/certs
CA_DIR=$T/certs/devmagic-panel-ca
APACHE_SITES_AVAILABLE=$T/sites-available
APACHE_SITES_ENABLED=$T/sites-enabled
APACHE_LOG_DIR=$T/log
HOSTS_FILE=$T/hosts
SYSTEM_CA_DIR=$T/system-ca
BACKUP_DIR=$T/backups
PHP_CONF_DIR=$T/php
PHP_LIB_DIR=$T/php-lib
STATE_DIR=$T/state
NGINX_SITES_AVAILABLE=$T/nginx/sites-available
NGINX_SITES_ENABLED=$T/nginx/sites-enabled
NGINX_LOG_DIR=$T/nginx/log
NGINX_ADDRESS=127.0.0.2
APACHE_ADDRESS=127.0.0.1
EOF

  export STUB_LOG="$T/stub.log"
  : > "$STUB_LOG"
  stub a2ensite 'ln -sf "../sites-available/${@: -1}" "'"$T"'/sites-enabled/${@: -1}"'
  stub a2dissite 'rm -f "'"$T"'/sites-enabled/${@: -1}"'
  stub a2enmod ':'
  stub apache2ctl '[[ -z "${STUB_CONFIGTEST_FAIL:-}" ]] || { echo "Syntax error" >&2; exit 1; }; echo "Syntax OK"'
  stub systemctl ':'
  stub phpenmod ':'
  stub phpdismod ':'
  stub update-ca-certificates ':'
  stub nginx 'if [[ "$1" == -v ]]; then echo "nginx version: nginx/${STUB_NGINX_VERSION:-1.24.0} (Ubuntu)" >&2; exit 0; fi; [[ -z "${STUB_NGINX_FAIL:-}" ]] || { echo "nginx: [emerg] unknown directive" >&2; exit 1; }; echo "nginx: configuration file test is successful" >&2'
  stub ss 'printf "%s" "${STUB_SS:-}"'
  export PATH="$T/stub:$PATH"
}

# stub <name> <body>: a fake command that logs its call and runs body.
stub() {
  cat > "$T/stub/$1" <<EOF
#!/usr/bin/env bash
echo "$1 \$*" >> "\$STUB_LOG"
$2
EOF
  chmod +x "$T/stub/$1"
}

dmp() { "$DMP_ROOT_BIN" "$@"; }

san_of() {
  openssl x509 -in "$1" -noout -ext subjectAltName | tail -n +2 | tr -d ' '
}
