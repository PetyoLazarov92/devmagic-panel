#!/usr/bin/env bats

# install.sh --dry-run must print its plan and change nothing: sudo and
# systemctl are stubs that fail the test if they are ever called.

setup() {
  STUBS="$BATS_TEST_TMPDIR/stubs"
  mkdir -p "$STUBS"
  for cmd in sudo systemctl certutil apt-get; do
    printf '#!/bin/sh\necho "CALLED %s $*" >&2\nexit 99\n' "$cmd" > "$STUBS/$cmd"
    chmod +x "$STUBS/$cmd"
  done
  # Lingering is off, so the installer would only offer it.
  printf '#!/bin/sh\necho no\n' > "$STUBS/loginctl"
  chmod +x "$STUBS/loginctl"
  export PATH="$STUBS:$PATH"
  # Logs would go here; a dry run must not write one.
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/state"
  # A fresh machine: no config.env yet, and no releases.
  export DMP_INSTALL_CONFIG_DIR="$BATS_TEST_TMPDIR/etc"
  export DMP_INSTALL_DATA_DIR="$BATS_TEST_TMPDIR/data"
  export DMP_INSTALL_STATE_DIR="$BATS_TEST_TMPDIR/state"
  DATA="$DMP_INSTALL_DATA_DIR"
  # A home folder that is not encrypted, whatever this machine has.
  export DMP_INSTALL_MOUNTS="$BATS_TEST_TMPDIR/mounts"
  printf '/dev/sda1 / ext4 rw 0 0\n' > "$DMP_INSTALL_MOUNTS"
  INSTALL="$BATS_TEST_DIRNAME/../../install.sh"
}

# A release as get.sh unpacks it: install.sh, its libraries and release.json.
fake_release() {
  local dir="$1" name="$2"
  mkdir -p "$dir/scripts"
  cp "$INSTALL" "$dir/install.sh"
  cp -R "$BATS_TEST_DIRNAME/../bin" "$BATS_TEST_DIRNAME/../lib" "$dir/scripts/"
  printf '{\n  "name": "%s",\n  "version": "%s",\n  "commit": "abc"\n}\n' "$name" "${name#v}" > "$dir/release.json"
}

@test "dry run changes nothing and backs up before touching certs" {
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" != *"CALLED "* ]]
  [[ "$output" == *"[dry-run] sudo /usr/local/lib/devmagic-panel/bin/dmp-root backup"* ]]

  backup_line="$(grep -n 'dmp-root backup' <<< "$output" | head -1 | cut -d: -f1)"
  ca_line="$(grep -n 'dmp-root ca-create' <<< "$output" | head -1 | cut -d: -f1)"
  panel_line="$(grep -n 'dmp-root cert-issue local.devmagic' <<< "$output" | head -1 | cut -d: -f1)"
  [ "$backup_line" -lt "$ca_line" ]
  [ "$ca_line" -lt "$panel_line" ]
}

@test "sudoers rule allows only dmp-root and wpcore" {
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  rule="$(grep 'NOPASSWD' <<< "$output")"
  [[ "$rule" == *"NOPASSWD: /usr/local/lib/devmagic-panel/bin/dmp-root, /usr/local/lib/devmagic-panel/bin/wpcore" ]]
  [[ "$rule" != *dmp-restore* ]]
}

@test "installs dmp-restore and tells how to restore" {
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"scripts/bin/dmp-restore"*"/usr/local/lib/devmagic-panel/bin/"* ]]
  [[ "$output" == *"sudo /usr/local/lib/devmagic-panel/bin/dmp-restore --list"* ]]
}

@test "a second run keeps the settings from an existing config.env" {
  mkdir -p "$DMP_INSTALL_CONFIG_DIR"
  printf 'PANEL_PORT=4799\nBACKUP_DIR=/srv/backups\nPHP_CONF_DIR=/etc/php\n' > "$DMP_INSTALL_CONFIG_DIR/config.env"
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"| PANEL_PORT=4799"* ]]
  [[ "$output" == *"| BACKUP_DIR=/srv/backups"* ]]
  [[ "$output" == *"devmagic-panel is installed"* ]]
  # No update source of its own: the panel's repository.
  [[ "$output" != *"UPDATE_REPO="* ]]
  [[ "$output" != *"UPDATE_GIT_URL="* ]]
}

@test "a second run keeps the repository the panel updates from, like a fork" {
  mkdir -p "$DMP_INSTALL_CONFIG_DIR"
  printf 'PANEL_PORT=4799\nUPDATE_REPO=acme/devmagic-panel\nUPDATE_GIT_URL=git@github.com:acme/devmagic-panel.git\n' > "$DMP_INSTALL_CONFIG_DIR/config.env"
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"| UPDATE_REPO=acme/devmagic-panel"* ]]
  [[ "$output" == *"| UPDATE_GIT_URL=git@github.com:acme/devmagic-panel.git"* ]]
  [[ "$output" == *"| PANEL_PORT=4799"* ]]
}

@test "an update source the panel would refuse is dropped with a warning" {
  mkdir -p "$DMP_INSTALL_CONFIG_DIR"
  printf 'UPDATE_REPO=no-owner\nUPDATE_GIT_URL=--upload-pack\n' > "$DMP_INSTALL_CONFIG_DIR/config.env"
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"UPDATE_REPO in $DMP_INSTALL_CONFIG_DIR/config.env is not owner/name"* ]]
  [[ "$output" == *"UPDATE_GIT_URL in $DMP_INSTALL_CONFIG_DIR/config.env is not a git remote"* ]]
  [[ "$output" != *"| UPDATE_REPO="* ]]
  [[ "$output" != *"| UPDATE_GIT_URL="* ]]
}

@test "dry run lists what it would install and writes no log" {
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"[dry-run] write $BATS_TEST_TMPDIR/state/installed-files (mode 0644):"* ]]
  [[ "$output" == *$'| file\t/etc/sudoers.d/devmagic-panel\tremove\t'* ]]
  [[ "$output" == *$'| line\t/etc/hosts\tremove\tlocal.devmagic in the devmagic-panel block'* ]]
  [[ "$output" == *$'| dir\t'"$HOME"$'/devmagic-panel-backups\task\t'* ]]
  [[ "$output" == *$'| file\t'"$BATS_TEST_TMPDIR/state/installed-files"$'\tremove\tthis list'* ]]
  # The list is the last change, after the service.
  service_line="$(grep -n 'Installing the systemd user service' <<< "$output" | head -1 | cut -d: -f1)"
  list_line="$(grep -n 'Writing the list of installed files' <<< "$output" | head -1 | cut -d: -f1)"
  [ "$service_line" -lt "$list_line" ]
  [ ! -e "$XDG_STATE_HOME/devmagic-panel" ]
}

@test "from a checkout, a dry run builds the checked out commit into a release and runs the service from current" {
  repo="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"[dry-run] git clone --quiet --no-checkout $repo "*"/devmagic-panel-build."*"/src"* ]]
  [[ "$output" == *"/src checkout --quiet --detach $(git -C "$repo" rev-parse HEAD)"* ]]
  [[ "$output" == *"[dry-run] npm --prefix "*"/src ci --include=dev"* ]]
  [[ "$output" == *"/src/scripts/package.sh --out "*"/out"* ]]
  [[ "$output" == *"into $DATA/releases/<name>"* ]]
  [[ "$output" == *"[dry-run] ln -sfn releases/v"*" $DATA/current.new"* ]]
  [[ "$output" == *"[dry-run] mv -T -- $DATA/current.new $DATA/current"* ]]
  [[ "$output" == *"| WorkingDirectory=$DATA/current"* ]]
  [[ "$output" == *"$DATA/current/server/dist/index.js"* ]]
  [[ "$output" == *$'| dir\t'"$DATA/releases"$'\tremove\t'* ]]
  [[ "$output" == *$'| link\t'"$DATA/current"$'\tremove\t'* ]]
  # The build comes before the root scripts, which a dry run reads from this checkout.
  build_line="$(grep -n 'into a release' <<< "$output" | head -1 | cut -d: -f1)"
  scripts_line="$(grep -n 'Installing root scripts' <<< "$output" | head -1 | cut -d: -f1)"
  [ "$build_line" -lt "$scripts_line" ]
  [ ! -e "$DATA" ]
}

@test "from a release in the releases folder, it installs that release as it is" {
  rel="$DATA/releases/v9.9.9"
  fake_release "$rel" v9.9.9
  run "$rel/install.sh" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Installing release v9.9.9"* ]]
  [[ "$output" != *"git clone"* && "$output" != *"npm --prefix"* ]]
  [[ "$output" == *"scripts/bin/dmp-root"*"/usr/local/lib/devmagic-panel/bin/"* ]]
  [[ "$output" == *"[dry-run] ln -sfn releases/v9.9.9 $DATA/current.new"* ]]
  [[ "$output" == *"running v9.9.9"* ]]
}

@test "a release unpacked elsewhere is copied into the releases folder first" {
  rel="$BATS_TEST_TMPDIR/download/release"
  fake_release "$rel" v9.9.9
  run "$rel/install.sh" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Copying release v9.9.9 to $DATA/releases"* ]]
  [[ "$output" == *"[dry-run] cp -a $rel/. $DATA/releases/.incoming-v9.9.9/"* ]]
  [[ "$output" == *"[dry-run] mv -T -- $DATA/releases/.incoming-v9.9.9 $DATA/releases/v9.9.9"* ]]
  [[ "$output" == *"| WorkingDirectory=$DATA/current"* ]]
}

@test "the v0.5 copy goes once the service runs a release, and only the newest releases stay" {
  mkdir -p "$DATA/app" "$DATA/releases/v1.0.0" "$DATA/releases/v1.1.0" "$DATA/releases/v1.2.0" "$DATA/releases/.incoming-v1.3.0"
  touch -d '3 days ago' "$DATA/releases/v1.0.0"
  touch -d '2 days ago' "$DATA/releases/v1.1.0"
  touch -d '1 day ago' "$DATA/releases/v1.2.0"
  rel="$DATA/releases/v9.9.9"
  fake_release "$rel" v9.9.9
  run "$rel/install.sh" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"[dry-run] rm -rf -- $DATA/app"* ]]
  [[ "$output" == *"[dry-run] rm -rf -- $DATA/releases/.incoming-v1.3.0"* ]]
  [[ "$output" == *"[dry-run] rm -rf -- $DATA/releases/v1.0.0"* ]]
  [[ "$output" != *"rm -rf -- $DATA/releases/v1.1.0"* && "$output" != *"rm -rf -- $DATA/releases/v1.2.0"* && "$output" != *"rm -rf -- $DATA/releases/v9.9.9"* ]]
  service_line="$(grep -n 'systemctl --user restart devmagic-panel.service' <<< "$output" | head -1 | cut -d: -f1)"
  app_line="$(grep -n "rm -rf -- $DATA/app" <<< "$output" | head -1 | cut -d: -f1)"
  [ "$service_line" -lt "$app_line" ]
}

@test "updates need no GitHub token: the installer never asks for or saves one" {
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME/.config/devmagic-panel"
  printf '{}\n' > "$HOME/.config/devmagic-panel/secrets.json"
  rel="$DATA/releases/v9.9.9"
  fake_release "$rel" v9.9.9
  DMP_GITHUB_TOKEN="github_pat_secretsecretsecretsecret" run "$rel/install.sh" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" != *"set-github-token"* && "$output" != *"secretsecret"* ]]
}

# A throwaway CA in $1, named $2.
make_ca() {
  mkdir -p "$1"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$1/ca.key" -out "$1/ca.pem" -subj "/CN=$2" -days 2 2>/dev/null
}

# A certificate for site $3 in $2/$3/$3.crt, signed by the CA in $1.
make_cert() {
  mkdir -p "$2/$3"
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$2/$3/$3.key" -out "$2/$3/$3.csr" -subj "/CN=$3" 2>/dev/null
  openssl x509 -req -in "$2/$3/$3.csr" -CA "$1/ca.pem" -CAkey "$1/ca.key" -CAcreateserial -out "$2/$3/$3.crt" -days 2 2>/dev/null
}

# A machine installed with v0.5.0: config.env, the list of installed files, a
# site with the panel's files, the panel's CA signing only the panel's own
# certificate, and a site certificate from another CA (devmagic's LocalhostCA).
installed_machine() {
  STATE="$BATS_TEST_TMPDIR/state-dir"
  WWW="$BATS_TEST_TMPDIR/www"
  CERTS="$BATS_TEST_TMPDIR/certs"
  CA="$CERTS/devmagic-panel-ca"
  mkdir -p "$DMP_INSTALL_CONFIG_DIR" "$STATE" "$WWW/local.shop.com/wp-content/mu-plugins"
  printf 'PANEL_DOMAIN=local.devmagic\nWEB_DIR=%s\nSTATE_DIR=%s\nCERTS_DIR=%s\nCA_DIR=%s\n' "$WWW" "$STATE" "$CERTS" "$CA" > "$DMP_INSTALL_CONFIG_DIR/config.env"
  touch "$WWW/local.shop.com/wp-content/mu-plugins/devmagic-panel-local.php"
  make_ca "$CA" "devmagic-panel Local CA"
  make_ca "$BATS_TEST_TMPDIR/old-ca" "LocalhostCA"
  make_cert "$CA" "$CERTS" local.devmagic
  make_cert "$BATS_TEST_TMPDIR/old-ca" "$CERTS" local.shop.com
  {
    printf '# devmagic-panel: what install.sh put on this machine.\n'
    printf 'file\t/etc/sudoers.d/devmagic-panel\tremove\tsudoers rule\n'
    printf 'dir\t%s\tkeep\tthe local CA\n' "$CA"
    printf 'file\t/usr/local/share/ca-certificates/devmagic-panel-ca.crt\tkeep\tthe CA in the system store\n'
    printf 'store\t/home/me/.pki/nssdb\tkeep\tthe CA in a browser store\n'
    printf 'dir\t%s/local.shop.com\tkeep\tcertificate of local.shop.com\n' "$CERTS"
    printf 'packages\tapt:apache2\tkeep\tApache\n'
    printf 'dir\t/etc\tremove\ta bad line\n'
    printf 'dir\t%s/app\tremove\tthe installed copy of the panel\n' "$DATA"
    printf 'file\t%s/installed-files\tremove\tthis list\n' "$STATE"
  } > "$STATE/installed-files"
}

@test "uninstall dry run removes the panel and its unused CA, keeps sites by default, and never touches a folder it should not" {
  installed_machine
  mkdir -p "$DATA/releases/v0.6.0"
  ln -s releases/v0.6.0 "$DATA/current"
  run "$INSTALL" --uninstall --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" != *"CALLED "* ]]
  [[ "$output" == *"[dry-run] sudo /usr/local/lib/devmagic-panel/bin/dmp-root vhost-remove local.devmagic"* ]]
  [[ "$output" == *"[dry-run] sudo /usr/local/lib/devmagic-panel/bin/dmp-root hosts-remove local.devmagic"* ]]
  [[ "$output" == *"[dry-run] sudo rm -f -- /etc/sudoers.d/devmagic-panel"* ]]
  [[ "$output" == *"[dry-run] sudo rm -rf -- $STATE/installed-files"* ]]
  # The releases, the link to the running one and the v0.5 clone are yours: removed without sudo, after the service stopped.
  [[ "$output" == *"[dry-run] rm -rf -- $DATA/releases"* ]]
  [[ "$output" == *"[dry-run] rm -rf -- $DATA/current"* ]]
  [[ "$output" == *"[dry-run] rm -rf -- $DATA/app"* ]]
  # The panel's CA signs no site but the panel's own: it goes by default, with its trust.
  [[ "$output" == *"$CA and its trust in the system and 1 browser store(s)  (the local CA; no site certificate is signed with it)"* ]]
  [[ "$output" == *"[dry-run] certutil -D -d sql:/home/me/.pki/nssdb -n devmagic-panel Local CA"* ]]
  [[ "$output" == *"[dry-run] sudo rm -f -- /usr/local/share/ca-certificates/devmagic-panel-ca.crt"* ]]
  [[ "$output" == *"[dry-run] sudo update-ca-certificates --fresh"* ]]
  [[ "$output" == *"[dry-run] sudo rm -rf -- $CA"* ]]
  [[ "$output" != *"To remove it by hand later"* ]]
  # Site certificates, from any CA, stay.
  [[ "$output" == *"Kept:"*"$CERTS/local.shop.com"* ]]
  [[ "$output" != *"rm -rf -- $CERTS/local.shop.com"* ]]
  [[ "$output" == *"other CAs (like devmagic's LocalhostCA)"* ]]
  [[ "$output" == *"left /etc alone"* ]]
  [[ "$output" != *"rm -rf -- /etc "* && "$output" != *"rm -rf -- /etc"$'\n'* ]]
  # Local mode stays in the sites unless you say otherwise.
  [[ "$output" == *"the panel's 1 files in your sites"* ]]
  [[ "$output" != *"devmagic-panel-local.php"* ]]
  # Panels before v0.7.0 saved a GitHub token: the note says to delete it on GitHub too.
  [[ "$output" == *"delete it at https://github.com/settings/personal-access-tokens"* ]]
  # The root scripts and config.env go last.
  sudoers_line="$(grep -n 'rm -f -- /etc/sudoers.d/devmagic-panel' <<< "$output" | cut -d: -f1)"
  vhost_line="$(grep -n 'vhost-remove local.devmagic' <<< "$output" | cut -d: -f1)"
  ca_line="$(grep -n 'update-ca-certificates --fresh' <<< "$output" | cut -d: -f1)"
  [ "$vhost_line" -lt "$ca_line" ]
  [ "$ca_line" -lt "$sudoers_line" ]
  [[ "$output" == *"dry run done: nothing was changed"* ]]
}

@test "uninstall keeps the panel's CA by default while a site certificate is signed with it" {
  installed_machine
  rm -rf "${CERTS:?}/local.shop.com"
  make_cert "$CA" "$CERTS" local.shop.com
  run "$INSTALL" --uninstall --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"(the local CA; it signs the certificates of local.shop.com)"* ]]
  [[ "$output" != *"[dry-run] certutil -D"* ]]
  ! grep -q '\[dry-run\].*update-ca-certificates' <<< "$output"
  ! grep -q "\[dry-run\].*rm -rf -- $CA" <<< "$output"
  [[ "$output" == *"The local CA stays trusted"*"To remove it by hand later"* ]]
}

@test "uninstall without a list of installed files uses the usual list" {
  # An empty state folder of its own, never this machine's /var/lib/devmagic-panel.
  mkdir -p "$DMP_INSTALL_CONFIG_DIR" "$BATS_TEST_TMPDIR/state-dir"
  printf 'STATE_DIR=%s\n' "$BATS_TEST_TMPDIR/state-dir" > "$DMP_INSTALL_CONFIG_DIR/config.env"
  run "$INSTALL" --uninstall --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"installed before v0.5.0): using the usual list"* ]]
  [[ "$output" == *"[dry-run] sudo rm -rf -- /usr/local/lib/devmagic-panel"* ]]
  [[ "$output" == *"[dry-run] sudo rm -rf -- $DMP_INSTALL_CONFIG_DIR"* ]]
}

@test "on an encrypted home folder it writes the login entry through the panel's CLI, and uninstall removes it" {
  printf '/home/.ecryptfs/alex/.Private %s ecryptfs rw,nosuid,nodev 0 0\n' "$HOME" > "$DMP_INSTALL_MOUNTS"
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Starting the panel after login"* ]]
  [[ "$output" == *"[dry-run] "*"server/dist/cli.js write-autostart"* ]]
  [[ "$output" != *"CALLED "* ]]

  run "$INSTALL" --uninstall --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"rm -rf -- $HOME/.config/autostart/devmagic-panel.desktop"* ]]
}

@test "on a home folder that is not encrypted it writes no login entry" {
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" != *"write-autostart"* ]]
  [[ "$output" != *"Starting the panel after login"* ]]
}

@test "unknown options exit 2" {
  run "$INSTALL" --nope
  [ "$status" -eq 2 ]
}

# A machine with nothing the panel needs yet: dpkg-query knows only the
# packages in DPKG_INSTALLED, and PATH has the basic tools but no node, php,
# wp, git, composer, gh, rclone or claude. $1 is the distribution's ID.
fresh_machine() {
  export HOME="$BATS_TEST_TMPDIR/home"
  export NVM_DIR="$BATS_TEST_TMPDIR/no-nvm"
  mkdir -p "$HOME" "$NVM_DIR"
  printf '#!/usr/bin/env bash\nfor arg in "$@"; do\n  [[ "$arg" == -* ]] && continue\n  for pkg in ${DPKG_INSTALLED:-}; do\n    [[ "$pkg" == $arg ]] && printf "%%s install ok installed\\n" "$pkg"\n  done\ndone\nexit 0\n' > "$STUBS/dpkg-query"
  chmod +x "$STUBS/dpkg-query"
  local basic="$BATS_TEST_TMPDIR/basic" cmd
  mkdir -p "$basic"
  for cmd in bash sh env sed grep cut sort find head tail xargs mktemp rm cat date id tee basename dirname readlink cmp mkdir chmod tr wc uname cp mv ln ls touch stat awk sha256sum tar gzip yes; do
    ln -sf "$(command -v "$cmd")" "$basic/$cmd"
  done
  export PATH="$STUBS:$basic"
  export DMP_INSTALL_OS_RELEASE="$BATS_TEST_TMPDIR/os-release"
  case "$1" in
    debian) printf 'ID=debian\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n' ;;
    *) printf 'ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04 LTS"\n' ;;
  esac > "$DMP_INSTALL_OS_RELEASE"
}

@test "a fresh machine: --yes installs what the panel needs in one apt-get, WP-CLI and Node for the panel, and nothing optional" {
  fresh_machine ubuntu
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" != *"CALLED "* ]]
  [[ "$output" == *"missing  MySQL or MariaDB server (mysql-server)"* ]]
  [[ "$output" == *"missing  Node.js 22.13 or newer (found: none)"* ]]
  # A new machine runs PHP through PHP-FPM, not mod_php, with the panel's handler for every site.
  [[ "$output" == *"[dry-run] sudo apt-get install -y -qq apache2 php php-mysql php-curl php-gd php-intl php-mbstring php-xml php-zip php-fpm mysql-server openssl ca-certificates libnss3-tools curl git unzip"$'\n'* ]]
  [[ "$output" == *"PHP-FPM would run every site"* ]]
  [[ "$output" != *"libapache2-mod-php"* ]]
  [[ "$output" == *"wp-cli.phar"*"/usr/local/bin/wp"* ]]
  [[ "$output" == *"[dry-run] download https://nodejs.org/dist/latest-v22.x/node-v22.<newest>-linux-"*"SHASUMS256.txt, unpack it into $DATA/node"* ]]
  [[ "$output" == *"| ExecStart=$DATA/node/current/bin/node "* ]]
  [ "$(grep -c 'apt-get install' <<< "$output")" -eq 1 ]
  [[ "$(grep 'apt-get install' <<< "$output")" != *composer* && "$(grep 'apt-get install' <<< "$output")" != *xdebug* ]]
  [[ "$output" != *"Installing Mailpit"* && "$output" != *"Installing Claude Code"* && "$output" != *"gh auth login"* ]]
}

@test "a machine with mod_php keeps it: PHP-FPM is recommended, and no switch runs" {
  fresh_machine ubuntu
  export DPKG_INSTALLED="apache2 libapache2-mod-php8.3"
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"PHP for Apache (mod_php or PHP-FPM)"* ]]
  [[ "$output" == *"PHP-FPM, so a site can have its own PHP version and settings"* ]]
  [[ "$output" != *"PHP-FPM would run every site"* ]]
  [[ "$output" != *"php-switch-fpm"* ]]
  # Packages by the version sites run on: one without a version follows the newest PHP apt has.
  run bash -c "yes | '$INSTALL' --dry-run"
  [[ "$output" == *"apt-get install -y -qq php8.3-cli php8.3-mysql "*" php8.3-imagick php8.3-fpm php8.3-xdebug "* ]]
  [[ "$(grep 'apt-get install' <<< "$output")" != *" php-imagick"* ]]
}

@test "on Debian the database server is MariaDB, and one already there is kept" {
  fresh_machine debian
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"apt-get install -y -qq "*" mariadb-server "* ]]
  DPKG_INSTALLED="mysql-server-8.0" run "$INSTALL" --dry-run --yes
  [[ "$output" == *"ok       MySQL or MariaDB server"* ]]
  [[ "$output" != *"-server openssl"* ]]
}

@test "saying no to what the panel needs stops before any change, with the command to install it" {
  fresh_machine ubuntu
  run bash -c "printf 'n\n' | '$INSTALL' --dry-run"
  [ "$status" -eq 1 ]
  [[ "$output" == *"install them with: sudo apt-get install apache2 "*" unzip"* ]]
  [[ "$output" == *"the panel cannot install sites without them"* ]]
  [[ "$output" != *"Writing "* && "$output" != *"[dry-run] sudo"* ]]
}

@test "asked one by one: recommended and optional parts, and the organization tools as one group with how to sign in" {
  fresh_machine ubuntu
  run bash -c "yes | '$INSTALL' --dry-run"
  [ "$status" -eq 0 ]
  [[ "$output" == *"apt-get install -y -qq "*" php-fpm "*" unzip composer php-imagick php-xdebug gh rclone"$'\n'* ]]
  [[ "$output" == *"[dry-run] sudo apt-get install -y phpmyadmin"* ]]
  [[ "$output" == *"Installing Claude Code"*"https://claude.ai/install.sh"* ]]
  [[ "$output" == *"Installing Mailpit"*"cli.js install-mailpit"* ]]
  [[ "$output" == *"gh auth login"*"rclone config"*"claude "* ]]
}

@test "the panel's own Node, once installed, keeps running the panel" {
  mkdir -p "$DATA/node/node-v22.20.0-linux-x64/bin"
  ln -s node-v22.20.0-linux-x64 "$DATA/node/current"
  printf '#!/bin/sh\n[ "$1" = --version ] && echo v22.20.0\nexit 0\n' > "$DATA/node/current/bin/node"
  chmod +x "$DATA/node/current/bin/node"
  run "$INSTALL" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok       Node.js 22.13 or newer (v22.20.0 at $DATA/node/current/bin/node)"* ]]
  [[ "$output" == *"| ExecStart=$DATA/node/current/bin/node "* ]]
  [[ "$output" != *nodejs.org* ]]
}

@test "the install log gets the output without terminal color codes" {
  run bash -c "eval \"\$(grep '^strip_colors()' '$BATS_TEST_DIRNAME/../../install.sh')\"; printf '\033[0;34m==>\033[0m step\n\033[1;33mwarn:\033[0m careful\n' | strip_colors"
  [ "$status" -eq 0 ]
  [ "$output" = $'==> step\nwarn: careful' ]
}
