#!/usr/bin/env bash
# devmagic-panel installer for Ubuntu/Debian. Run as your normal user, from a
# release (get.sh unpacks one and runs this; later ones are in
# ~/.local/share/devmagic-panel/current) or from a git checkout, which it builds
# into a release first. It asks for sudo only for system steps. Safe to run
# again: every step skips what is already in place.
#
#   ./install.sh                 interactive install
#   ./install.sh --dry-run       print what would change, change nothing
#   ./install.sh --yes           install what the panel needs, skip the rest
#   ./install.sh --skip-optional do not offer recommended or optional components
#   ./install.sh --from-panel    update an installed panel from its Updates page:
#                                sudo password on stdin, every change put back on failure
#   ./install.sh --uninstall     remove the panel; add --dry-run to see what first
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=scripts/lib/log.sh
source "$REPO/scripts/lib/log.sh"

DMP_PREFIX="/usr/local/lib/devmagic-panel"
DMP="$DMP_PREFIX/bin/dmp-root"
# Overridable only so the tests can run against a temp folder; dmp-root always reads /etc.
CONFIG_DIR="${DMP_INSTALL_CONFIG_DIR:-/etc/devmagic-panel}"
SUDOERS_FILE="/etc/sudoers.d/devmagic-panel"
NSS_NICKNAME="devmagic-panel Local CA"
SYSTEM_CA_FILE="/usr/local/share/ca-certificates/devmagic-panel-ca.crt"
# Overridable only so the tests can stand in for another distribution.
OS_RELEASE="${DMP_INSTALL_OS_RELEASE:-/etc/os-release}"
# Overridable so the tests can stand in for an encrypted home folder.
MOUNTS_FILE="${DMP_INSTALL_MOUNTS:-/proc/mounts}"
# Where apt keeps its sources and keys, read to explain a failed apt-get update.
# Overridable for the tests.
APT_DIR="${DMP_INSTALL_APT_DIR:-/etc/apt}"
APT_KEYRING_DIRS="${DMP_INSTALL_APT_KEYRINGS:-$APT_DIR/keyrings /usr/share/keyrings}"
AUTOSTART_FILE="$HOME/.config/autostart/devmagic-panel.desktop"
# The panel's data folder. The panel runs from a release in releases/<name>
# (v0.6.0, or v0.6.0-dev.1a2b3c4 built from a checkout), the one current
# points at; a checkout can change freely. Overridable for the tests.
DATA_DIR="${DMP_INSTALL_DATA_DIR:-$HOME/.local/share/devmagic-panel}"
RELEASES_DIR="$DATA_DIR/releases"
CURRENT_LINK="$DATA_DIR/current"
# v0.5 ran from a git clone here; the first install of a release removes it.
LEGACY_APP_DIR="$DATA_DIR/app"
# The running release and the newest others stay, to switch back to.
KEEP_RELEASES=3
NAME_RE='^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,40})?$'
# Node 22.13+ runs the panel. When none is found, the installer can put the
# official build in NODE_DIR, for the panel only, so nvm switches cannot break it.
NODE_MAJOR=22
NODE_DIR="$DATA_DIR/node"
NODE_BIN=""
# The release this run installs, and where installed files are read from and
# the panel runs: that release's folder once it is in place, else this folder.
RELEASE_NAME=""
SRC="$REPO"
RUN_DIR="$REPO"
BUILD_TMP=""

DRY_RUN=0
ASSUME_YES=0
SKIP_OPTIONAL=0
# --from-panel: the panel runs this to install an update. The sudo password
# comes on stdin, sits only in this shell variable (never exported, never in a
# file or on a command line) and is cleared at the end. The update is one
# transaction: what it changed as root is put back when a step fails.
FROM_PANEL=0
PANEL_SUDO_PW=""
# Root-owned, for the transaction: the root scripts, config.env and sudoers
# rule as they were (prev/), the new scripts while they are staged (new/).
TXN_DIR="$DMP_PREFIX.update"
TXN_ACTIVE=0
TXN_SCRIPTS=0
TXN_BACKUP=""
TXN_SWITCHED=0
TXN_PREVIOUS=""
UPDATE_RELEASE=""
UPDATE_STARTED=""
CURRENT_STEP=""
FAIL_MESSAGE=""
# What the panel reads after its restart to show how the update went.
STATUS_FILE="$DATA_DIR/update-status.json"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/devmagic-panel/logs"
KEEP_LOGS=20
INSTALL_LOG=""
# What this run put on the machine, written to $STATE_DIR/installed-files at the end.
MANIFEST=()

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; }

UNINSTALL=0

while (( $# > 0 )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1; SKIP_OPTIONAL=1 ;;
    --skip-optional) SKIP_OPTIONAL=1 ;;
    --from-panel) FROM_PANEL=1; ASSUME_YES=1; SKIP_OPTIONAL=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) usage; exit 0 ;;
    *) dmp_usage_error "unknown option: $1" ;;
  esac
  shift
done

# ── helpers ──────────────────────────────────────────────────

# Runs a command that changes the system as root, or prints it in dry-run.
as_root() {
  if (( DRY_RUN )); then
    printf '   [dry-run] sudo %s\n' "$*"
  else
    root_run "$@"
  fi
}

# sudo itself. From the panel it never asks: sudo_ready renews its credential
# first, and -n makes a lapsed one fail instead of waiting for a terminal.
root_run() {
  if (( FROM_PANEL )); then
    sudo_ready || dmp_die "sudo no longer accepts the password"
    sudo -n "$@"
  else
    sudo "$@"
  fi
}

# Without a terminal sudo keeps the credential per calling process, and a pipe
# runs its own, so it is renewed from the password whenever it lapsed. sudo -v
# runs no command: the password on its stdin never reaches another program.
sudo_ready() {
  sudo -n true 2>/dev/null && return 0
  printf '%s\n' "$PANEL_SUDO_PW" | sudo -S -p '' -v 2>/dev/null
}

# Runs a command that changes user files, or prints it in dry-run.
as_user() {
  if (( DRY_RUN )); then
    printf '   [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# Writes stdin to a root-owned file with the given mode, or prints it.
write_root_file() {
  local dest="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  if (( DRY_RUN )); then
    printf '   [dry-run] write %s (mode %s):\n' "$dest" "$mode"
    sed 's/^/      | /' "$tmp"
  else
    root_run install -m "$mode" -o root -g root "$tmp" "$dest"
  fi
  rm -f "$tmp"
}

confirm() {
  local question="$1" default="${2:-y}" answer
  if (( ASSUME_YES )); then
    [[ "$default" == y ]]
    return
  fi
  read -r -p "$question [$([[ "$default" == y ]] && echo Y/n || echo y/N)] " answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy] ]]
}

has_pkg() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }

# Notes one thing the installer put on the machine: kind, path, what the
# uninstaller does with it (remove, ask or keep) and what it is.
record() { MANIFEST+=("$(printf '%s\t%s\t%s\t%s' "$1" "$2" "$3" "$4")"); }

# Everything the installer prints also goes to a log the panel's Developer
# options show. No password is ever in it: sudo asks on the terminal itself,
# and the panel password and MySQL questions run outside the log.
# Copies stdin without terminal color codes, line by line: the log is read on
# the panel's Developer page, not in a terminal.
strip_colors() { sed -u $'s/\033\\[[0-9;]*[A-Za-z]//g'; }

start_log() {
  (( DRY_RUN )) && return 0
  mkdir -p "$LOG_DIR"
  chmod 0700 "$(dirname "$LOG_DIR")" "$LOG_DIR"
  INSTALL_LOG="$LOG_DIR/install-$(date +%Y%m%d-%H%M%S).log"
  exec 3>&1 4>&2
  # The terminal keeps its colors; the log file gets the text without their codes.
  exec > >(tee >(strip_colors >>"$INSTALL_LOG")) 2>&1
  printf 'devmagic-panel install.sh, %s, %s\n' "$(date -Is)" "$(source_label)"
  # Only the newest logs stay.
  find "$LOG_DIR" -maxdepth 1 -name 'install-*.log' -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP_LOGS + 1)) | cut -d' ' -f2- | xargs -r rm -f --
}

# Runs a command on the terminal, outside the install log.
outside_log() {
  if [[ -n "$INSTALL_LOG" ]]; then
    "$@" >&3 2>&4
  else
    "$@"
  fi
}

# ── update from the panel ────────────────────────────────

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/ }"
  printf '%s' "$s"
}

# Writes the update's state for the panel, in one rename so it never reads half a file.
# Usage: status_write running|done|failed [message] [rolled back: true|false]
status_write() {
  (( FROM_PANEL && ! DRY_RUN )) || return 0
  local state="$1" message="${2:-}" rolled="${3:-false}" finished=""
  [[ "$state" == running ]] || finished="$(date -Is)"
  mkdir -p "$DATA_DIR"
  {
    printf '{\n'
    printf '  "release": "%s",\n' "$(json_escape "$UPDATE_RELEASE")"
    printf '  "previous": "%s",\n' "$(json_escape "$TXN_PREVIOUS")"
    printf '  "state": "%s",\n' "$state"
    printf '  "step": "%s",\n' "$(json_escape "$CURRENT_STEP")"
    printf '  "message": "%s",\n' "$(json_escape "$message")"
    printf '  "rolledBack": %s,\n' "$rolled"
    printf '  "started": "%s",\n' "$UPDATE_STARTED"
    printf '  "finished": "%s",\n' "$finished"
    printf '  "log": "%s"\n' "$(json_escape "$INSTALL_LOG")"
    printf '}\n'
  } > "$STATUS_FILE.tmp"
  mv -f -- "$STATUS_FILE.tmp" "$STATUS_FILE"
}

# Names the step the update is at, for the status file and a failure message.
step_at() {
  CURRENT_STEP="$1"
  status_write running
}

# Stops the update with a message the panel shows.
fail() {
  FAIL_MESSAGE="$1"
  dmp_die "$1"
}

# --from-panel: only an installed panel, only from a release, the password
# read once from stdin and checked before anything changes.
from_panel_begin() {
  (( FROM_PANEL )) || return 0
  UPDATE_STARTED="$(date -Is)"
  [[ -f "$REPO/release.json" ]] || dmp_die "--from-panel runs from a release, not a checkout"
  UPDATE_RELEASE="$(release_field name "$REPO/release.json")"
  TXN_PREVIOUS="$(basename "$(readlink "$CURRENT_LINK" 2>/dev/null || true)")"
  [[ -f "$CONFIG_DIR/config.env" ]] || fail "--from-panel updates an installed panel; run ./install.sh in a terminal for the first install"
  (( DRY_RUN )) && return 0
  [[ ! -t 0 ]] || fail "--from-panel reads the sudo password from stdin; the panel's Updates page runs it"
  IFS= read -r PANEL_SUDO_PW || true
  exec 0</dev/null
  step_at password
  sudo_ready || fail "sudo did not accept the password: nothing was changed"
  dmp_ok "sudo accepted the password"
}

# Keeps what the update changes as root: the root scripts, config.env and the sudoers rule.
txn_begin() {
  (( FROM_PANEL )) || return 0
  dmp_step "Keeping the root scripts, config.env and sudoers rule to put back if the update fails"
  as_root rm -rf -- "$TXN_DIR"
  as_root install -d -m 0700 -o root -g root "$TXN_DIR"
  as_root cp -a -- "$DMP_PREFIX" "$TXN_DIR/prev"
  as_root cp -a -- "$CONFIG_DIR/config.env" "$TXN_DIR/config.env"
  if as_root test -f "$SUDOERS_FILE"; then
    as_root cp -a -- "$SUDOERS_FILE" "$TXN_DIR/sudoers"
  fi
  TXN_ACTIVE=1
}

# The update went through: what was kept for a rollback goes.
txn_commit() {
  (( FROM_PANEL )) || return 0
  as_root rm -rf -- "$TXN_DIR"
  TXN_ACTIVE=0
}

# Puts back what the update changed, newest first. Every step is tried even
# when one fails; returns 1 when something could not be put back.
txn_rollback() {
  local ok=0
  dmp_warn "the update failed at $CURRENT_STEP; putting back what it changed"
  if (( TXN_SWITCHED )) && [[ -n "$TXN_PREVIOUS" && -d "$RELEASES_DIR/$TXN_PREVIOUS" ]]; then
    ln -sfn "releases/$TXN_PREVIOUS" "$CURRENT_LINK.new" && mv -T -- "$CURRENT_LINK.new" "$CURRENT_LINK" || ok=1
  fi
  if (( TXN_SCRIPTS )); then
    # Gone when the update failed between its two renames; asked as root, like every other root path.
    if as_root test -d "$DMP_PREFIX"; then
      as_root rm -rf -- "$TXN_DIR/failed" && as_root mv -T -- "$DMP_PREFIX" "$TXN_DIR/failed" || ok=1
    fi
    as_root mv -T -- "$TXN_DIR/prev" "$DMP_PREFIX" || ok=1
  fi
  as_root install -m 0644 -o root -g root "$TXN_DIR/config.env" "$CONFIG_DIR/config.env" || ok=1
  if as_root test -f "$TXN_DIR/sudoers"; then
    as_root install -m 0440 -o root -g root "$TXN_DIR/sudoers" "$SUDOERS_FILE" || ok=1
  fi
  if [[ -n "$TXN_BACKUP" ]]; then
    as_root "$DMP_PREFIX/bin/dmp-restore" --yes "$TXN_BACKUP" || ok=1
  fi
  if (( TXN_SWITCHED )); then
    systemctl --user restart devmagic-panel.service || ok=1
  fi
  if (( ok == 0 )); then
    as_root rm -rf -- "$TXN_DIR"
    dmp_ok "put back: ${TXN_PREVIOUS:-the release before} runs as before"
  else
    dmp_error "some of the update could not be put back; what was kept is in $TXN_DIR"
  fi
  return "$ok"
}

# The panel answers on its own port with the version just installed, within 60 seconds.
health_check() {
  local want version i
  want="$(release_field version "$RUN_DIR/release.json")"
  for (( i = 0; i < 30; i++ )); do
    version="$(curl -fsS --max-time 3 "http://127.0.0.1:$PANEL_PORT/healthz" 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' || true)"
    [[ -n "$version" && "$version" == "$want" ]] && return 0
    sleep 2
  done
  return 1
}

# On every exit: a failed update from the panel is put back and its state
# written; the password and sudo's credential go either way.
on_exit() {
  local rc=$? rolled=false
  set +e
  [[ -n "$BUILD_TMP" ]] && rm -rf -- "$BUILD_TMP"
  if (( FROM_PANEL && ! DRY_RUN )); then
    if (( rc != 0 )); then
      if (( TXN_ACTIVE )); then
        txn_rollback && rolled=true
      fi
      if [[ -z "$FAIL_MESSAGE" ]]; then
        FAIL_MESSAGE="the update stopped at $CURRENT_STEP"
        [[ "$rolled" == true ]] || (( ! TXN_ACTIVE )) || FAIL_MESSAGE+="; some changes could not be put back, run ${TXN_PREVIOUS:-the previous release}'s install.sh in a terminal"
      fi
      status_write failed "$FAIL_MESSAGE" "$rolled"
    else
      status_write "done"
    fi
    sudo -K 2>/dev/null
    PANEL_SUDO_PW=""
  fi
  exit "$rc"
}
trap on_exit EXIT

# ── 1. preflight ─────────────────────────────────────────────

preflight() {
  dmp_step "Checking the system"
  [[ $EUID -ne 0 ]] || dmp_die "run as your normal user, not root; the installer asks for sudo when needed"
  [[ -r "$OS_RELEASE" ]] || dmp_die "cannot read $OS_RELEASE"
  local id like
  id="$(os_field ID)"
  like="$(os_field ID_LIKE)"
  [[ "$id" == ubuntu || "$id" == debian || "$like" == *ubuntu* || "$like" == *debian* ]] \
    || dmp_die "only Ubuntu and Debian are supported (found: $id)"
  command -v sudo >/dev/null || dmp_die "sudo is required"
  command -v apt-get >/dev/null || dmp_die "apt-get is required"
  dmp_ok "$(os_field PRETTY_NAME)"
}

# A field of os-release, like ID or PRETTY_NAME.
# shellcheck source=/dev/null
os_field() { (. "$OS_RELEASE" && printf '%s' "${!1:-}"); }

# True when the given node is 22.13+ (node:sqlite without a flag).
node_ok() {
  [[ -n "$1" && -x "$1" ]] || return 1
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===22&&b>=13)||(a===23&&b>=4)||a>=24?0:1)' 2>/dev/null
}

# Sets NODE_BIN: the panel's own Node when the installer put one there, else
# the node on PATH, else the .nvmrc version from nvm.
find_node() {
  if node_ok "$NODE_DIR/current/bin/node"; then
    NODE_BIN="$NODE_DIR/current/bin/node"
    return 0
  fi
  if ! node_ok "$(command -v node)" && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    (cd "$REPO" && nvm use --silent >/dev/null 2>&1) || true
    nvm use --silent "$(cat "$REPO/.nvmrc")" >/dev/null 2>&1 || true
  fi
  node_ok "$(command -v node)" || return 1
  NODE_BIN="$(command -v node)"
}

# ── 2. settings ──────────────────────────────────────────────

detect_settings() {
  PANEL_USER="$(id -un)"
  PANEL_GROUP="$(id -gn)"
  PANEL_PORT="4710"
  PANEL_DOMAIN="local.devmagic"
  WEB_DIR="/var/www"
  WEB_GROUP="www-data"
  CERTS_DIR="/etc/ssl/localcerts"
  CA_DIR="$CERTS_DIR/devmagic-panel-ca"
  BACKUP_DIR="$HOME/devmagic-panel-backups"
  # Overridable so the tests never read this machine's state (its default PHP) when no config.env says where.
  STATE_DIR="${DMP_INSTALL_STATE_DIR:-/var/lib/devmagic-panel}"
  # Where the panel updates from, like a fork; empty means its own repository.
  UPDATE_REPO=""
  UPDATE_GIT_URL=""
  # nginx next to Apache, each on its own address (scripts/lib/nginx.sh).
  # Overridable like STATE_DIR, so the tests never read whether this machine has nginx set up.
  NGINX_SITES_AVAILABLE="${DMP_INSTALL_NGINX_DIR:-/etc/nginx}/sites-available"
  NGINX_SITES_ENABLED="${DMP_INSTALL_NGINX_DIR:-/etc/nginx}/sites-enabled"
  NGINX_LOG_DIR="/var/log/nginx"
  NGINX_ADDRESS="127.0.0.2"
  APACHE_ADDRESS="127.0.0.1"

  if [[ -r "$CONFIG_DIR/config.env" ]]; then
    local line
    # An if, not &&: a last line that does not match must not fail the step under set -e.
    while IFS= read -r line; do
      if [[ "$line" =~ ^(PANEL_PORT|PANEL_DOMAIN|WEB_DIR|WEB_GROUP|CERTS_DIR|CA_DIR|BACKUP_DIR|STATE_DIR|UPDATE_REPO|UPDATE_GIT_URL|NGINX_SITES_AVAILABLE|NGINX_SITES_ENABLED|NGINX_LOG_DIR|NGINX_ADDRESS|APACHE_ADDRESS)=([A-Za-z0-9._/@:-]*)$ ]]; then
        printf -v "${BASH_REMATCH[1]}" '%s' "${BASH_REMATCH[2]}"
      fi
    done < "$CONFIG_DIR/config.env"
  fi

  # Kept only in the form the panel accepts (REPO_SLUG and GIT_URL in
  # server/src/config.ts), since the panel does not start with any other.
  local slug='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$'
  local remote='^([A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+|(ssh|https|file)://[A-Za-z0-9_.@:/-]+|/[A-Za-z0-9_./-]+)$'
  if [[ -n "$UPDATE_REPO" && ! "$UPDATE_REPO" =~ $slug ]]; then
    dmp_warn "UPDATE_REPO in $CONFIG_DIR/config.env is not owner/name; the panel updates from its own repository"
    UPDATE_REPO=""
  fi
  if [[ -n "$UPDATE_GIT_URL" && ! "$UPDATE_GIT_URL" =~ $remote ]]; then
    dmp_warn "UPDATE_GIT_URL in $CONFIG_DIR/config.env is not a git remote; the panel reads git from UPDATE_REPO"
    UPDATE_GIT_URL=""
  fi
}

write_config() {
  dmp_step "Writing $CONFIG_DIR/config.env"
  as_root install -d -m 0755 -o root -g root "$CONFIG_DIR"
  {
    cat <<EOF
# devmagic-panel system settings, written by install.sh.
# Read by dmp-root (as root) and by the panel. Plain KEY=value only.
PANEL_USER=$PANEL_USER
PANEL_GROUP=$PANEL_GROUP
PANEL_PORT=$PANEL_PORT
PANEL_DOMAIN=$PANEL_DOMAIN
WEB_DIR=$WEB_DIR
WEB_GROUP=$WEB_GROUP
CERTS_DIR=$CERTS_DIR
CA_DIR=$CA_DIR
APACHE_SITES_AVAILABLE=/etc/apache2/sites-available
APACHE_SITES_ENABLED=/etc/apache2/sites-enabled
APACHE_LOG_DIR=/var/log/apache2
HOSTS_FILE=/etc/hosts
SYSTEM_CA_DIR=/usr/local/share/ca-certificates
BACKUP_DIR=$BACKUP_DIR
PHP_CONF_DIR=/etc/php
PHP_LIB_DIR=/usr/lib/php
STATE_DIR=$STATE_DIR
NGINX_SITES_AVAILABLE=$NGINX_SITES_AVAILABLE
NGINX_SITES_ENABLED=$NGINX_SITES_ENABLED
NGINX_LOG_DIR=$NGINX_LOG_DIR
NGINX_ADDRESS=$NGINX_ADDRESS
APACHE_ADDRESS=$APACHE_ADDRESS
EOF
    # Only when set: without them the panel updates from its own repository.
    if [[ -n "$UPDATE_REPO" ]]; then printf 'UPDATE_REPO=%s\n' "$UPDATE_REPO"; fi
    if [[ -n "$UPDATE_GIT_URL" ]]; then printf 'UPDATE_GIT_URL=%s\n' "$UPDATE_GIT_URL"; fi
  } | write_root_file "$CONFIG_DIR/config.env" 0644
  record dir "$CONFIG_DIR" remove "settings folder"
  record file "$CONFIG_DIR/config.env" remove "settings read by dmp-root and the panel"
}

# ── 3. what the panel needs ──────────────────────────────────

# Every dependency is reported first, then:
# - required: the panel cannot install a site without them. One question
#   installs all that are missing (--yes installs them); no stops the install.
# - recommended (yes by default) and optional (no by default): asked one by
#   one, skipped by --yes and --skip-optional.
# - for installs from an organization: one question, no by default. Signing
#   in to them stays yours.
# Uninstall keeps packages: sites and other tools use them too.

PHP_PKGS=(php php-mysql php-curl php-gd php-intl php-mbstring php-xml php-zip)
MIN_PHP=8.1
CLAUDE_INSTALLER="https://claude.ai/install.sh"
MAILPIT_UNIT_FILE="$HOME/.config/systemd/user/devmagic-panel-mailpit.service"
# What this run installs, filled by check_dependencies.
APT_PKGS=()
WANT_WPCLI=0
WANT_NODE=0
WANT_MAILPIT=0
WANT_CLAUDE=0
WANT_PHPMYADMIN=0
WANT_ORG=0
# nginx: installed in an apt-get of its own, after Apache holds port 80, then set up next to Apache.
WANT_NGINX_PACKAGE=0
WANT_NGINX=0

# The panel's files in nginx's sites-available: sites it moved to nginx, one per line.
nginx_panel_sites() {
  local file
  for file in "$NGINX_SITES_AVAILABLE"/*.conf; do
    [[ -r "$file" && "$(head -n 1 "$file")" == "# Managed by devmagic-panel. Edits here are overwritten." ]] && printf '%s\n' "$file"
  done
  return 0
}

# Every site on nginx back to Apache, as site.setServer does: a vhost with its
# names and uploads redirect, then off nginx, then its hosts line follows.
nginx_sites_back_to_apache() {
  local file domain proxy
  local -a names
  while IFS= read -r file; do
    domain="$(basename "$file" .conf)"
    read -r -a names <<< "$(sed -nE 's/^[[:space:]]*server_name[[:space:]]+([^;]+);.*$/\1/p' "$file" | head -n 1)"
    [[ "${names[0]:-}" == "$domain" ]] || { dmp_warn "left $file alone: its first name is not $domain"; continue; }
    # shellcheck disable=SC2016 # $request_uri is nginx's, matched as text
    proxy="$(sed -nE 's#^[[:space:]]*return 302 https://([a-z0-9.-]+)\$request_uri;.*$#\1#p' "$file" | head -n 1)"
    dmp_step "Moving $domain back to Apache"
    as_root "$DMP" vhost-write "$domain" ${proxy:+--uploads-proxy "$proxy"} "${names[@]:1}" || { dmp_warn "could not write the Apache vhost of $domain"; continue; }
    as_root "$DMP" nginx-site-remove "$domain" || dmp_warn "could not take $domain off nginx"
    as_root "$DMP" hosts-add "${names[@]}" || dmp_warn "could not point the hosts line of $domain at Apache"
  done < <(nginx_panel_sites)
}

# The panel's nginx settings, written by dmp-root nginx-setup: their marker says nginx runs next to Apache.
nginx_conf_file() { printf '%s/conf.d/devmagic-panel.conf' "$(dirname "$NGINX_SITES_AVAILABLE")"; }
nginx_set_up() {
  local conf
  conf="$(nginx_conf_file)"
  [[ -r "$conf" && "$(head -n 1 "$conf")" == "# Managed by devmagic-panel. Edits here are overwritten." ]]
}

# MySQL on Ubuntu and its family; Debian has MariaDB in its place.
database_package() {
  local id like
  id="$(os_field ID)"
  like="$(os_field ID_LIKE)"
  if [[ "$id" == ubuntu || "$like" == *ubuntu* ]]; then echo mysql-server; else echo mariadb-server; fi
}

# A MySQL or MariaDB server of any version or source. dpkg-query fails when a
# pattern matches nothing, which pipefail would pass on.
has_database() {
  { dpkg-query -W -f='${Package} ${Status}\n' 'mysql-server*' 'mariadb-server*' 'mysql-community-server*' 2>/dev/null || true; } | grep -q ' install ok installed$'
}

claude_found() {
  command -v claude >/dev/null || [[ -x "$HOME/.local/bin/claude" || -x "$HOME/.claude/local/claude" ]]
}

# One line of the report.
report() { printf '   %-8s %s%s\n' "$1" "$2" "${3:+ ($3)}"; }

# Reports a group of packages and adds the missing ones to the named array.
report_pkgs() {
  # shellcheck disable=SC2178
  local -n into="$1"
  local what="$2" pkg
  local -a absent=()
  shift 2
  for pkg in "$@"; do
    has_pkg "$pkg" || absent+=("$pkg")
  done
  if (( ${#absent[@]} == 0 )); then
    report ok "$what"
  else
    report missing "$what" "${absent[*]}"
    into+=("${absent[@]}")
  fi
}

# True when apt has a version of the package to install, from the sources it has.
apt_has() { apt-cache policy "$1" 2>/dev/null | grep -Eq 'Candidate: [0-9]'; }

# Where glab comes from on a release whose apt has none (Ubuntu 22.04, Debian 12).
GLAB_INSTALL_URL="https://gitlab.com/gitlab-org/cli#installation"

# Reports one command, and adds its package to the named array when missing.
report_cmd() {
  # shellcheck disable=SC2178
  local -n into="$1"
  if command -v "$3" >/dev/null; then
    report ok "$2"
  else
    report missing "$2" "$4"
    into+=("$4")
  fi
}

# The PHP version sites run on, like 8.3: mod_php's, else the one the panel
# runs every site on through PHP-FPM, else the command line's. Empty before PHP.
site_php_version() {
  local v
  v="$(dpkg-query -W -f='${binary:Package} ${Status}\n' 'libapache2-mod-php*' 2>/dev/null | awk '/install ok installed/ { sub(/:.*/, "", $1); sub(/^libapache2-mod-php/, "", $1); print $1 }' | grep -E '^[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
  [[ -n "$v" ]] || v="$(head -n 1 "$STATE_DIR/php-default" 2>/dev/null || true)"
  [[ -n "$v" ]] || v="$(php -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;' 2>/dev/null || true)"
  [[ "$v" =~ ^[0-9]+\.[0-9]+$ ]] && printf '%s\n' "$v"
  return 0
}

check_dependencies() {
  dmp_step "Checking what the panel needs"
  local -a required=() recommended=() optional=() org=() php_pkgs=("${PHP_PKGS[@]}")
  local db php_version="" pkg pv

  printf '   Required\n'
  report_pkgs required "Apache" apache2
  command -v php >/dev/null && php_version="$(php -r 'echo PHP_VERSION;' 2>/dev/null || true)"
  # Once PHP is here, its packages go by version (php8.3-imagick): one without a
  # version follows the newest PHP the apt sources have, and with the ondrej/php
  # PPA that pulls a whole other PHP in and points php on the command line at it.
  pv="$(site_php_version)"
  if [[ -n "$pv" ]]; then
    php_pkgs=("php$pv-cli")
    for pkg in "${PHP_PKGS[@]:1}"; do php_pkgs+=("php$pv-${pkg#php-}"); done
  fi
  report_pkgs required "PHP${pv:+ $pv} with the WordPress modules" "${php_pkgs[@]}"
  # A machine with mod_php keeps it; a new one runs PHP through PHP-FPM, with the panel's handler for every site.
  if has_pkg 'libapache2-mod-php*' || has_pkg 'php*-fpm'; then
    report ok "PHP for Apache (mod_php or PHP-FPM)"
  else
    report missing "PHP for Apache" "php$pv-fpm"
    required+=("php$pv-fpm")
  fi
  db="$(database_package)"
  if has_database; then report ok "MySQL or MariaDB server"; else report missing "MySQL or MariaDB server" "$db"; required+=("$db"); fi
  report_pkgs required "Certificates and browser trust" openssl ca-certificates libnss3-tools
  report_pkgs required "curl, git and unzip" curl git unzip
  if command -v wp >/dev/null; then report ok "WP-CLI"; else report missing "WP-CLI" "to /usr/local/bin/wp"; WANT_WPCLI=1; fi
  if find_node; then
    report ok "Node.js $NODE_MAJOR.13 or newer" "$("$NODE_BIN" --version) at $NODE_BIN"
  else
    report missing "Node.js $NODE_MAJOR.13 or newer" "found: $(node --version 2>/dev/null || echo none)"
    WANT_NODE=1
  fi

  printf '   Recommended\n'
  report_cmd recommended "Composer, for repos with a composer.json and the PHP compatibility check" composer composer
  report_pkgs recommended "Imagick, for image editing in WordPress" "php$pv-imagick"
  if has_pkg 'libapache2-mod-php*'; then
    report_pkgs recommended "PHP-FPM, so a site can have its own PHP version and settings" "php$pv-fpm"
  fi
  if [[ -f "$MAILPIT_UNIT_FILE" ]]; then report ok "Mailpit, catches the mail of local sites"; else report missing "Mailpit, catches the mail of local sites" "the panel's own copy"; fi

  printf '   Optional\n'
  report_pkgs optional "Xdebug" "php$pv-xdebug"
  report_pkgs optional "phpMyAdmin" phpmyadmin
  if ! has_pkg nginx; then
    report optional "nginx, to run sites on it next to Apache" nginx
    optional+=(nginx)
  elif nginx_set_up; then
    report ok "nginx, next to Apache" "on $NGINX_ADDRESS, Apache on $APACHE_ADDRESS"
  else
    report optional "nginx, next to Apache" "installed, not set up"
    optional+=(nginx-setup)
  fi

  printf '   For installs from an organization\n'
  report_cmd org "GitHub CLI" gh gh
  # Only for GitLab groups, so never in the group question below: GitHub-only setups are not asked about it.
  if command -v glab >/dev/null; then
    report ok "GitLab CLI, for GitLab groups"
  elif apt_has glab; then
    report optional "GitLab CLI, for GitLab groups" "sudo apt install glab"
  else
    report optional "GitLab CLI, for GitLab groups" "$GLAB_INSTALL_URL"
  fi
  report_cmd org "rclone, for dumps on Google Drive" rclone rclone
  if claude_found; then report ok "Claude Code"; else report missing "Claude Code" "its official installer"; fi

  php_version="${pv:-$php_version}"
  if [[ -n "$php_version" ]] && [[ "$(printf '%s\n%s\n' "$MIN_PHP" "$php_version" | sort -V | head -n 1)" != "$MIN_PHP" ]]; then
    dmp_warn "PHP $php_version is older than $MIN_PHP: current WordPress and its plugins expect $MIN_PHP or newer"
  fi
  if has_pkg nginx && ! nginx_set_up && (( SKIP_OPTIONAL )); then
    dmp_warn "nginx is installed but not set up: set it up next to Apache on the panel's Services page, nginx tab"
  fi

  # Required: one question for everything missing.
  if (( ${#required[@]} > 0 || WANT_WPCLI )); then
    local list="${required[*]}"
    (( WANT_WPCLI )) && list="${list:+$list }WP-CLI"
    if ! confirm "Install what the panel needs: $list?" y; then
      (( ${#required[@]} > 0 )) && dmp_error "install them with: sudo apt-get install ${required[*]}"
      (( WANT_WPCLI )) && dmp_error "and WP-CLI: https://wp-cli.org/#installing"
      dmp_die "the panel cannot install sites without them"
    fi
    APT_PKGS+=("${required[@]}")
  fi
  if (( WANT_NODE )); then
    confirm "Download Node.js $NODE_MAJOR from nodejs.org into $NODE_DIR, for the panel only?" y \
      || dmp_die "Node.js $NODE_MAJOR.13 or newer is required: install it yourself, for example with nvm install $NODE_MAJOR, and run the installer again"
  fi

  (( SKIP_OPTIONAL )) && return 0
  for pkg in "${recommended[@]}"; do
    case "$pkg" in
      composer) confirm "Install Composer?" y && APT_PKGS+=(composer) ;;
      php*-imagick) confirm "Install Imagick?" y && APT_PKGS+=("$pkg") ;;
      # Apache keeps running sites on mod_php: the panel sends a site to FPM only when you give it a PHP of its own.
      php*-fpm) confirm "Install PHP-FPM?" y && APT_PKGS+=("$pkg") ;;
    esac
  done
  if [[ ! -f "$MAILPIT_UNIT_FILE" ]] && confirm "Install Mailpit, so local sites never email real people?" y; then WANT_MAILPIT=1; fi
  for pkg in "${optional[@]}"; do
    case "$pkg" in
      php*-xdebug) confirm "Install Xdebug?" n && APT_PKGS+=("$pkg") ;;
      phpmyadmin) confirm "Install phpMyAdmin?" n && WANT_PHPMYADMIN=1 ;;
      nginx) confirm "Install nginx and run it next to Apache? Apache moves to $APACHE_ADDRESS, nginx answers on $NGINX_ADDRESS, and every site stays on Apache until you move it" n && { WANT_NGINX_PACKAGE=1; WANT_NGINX=1; } ;;
      nginx-setup) confirm "Set nginx up next to Apache? Apache moves to $APACHE_ADDRESS, nginx answers on $NGINX_ADDRESS, and every site stays on Apache until you move it" n && WANT_NGINX=1 ;;
    esac
  done
  claude_found || org+=("Claude Code")
  local names
  names="$(printf '%s, ' "${org[@]}")"
  if (( ${#org[@]} > 0 )) && confirm "Install the tools for installs from an organization: ${names%, }?" n; then
    WANT_ORG=1
    for pkg in "${org[@]}"; do
      if [[ "$pkg" == "Claude Code" ]]; then WANT_CLAUDE=1; else APT_PKGS+=("$pkg"); fi
    done
  fi
  return 0
}

# Installs what check_dependencies settled on.
install_dependencies() {
  if (( ${#APT_PKGS[@]} > 0 || WANT_PHPMYADMIN || WANT_NGINX_PACKAGE )); then
    dmp_step "Installing packages"
    apt_update
    (( ${#APT_PKGS[@]} > 0 )) && as_root apt-get install -y -qq "${APT_PKGS[@]}"
    # phpMyAdmin asks its own questions (web server, database).
    (( WANT_PHPMYADMIN )) && as_root apt-get install -y phpmyadmin
    # After Apache holds port 80: the package then leaves nginx stopped instead of taking it.
    (( WANT_NGINX_PACKAGE )) && as_root apt-get install -y -qq nginx
    local -a all=("${APT_PKGS[@]}")
    (( WANT_PHPMYADMIN )) && all+=(phpmyadmin)
    (( WANT_NGINX_PACKAGE )) && all+=(nginx)
    record packages "apt:${all[*]}" keep "packages the panel and your sites use, installed by install.sh"
  fi
  (( WANT_WPCLI )) && install_wpcli
  (( WANT_NODE )) && install_node
  (( WANT_CLAUDE )) && install_claude_code
  return 0
}

# apt-get update, which fails as a whole when any one source on the machine
# fails. Then it says which source it was, in which file and why, since it is
# usually one another app added, not the panel's.
apt_update() {
  if (( DRY_RUN )); then
    as_root apt-get update -qq
    return 0
  fi
  local out
  # English messages, whatever the system language, so they can be read below.
  if out="$(root_run env LC_ALL=C apt-get update -qq 2>&1)"; then
    [[ -z "$out" ]] || printf '%s\n' "$out"
    return 0
  fi
  printf '%s\n' "$out" >&2
  explain_apt_failure "$out"
  exit 1
}

# Usage: explain_apt_failure <the output of apt-get update>
explain_apt_failure() {
  local line url key file
  local -a urls=()
  local -A why=() keys=()
  while IFS= read -r line; do
    [[ "$line" =~ ^[EW]:\  && "$line" =~ (https?://[^\ \']+) ]] || continue
    url="${BASH_REMATCH[1]%/}"
    [[ -n "${why[$url]+x}" ]] || { urls+=("$url"); why[$url]=""; }
    if [[ "$line" =~ NO_PUBKEY\ ([0-9A-F]+) ]]; then
      keys[$url]="${BASH_REMATCH[1]}"
    elif [[ "$line" == *"is not signed"* && -z "${why[$url]}" ]]; then
      why[$url]="it is not signed with a key apt knows"
    elif [[ "$line" == *"does not have a Release file"* || "$line" == *" 404 "* ]]; then
      why[$url]="it has no packages for this system's release"
    elif [[ "$line" == *"Could not resolve"* || "$line" == *"Failed to fetch"* ]]; then
      [[ -n "${why[$url]}" ]] || why[$url]="it could not be reached"
    fi
  done <<< "$1"

  if (( ${#urls[@]} == 0 )); then
    dmp_error "apt-get update failed: run sudo apt-get update to see why, fix it, then run install.sh again"
    return 0
  fi
  dmp_error "apt-get update failed on a package source on this machine, not on the panel:"
  for url in "${urls[@]}"; do
    file="$(grep -rlF -- "$url" "$APT_DIR/sources.list" "$APT_DIR/sources.list.d" 2>/dev/null | head -n 1 || true)"
    key="${keys[$url]:-}"
    printf '   %s\n' "$url" >&2
    [[ -z "$file" ]] || printf '     in %s\n' "$file" >&2
    if [[ -n "$key" ]]; then
      printf '     its signing key is missing (NO_PUBKEY %s)\n' "$key" >&2
      local ring
      ring="$(keyring_with "$key")"
      if [[ -n "$ring" && -n "$file" ]]; then
        printf '     The key is on this machine, in %s, but that source does not point at it.\n' "$ring" >&2
        printf '     Add signed-by=%s to its options, as in:\n' "$ring" >&2
        printf '       deb [signed-by=%s] %s ...\n' "$ring" "$url" >&2
      fi
    elif [[ -n "${why[$url]}" ]]; then
      printf '     %s\n' "${why[$url]}" >&2
    fi
  done
  printf 'Fix it (reinstalling the app that added it often brings its key back), or turn\n' >&2
  printf 'it off for now, then run install.sh again:\n' >&2
  for url in "${urls[@]}"; do
    file="$(grep -rlF -- "$url" "$APT_DIR/sources.list.d" 2>/dev/null | head -n 1 || true)"
    [[ -z "$file" ]] || printf '   sudo mv %s %s.disabled\n' "$file" "$file" >&2
  done
  return 0
}

# The keyring file that holds a key, by its last 16 hex digits; empty when none does.
keyring_with() {
  command -v gpg >/dev/null 2>&1 || return 0
  local dir ring
  for dir in $APT_KEYRING_DIRS; do
    for ring in "$dir"/*.gpg "$dir"/*.asc; do
      [[ -f "$ring" ]] || continue
      if gpg --show-keys --with-colons "$ring" 2>/dev/null | grep -q "^fpr:.*$1:\$"; then
        printf '%s\n' "$ring"
        return 0
      fi
    done
  done
}

install_wpcli() {
  dmp_step "Installing WP-CLI to /usr/local/bin/wp"
  local tmp
  tmp="$(mktemp)"
  as_user curl -fsSL --proto '=https' -o "$tmp" https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
  as_root install -m 0755 "$tmp" /usr/local/bin/wp
  rm -f "$tmp"
  record file /usr/local/bin/wp keep "WP-CLI; sites and other tools use it too"
}

# The newest official Node.js NODE_MAJOR build, checked against nodejs.org's
# SHASUMS256.txt, in NODE_DIR/<version>, with NODE_DIR/current pointing at it.
install_node() {
  local arch base file name tmp
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) dmp_die "no Node.js build for $(uname -m): install Node $NODE_MAJOR.13 or newer yourself and run the installer again" ;;
  esac
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  dmp_step "Downloading Node.js $NODE_MAJOR for the panel"
  if (( DRY_RUN )); then
    printf '   [dry-run] download %s/node-v%s.<newest>-linux-%s.tar.gz, check it against SHASUMS256.txt, unpack it into %s\n' "$base" "$NODE_MAJOR" "$arch" "$NODE_DIR"
    NODE_BIN="$NODE_DIR/current/bin/node"
    return
  fi
  tmp="$(mktemp -d)"
  local -a get=(curl -fsSL --proto '=https' --proto-redir '=https')
  "${get[@]}" -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt" || dmp_die "could not reach nodejs.org"
  file="$(grep -oE "node-v$NODE_MAJOR\.[0-9]+\.[0-9]+-linux-$arch\.tar\.gz$" "$tmp/SHASUMS256.txt" | head -n 1)"
  [[ -n "$file" ]] || dmp_die "nodejs.org lists no Node.js $NODE_MAJOR build for linux-$arch"
  "${get[@]}" -o "$tmp/$file" "$base/$file" || dmp_die "could not download $file"
  (cd "$tmp" && grep -E "^[0-9a-f]{64}  $file\$" SHASUMS256.txt | sha256sum -c --quiet -) \
    || dmp_die "$file does not match its checksum; nothing was installed"
  name="${file%.tar.gz}"
  mkdir -p "$NODE_DIR"
  rm -rf -- "${NODE_DIR:?}/.incoming"
  mkdir "$NODE_DIR/.incoming"
  tar -xzf "$tmp/$file" -C "$NODE_DIR/.incoming" --strip-components=1 --no-same-owner
  rm -rf -- "${NODE_DIR:?}/$name"
  mv -T -- "$NODE_DIR/.incoming" "$NODE_DIR/$name"
  ln -sfn "$name" "$NODE_DIR/current.new"
  mv -T -- "$NODE_DIR/current.new" "$NODE_DIR/current"
  # Only the one current points at stays.
  find "$NODE_DIR" -mindepth 1 -maxdepth 1 -type d -name 'node-v*' ! -name "$name" -exec rm -rf -- {} +
  rm -rf -- "$tmp"
  NODE_BIN="$NODE_DIR/current/bin/node"
  node_ok "$NODE_BIN" || dmp_die "the downloaded Node.js does not run here"
  dmp_ok "Node.js $("$NODE_BIN" --version) in $NODE_DIR, for the panel only"
  record dir "$NODE_DIR" remove "Node.js for the panel only, downloaded by install.sh"
}

# Claude Code's official installer, as you: it goes to ~/.local/bin.
install_claude_code() {
  dmp_step "Installing Claude Code"
  local tmp
  tmp="$(mktemp)"
  if as_user curl -fsSL --proto '=https' --proto-redir '=https' -o "$tmp" "$CLAUDE_INSTALLER" && as_user bash "$tmp"; then
    record file "$HOME/.local/bin/claude" keep "Claude Code; you use it outside the panel too"
  else
    dmp_warn "Claude Code was not installed: see https://docs.claude.com/en/docs/claude-code/setup"
  fi
  rm -f "$tmp"
}

# Mailpit through the panel's own CLI, like its Services page: the pinned
# release, checked against its checksum, as a user service.
install_mailpit() {
  (( WANT_MAILPIT )) || return 0
  dmp_step "Installing Mailpit"
  as_user "$NODE_BIN" --disable-warning=ExperimentalWarning "$RUN_DIR/server/dist/cli.js" install-mailpit \
    || dmp_warn "Mailpit was not installed: install it from the panel's Services page"
}

# ── 4. the release, scripts and sudoers ─────────────────────

# A field of a release.json: "name", "version", "commit".
release_field() { sed -nE "s/^  \"$1\": \"([^\"]*)\",?$/\\1/p" "$2" | head -n 1; }

# What this run installs, for the log: the release, or the checkout's commit.
source_label() {
  if [[ -f "$REPO/release.json" ]]; then
    release_field name "$REPO/release.json"
  else
    git -C "$REPO" describe --always --tags --dirty 2>/dev/null || echo 'unknown version'
  fi
}

# Puts the release the panel runs from in RELEASES_DIR/<name>:
# - run from a release there (the panel downloaded it, or current): as it is;
# - run from a release elsewhere (get.sh's download, or one unpacked by hand):
#   copied there;
# - run from a git checkout: the checked out commit, built and packed like a
#   release in a temporary folder, then unpacked there. Uncommitted changes
#   are not in it. A folder that is neither is built as it is.
prepare_release() {
  if [[ -f "$REPO/release.json" ]]; then
    RELEASE_NAME="$(release_field name "$REPO/release.json")"
    [[ "$RELEASE_NAME" =~ $NAME_RE ]] || dmp_die "$REPO/release.json has no release name"
    # REPO is a physical path (readlink -f), so compare with the folder's own.
    if [[ "$REPO" == "$(cd "$RELEASES_DIR" 2>/dev/null && pwd -P)/$RELEASE_NAME" ]]; then
      dmp_step "Installing release $RELEASE_NAME"
    else
      dmp_step "Copying release $RELEASE_NAME to $RELEASES_DIR"
      as_user rm -rf -- "$RELEASES_DIR/.incoming-$RELEASE_NAME"
      as_user mkdir -p "$RELEASES_DIR/.incoming-$RELEASE_NAME"
      as_user cp -a "$REPO/." "$RELEASES_DIR/.incoming-$RELEASE_NAME/"
      place_release "$RELEASES_DIR/.incoming-$RELEASE_NAME"
    fi
  else
    build_release
  fi
  RUN_DIR="$RELEASES_DIR/$RELEASE_NAME"
  if (( ! DRY_RUN )); then
    SRC="$RUN_DIR"
  fi
  dmp_ok "release $RELEASE_NAME in $RUN_DIR"
}

# Builds this folder's checked out commit and packs it with scripts/package.sh,
# the way the release workflow does, then unpacks the package.
build_release() {
  local build commit version package
  version="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$REPO/package.json" | head -n 1)"
  if (( DRY_RUN )); then
    build="${TMPDIR:-/tmp}/devmagic-panel-build.XXXXXX"
  else
    build="$(mktemp -d "${TMPDIR:-/tmp}/devmagic-panel-build.XXXXXX")"
    BUILD_TMP="$build"
  fi
  if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
    commit="$(git -C "$REPO" rev-parse HEAD)"
    dmp_step "Building $(git -C "$REPO" describe --always --tags "$commit" 2>/dev/null || echo "$commit") into a release"
    if [[ -n "$(git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
      dmp_warn "uncommitted changes in $REPO are not installed; commit them to include them"
    fi
    as_user git clone --quiet --no-checkout "$REPO" "$build/src"
    as_user git -C "$build/src" checkout --quiet --detach "$commit"
  else
    dmp_step "Building $REPO into a release"
    as_user cp -a "$REPO/." "$build/src/"
  fi
  # The build tools are dev dependencies; NODE_ENV=production in your shell would leave them out.
  as_user npm --prefix "$build/src" ci --include=dev --no-audit --no-fund --silent
  as_user npm --prefix "$build/src" run build --silent
  as_user bash "$build/src/scripts/package.sh" --out "$build/out"
  if (( DRY_RUN )); then
    RELEASE_NAME="v$version-dev"
    printf '   [dry-run] unpack %s/out/devmagic-panel-<name>.tar.gz into %s/<name>\n' "$build" "$RELEASES_DIR"
    return
  fi
  package="$(find "$build/out" -maxdepth 1 -name 'devmagic-panel-*.tar.gz' | head -n 1)"
  [[ -n "$package" ]] || dmp_die "the build made no package"
  RELEASE_NAME="$(basename "$package" .tar.gz)"
  RELEASE_NAME="${RELEASE_NAME#devmagic-panel-}"
  [[ "$RELEASE_NAME" =~ $NAME_RE ]] || dmp_die "not a release package: $package"
  mkdir -p "$RELEASES_DIR/.incoming-$RELEASE_NAME"
  tar -xzf "$package" -C "$RELEASES_DIR/.incoming-$RELEASE_NAME" --strip-components=1 --no-same-owner
  place_release "$RELEASES_DIR/.incoming-$RELEASE_NAME"
}

# Moves an unpacked release into RELEASES_DIR/RELEASE_NAME. One of the same
# name goes, even the running one: its files stay open until the restart.
place_release() {
  local incoming="$1" dest="$RELEASES_DIR/$RELEASE_NAME"
  if [[ -e "$dest" ]]; then
    as_user mv -T -- "$dest" "$RELEASES_DIR/.old-$RELEASE_NAME"
  fi
  as_user mv -T -- "$incoming" "$dest"
  as_user rm -rf -- "$RELEASES_DIR/.old-$RELEASE_NAME"
}

# Points current at the release in one rename, so the service starts it.
switch_current() {
  as_user ln -sfn "releases/$RELEASE_NAME" "$CURRENT_LINK.new"
  as_user mv -T -- "$CURRENT_LINK.new" "$CURRENT_LINK"
  record dir "$RELEASES_DIR" remove "the installed releases of the panel: its code and dependencies"
  record link "$CURRENT_LINK" remove "points at the release the panel runs from"
}

# Keeps the running release and the newest others, and removes what an
# interrupted run left. Also the v0.5 clone, now that a release runs.
tidy_releases() {
  local name kept=1
  if [[ -d "$LEGACY_APP_DIR" ]]; then
    dmp_step "Removing the v0.5 copy of the panel in $LEGACY_APP_DIR"
    as_user rm -rf -- "$LEGACY_APP_DIR"
  fi
  [[ -d "$RELEASES_DIR" ]] || return 0
  while IFS= read -r name; do
    if [[ "$name" == .incoming-* || "$name" == .old-* ]]; then
      as_user rm -rf -- "${RELEASES_DIR:?}/$name"
    elif [[ "$name" != "$RELEASE_NAME" ]]; then
      if (( kept < KEEP_RELEASES )); then
        kept=$((kept + 1))
      else
        as_user rm -rf -- "${RELEASES_DIR:?}/$name"
      fi
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2-)
  return 0
}

install_scripts() {
  dmp_step "Installing root scripts to $DMP_PREFIX"
  # From the panel the new scripts are staged next to the old ones and swapped
  # in whole, so old and new files are never mixed.
  local dest="$DMP_PREFIX"
  if (( FROM_PANEL )); then
    dest="$TXN_DIR/new"
    as_root rm -rf -- "$dest"
    as_root cp -a -- "$DMP_PREFIX" "$dest"
  fi
  as_root install -d -m 0755 -o root -g root "$dest/bin" "$dest/lib" "$dest/php"
  as_root install -m 0755 -o root -g root "$SRC/scripts/bin/dmp-root" "$SRC/scripts/bin/dmp-restore" "$SRC/scripts/bin/wpcore" "$dest/bin/"
  as_root install -m 0644 -o root -g root "$SRC"/scripts/lib/*.sh "$dest/lib/"
  # PHP's view of itself for the PHP tab, and the page Apache answers with
  # while the panel starts, served by the panel's vhost to this computer only.
  as_root install -m 0644 -o root -g root "$SRC"/scripts/php/*.php "$SRC/scripts/php/starting.html" "$dest/php/"
  if (( FROM_PANEL )); then
    TXN_SCRIPTS=1
    as_root mv -T -- "$DMP_PREFIX" "$TXN_DIR/old"
    as_root mv -T -- "$dest" "$DMP_PREFIX"
    as_root rm -rf -- "$TXN_DIR/old"
  fi
  record dir "$DMP_PREFIX" remove "root-owned scripts the sudoers rule allows"
  local file
  for file in dmp-root dmp-restore wpcore; do
    record file "$DMP_PREFIX/bin/$file" remove "root script"
  done
  for file in "$SRC"/scripts/lib/*.sh; do
    record file "$DMP_PREFIX/lib/$(basename "$file")" remove "library of the root scripts"
  done
  for file in "$SRC"/scripts/php/*.php; do
    record file "$DMP_PREFIX/php/$(basename "$file")" remove "PHP info script for the panel's PHP tab"
  done
  record file "$DMP_PREFIX/php/starting.html" remove "the page Apache shows while the panel starts"

  if [[ ! -e /usr/local/bin/wpcore ]]; then
    as_root ln -s "$DMP_PREFIX/bin/wpcore" /usr/local/bin/wpcore
    record link /usr/local/bin/wpcore remove "the wpcore command, linked to the bundled copy"
  elif ! cmp -s /usr/local/bin/wpcore "$SRC/scripts/bin/wpcore"; then
    dmp_warn "/usr/local/bin/wpcore differs from the bundled copy, leaving yours in place"
  fi

  # One wpcore config and one cores folder, shared by the CLI and the panel.
  if [[ -f /etc/wpcore.conf ]]; then
    local cores_dir
    cores_dir="$(sed -n 's/^CORES_DIR=["'\'']\{0,1\}\([^"'\'']*\).*/\1/p' /etc/wpcore.conf | head -n 1)"
    dmp_ok "reusing /etc/wpcore.conf and its cores in ${cores_dir:-/var/www/wp-cores}, shared with the wpcore CLI"
  else
    as_root "$DMP_PREFIX/bin/wpcore" init
    record file /etc/wpcore.conf keep "wpcore settings, shared with the wpcore command"
  fi
}

install_sudoers() {
  dmp_step "Allowing $PANEL_USER to run dmp-root and wpcore without a password"
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
# devmagic-panel: only these two root-owned commands, nothing else.
$PANEL_USER ALL=(root) NOPASSWD: $DMP_PREFIX/bin/dmp-root, $DMP_PREFIX/bin/wpcore
EOF
  if (( DRY_RUN )); then
    printf '   [dry-run] write %s:\n' "$SUDOERS_FILE"
    sed 's/^/      | /' "$tmp"
  else
    root_run visudo -cqf "$tmp" || dmp_die "generated sudoers file is invalid"
    root_run install -m 0440 -o root -g root "$tmp" "$SUDOERS_FILE"
  fi
  rm -f "$tmp"
  record file "$SUDOERS_FILE" remove "lets you run dmp-root and wpcore without a password"
}

# ── 5. backup, apache, CA ────────────────────────────────────

backup() {
  dmp_step "Backing up certs, vhosts and hosts before changing anything"
  if (( FROM_PANEL && ! DRY_RUN )); then
    # Which archive it wrote, for dmp-restore when the update has to be put back.
    local out
    out="$(as_root "$DMP" backup)"
    printf '%s\n' "$out"
    TXN_BACKUP="$(printf '%s\n' "$out" | strip_colors | sed -n 's/.*backup written: //p' | tail -n 1)"
    [[ -n "$TXN_BACKUP" ]] || fail "dmp-root backup did not say which archive it wrote"
  else
    as_root "$DMP" backup
  fi
  record dir "$BACKUP_DIR" ask "backups of certs, vhosts and hosts, and database snapshots"
  record dir "$STATE_DIR" ask "the registry of panel-made sites and the deleted sites"
}

enable_apache_modules() {
  dmp_step "Enabling Apache modules"
  local mod
  for mod in ssl rewrite headers proxy proxy_http proxy_wstunnel; do
    as_root "$DMP" apache-module-enable "$mod"
  done
  record modules "apache:ssl rewrite headers proxy proxy_http proxy_wstunnel" keep "Apache modules the panel turned on; sites use them too"
}

# Without mod_php, Apache serves .php files as text until something sends them
# to PHP: on a machine with PHP-FPM only, the panel's handler sends every site
# to it (dmp-root php-switch-fpm, which also puts Apache on mpm_event). A
# machine with mod_php is left as it is; the PHP tab switches it when you ask.
setup_php_fpm() {
  local version
  if has_pkg 'libapache2-mod-php*' || ! has_pkg 'php*-fpm'; then
    if (( DRY_RUN )) && ! has_pkg 'libapache2-mod-php*'; then
      dmp_ok "PHP-FPM would run every site, with the panel's handler for .php files"
    fi
    return 0
  fi
  # Switched already (an earlier run, or the PHP tab): nothing to do.
  if [[ -f "$STATE_DIR/php-default" ]]; then
    dmp_ok "every site runs on PHP $(head -n 1 "$STATE_DIR/php-default") through PHP-FPM"
    return 0
  fi
  version="$(php -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;' 2>/dev/null || true)"
  [[ "$version" =~ ^[0-9]\.[0-9]$ ]] || { dmp_warn "PHP's version could not be read, so PHP-FPM is not set up for every site: use the PHP tab"; return 0; }
  dmp_step "Running every site on PHP $version through PHP-FPM"
  as_root "$DMP" php-switch-fpm "$version"
}

setup_ca() {
  as_root "$DMP" ca-create
  as_root "$DMP" ca-trust
  record dir "$CA_DIR" ask "the local CA, its key and certificate; uninstall removes it when no site certificate is signed with it"
  record file "$SYSTEM_CA_FILE" ask "the local CA in the system trust store; goes with the CA"
}

# Adds the CA to Chrome/Chromium (~/.pki/nssdb) and every Firefox profile.
trust_ca_in_browsers() {
  dmp_step "Adding the CA to Chrome, Edge and Firefox"
  local ca_cert="$CA_DIR/ca.pem" db
  if (( ! DRY_RUN )) && [[ ! -r "$ca_cert" ]]; then
    dmp_warn "cannot read $ca_cert, import it in your browser by hand"
    return
  fi
  if [[ ! -d "$HOME/.pki/nssdb" ]]; then
    as_user mkdir -p "$HOME/.pki/nssdb"
    as_user certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password
  fi
  local -a dbs=("$HOME/.pki/nssdb")
  for db in "$HOME"/.mozilla/firefox/*/ "$HOME"/snap/firefox/common/.mozilla/firefox/*/; do
    [[ -f "$db/cert9.db" ]] && dbs+=("${db%/}")
  done
  for db in "${dbs[@]}"; do
    as_user certutil -A -d "sql:$db" -n "$NSS_NICKNAME" -t "C,," -i "$ca_cert"
    record store "$db" ask "the local CA in this browser certificate store, as $NSS_NICKNAME; goes with the CA"
  done
  dmp_ok "CA added to ${#dbs[@]} browser store(s) (Chrome and Edge share one); close and reopen your browsers once"
}

# Sites made by devmagic or by hand keep their vhosts; only their certs are
# reissued from the new CA, covering every name in each vhost.
reissue_existing_certs() {
  local file domain
  local -a domains=()
  for file in /etc/apache2/sites-available/*-ssl.conf; do
    [[ -f "$file" ]] || continue
    domain="$(basename "$file" -ssl.conf)"
    [[ "$domain" == default || "$domain" == "$PANEL_DOMAIN" ]] && continue
    grep -qF "$CERTS_DIR/$domain/$domain.crt" "$file" && domains+=("$domain")
  done
  (( ${#domains[@]} > 0 )) || return 0

  dmp_step "Existing sites with certs in $CERTS_DIR: ${domains[*]}"
  confirm "Reissue their certs from the new CA? The old LocalhostCA stays trusted until you remove it." y || return 0
  local failed=()
  for domain in "${domains[@]}"; do
    if as_root "$DMP" cert-reissue-from-vhost "$domain"; then
      record dir "$CERTS_DIR/$domain" keep "certificate of $domain, reissued from the local CA"
    else
      failed+=("$domain")
    fi
  done
  (( ${#failed[@]} == 0 )) || dmp_warn "could not reissue: ${failed[*]} (they keep their old cert)"
}

setup_panel_site() {
  dmp_step "Setting up https://$PANEL_DOMAIN"
  as_root "$DMP" cert-issue "$PANEL_DOMAIN"
  as_root "$DMP" vhost-write-panel
  as_root "$DMP" hosts-add "$PANEL_DOMAIN"
  record dir "$CERTS_DIR/$PANEL_DOMAIN" remove "certificate of the panel's own site"
  record file "/etc/apache2/sites-available/$PANEL_DOMAIN-ssl.conf" remove "Apache vhost of the panel's own site"
  record link "/etc/apache2/sites-enabled/$PANEL_DOMAIN-ssl.conf" remove "turns that vhost on"
  record line /etc/hosts remove "$PANEL_DOMAIN in the devmagic-panel block"
}

# nginx next to Apache: set up when you asked for it, and its settings written
# again on every later run (or update) once it is. After the panel's own site,
# since an nginx older than 1.19.4 answers unknown names with its certificate.
setup_nginx() {
  if nginx_set_up; then
    dmp_step "Writing the panel's nginx settings again"
  elif (( WANT_NGINX )); then
    dmp_step "Setting nginx up on $NGINX_ADDRESS, next to Apache on $APACHE_ADDRESS"
  else
    return 0
  fi
  if ! as_root "$DMP" nginx-setup; then
    (( FROM_PANEL )) && fail "dmp-root nginx-setup failed"
    dmp_warn "nginx is not set up, see above; set it up later on the panel's Services page, nginx tab"
    return 0
  fi
  record setting "nginx:$NGINX_ADDRESS" remove "nginx next to Apache: Apache goes back on every address, Debian's default nginx site back on, and nginx stops; nginx stays installed"
}

# ── 6. secrets, service ──────────────────────────────────────

# The panel password and the MySQL admin account, asked by the panel's own
# CLI outside the log. Updates need no GitHub token: a token an older panel
# saved is deleted by setup, or by the panel when it starts.
setup_secrets() {
  dmp_step "Panel password and MySQL admin account"
  local cli="$RUN_DIR/server/dist/cli.js"
  if (( ASSUME_YES )) && [[ -f "$HOME/.config/devmagic-panel/secrets.json" ]]; then
    dmp_ok "secrets already set"
    return
  fi
  if (( ASSUME_YES )); then
    dmp_warn "run '$NODE_BIN $CURRENT_LINK/server/dist/cli.js setup' to set the panel password"
    return
  fi
  [[ -n "$INSTALL_LOG" ]] && printf '   (the questions and answers of this step are not logged)\n'
  outside_log as_user "$NODE_BIN" --disable-warning=ExperimentalWarning "$cli" setup
  record file "$HOME/.config/devmagic-panel/secrets.json" ask "panel password hash, MySQL admin account and the Anthropic key"
  record dir "$HOME/.config/devmagic-panel" ask "the panel's settings"
  record dir "$DATA_DIR" ask "run history, uploaded dumps, and Mailpit when installed from the panel"
}

install_service() {
  dmp_step "Installing the systemd user service, running $RELEASE_NAME"
  local unit_dir="$HOME/.config/systemd/user"
  switch_current
  (( FROM_PANEL )) && TXN_SWITCHED=1
  as_user mkdir -p "$unit_dir"
  local unit
  # It runs whatever current points at: an update from the panel only moves the link and restarts it.
  unit="$(cat <<EOF
[Unit]
Description=devmagic-panel
After=network.target

[Service]
WorkingDirectory=$CURRENT_LINK
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning $CURRENT_LINK/server/dist/index.js
Environment=NODE_ENV=production
Restart=on-failure

[Install]
WantedBy=default.target
EOF
)"
  if (( DRY_RUN )); then
    printf '   [dry-run] write %s/devmagic-panel.service:\n' "$unit_dir"
    printf '%s\n' "$unit" | sed 's/^/      | /'
  else
    printf '%s\n' "$unit" > "$unit_dir/devmagic-panel.service"
  fi
  as_user systemctl --user daemon-reload
  as_user systemctl --user enable --now devmagic-panel.service
  as_user systemctl --user restart devmagic-panel.service
  if (( FROM_PANEL && ! DRY_RUN )); then
    dmp_step "Checking the panel answers on 127.0.0.1:$PANEL_PORT with $RELEASE_NAME"
    health_check || fail "the panel did not answer with $RELEASE_NAME on 127.0.0.1:$PANEL_PORT within 60 seconds"
    dmp_ok "the panel runs $RELEASE_NAME"
  fi
  tidy_releases
  record file "$unit_dir/devmagic-panel.service" remove "the panel's systemd user service"
  record dir "$LOG_DIR" ask "install and update logs"

  # Without lingering, systemd stops your services, the panel and its running jobs included, when you log out.
  # On an encrypted home it cannot start them at boot either way.
  local at_boot=" (it then also starts at boot)"
  home_encrypted && at_boot=""
  if command -v loginctl >/dev/null && [[ "$(loginctl show-user "$PANEL_USER" -p Linger --value 2>/dev/null)" != yes ]]; then
    if confirm "Keep the panel and its jobs running after you log out$at_boot?" n; then
      as_root loginctl enable-linger "$PANEL_USER"
      record setting "linger:$PANEL_USER" ask "your user services keep running after you log out"
    fi
  fi
}

# An encrypted home folder (eCryptfs) unlocks at login, after systemd has
# looked for your user services, so the panel and Mailpit never start on their
# own. The desktop's autostart entry starts them once you log in.
home_encrypted() {
  awk -v home="$HOME" '$3 == "ecryptfs" { p = $2; gsub(/\\040/, " ", p); if (home == p || index(home, p "/") == 1) found = 1 } END { exit !found }' "$MOUNTS_FILE" 2>/dev/null
}

install_autostart() {
  home_encrypted || return 0
  dmp_step "Starting the panel after login (your home folder is encrypted, so systemd cannot start it at boot)"
  as_user "$NODE_BIN" --disable-warning=ExperimentalWarning "$RUN_DIR/server/dist/cli.js" write-autostart \
    || dmp_warn "the login entry was not written: add it from the panel's Environment page"
  record file "$AUTOSTART_FILE" remove "starts the panel and Mailpit after login, on an encrypted home folder"
}

# ── 7. after the service ─────────────────────────────────────

# How to sign in to the tools for installs from an organization; the panel
# never signs in for you.
org_sign_in_hints() {
  (( WANT_ORG )) || return 0
  printf '   To install sites from an organization, sign in once to each tool:\n'
  printf '     gh auth login       (an account that can read the organization)\n'
  printf '     glab auth login     (only for GitLab groups; add --hostname for your own GitLab)\n'
  printf '     rclone config       (a Google Drive remote, for dumps)\n'
  printf '     claude              (your claude.ai account, with Asana and Google connected)\n'
}

# ── 8. the list of installed files ───────────────────────────

# Writes what this run put on the machine to $STATE_DIR/installed-files,
# keeping entries of earlier runs (like packages installed then). Root-owned,
# readable by all: the Developer options show it, the uninstaller reads it.
write_manifest() {
  local file="$STATE_DIR/installed-files" line path
  local -A seen=()
  local -a lines=()
  record file "$file" remove "this list"
  for line in "${MANIFEST[@]}"; do
    path="$(cut -f2 <<< "$line")"
    [[ -n "${seen[$path]:-}" ]] && continue
    seen[$path]=1
    lines+=("$line")
  done
  if [[ -r "$file" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" || "$line" == \#* ]] && continue
      path="$(cut -f2 <<< "$line")"
      [[ -n "${seen[$path]:-}" || "$path" == "$LEGACY_APP_DIR" ]] && continue
      seen[$path]=1
      lines+=("$line")
    done < "$file"
  fi
  dmp_step "Writing the list of installed files to $file"
  as_root install -d -m 0755 -o root -g root "$STATE_DIR"
  {
    printf '# devmagic-panel: what install.sh put on this machine.\n'
    printf '# kind<TAB>path<TAB>on uninstall (remove, ask, keep)<TAB>what it is\n'
    printf '%s\n' "${lines[@]}"
  } | write_root_file "$file" 0644
}

# ── uninstall ────────────────────────────────────────────────

# Same lines as CRON_BEGIN and CRON_END in server/src/cron.ts.
CRON_BEGIN="# BEGIN devmagic-panel (managed by the panel, edit tasks there)"
CRON_END="# END devmagic-panel"

# How many tasks the panel's block in your crontab holds; nothing when there is no block.
crontab_block_tasks() {
  local text
  text="$(crontab -l 2>/dev/null)" || return 0
  grep -qxF "$CRON_BEGIN" <<< "$text" || return 0
  awk -v b="$CRON_BEGIN" -v e="$CRON_END" '$0 == b { inside = 1; next } $0 == e { inside = 0; next } inside && /cron-run --id=/ { n++ } END { print n + 0 }' <<< "$text"
}

# The crontab on stdin without the panel's block; your own lines stay as they are.
crontab_without_block() {
  awk -v b="$CRON_BEGIN" -v e="$CRON_END" '$0 == b { inside = 1; next } $0 == e { inside = 0; next } !inside'
}

# Takes the panel's block out of your crontab: its tasks call the panel's runner, gone after this.
remove_crontab_block() {
  if (( DRY_RUN )); then
    printf '   [dry-run] crontab - (your crontab without the devmagic-panel block)\n'
    return 0
  fi
  local text
  text="$(crontab -l 2>/dev/null)" || return 0
  crontab_without_block <<< "$text" | crontab - || dmp_warn "could not take the devmagic-panel block out of your crontab: run crontab -e and remove it"
}

# The installed-files list, or for an install older than the list, what
# every install puts on the machine.
uninstall_entries() {
  local file="$STATE_DIR/installed-files"
  if [[ -r "$file" ]]; then
    grep -v -e '^#' -e '^$' "$file" || true
    return
  fi
  MANIFEST=()
  record dir "$CONFIG_DIR" remove "settings folder"
  record file "$CONFIG_DIR/config.env" remove "settings read by dmp-root and the panel"
  record dir "$DMP_PREFIX" remove "root-owned scripts the sudoers rule allows"
  # Only a link to the bundled copy is the panel's; a wpcore of your own stays.
  if [[ "$(readlink /usr/local/bin/wpcore 2>/dev/null)" == "$DMP_PREFIX/bin/wpcore" ]]; then
    record link /usr/local/bin/wpcore remove "the wpcore command, linked to the bundled copy"
  fi
  record file "$SUDOERS_FILE" remove "lets you run dmp-root and wpcore without a password"
  record dir "$BACKUP_DIR" ask "backups of certs, vhosts and hosts, and database snapshots"
  record dir "$STATE_DIR" ask "the registry of panel-made sites and the deleted sites"
  record dir "$CA_DIR" ask "the local CA, its key and certificate; uninstall removes it when no site certificate is signed with it"
  record file "$SYSTEM_CA_FILE" ask "the local CA in the system trust store; goes with the CA"
  record store "$HOME/.pki/nssdb" ask "the local CA in this browser certificate store, as $NSS_NICKNAME; goes with the CA"
  record dir "$CERTS_DIR/$PANEL_DOMAIN" remove "certificate of the panel's own site"
  record file "/etc/apache2/sites-available/$PANEL_DOMAIN-ssl.conf" remove "Apache vhost of the panel's own site"
  record line /etc/hosts remove "$PANEL_DOMAIN in the devmagic-panel block"
  record dir "$RELEASES_DIR" remove "the installed releases of the panel: its code and dependencies"
  record link "$CURRENT_LINK" remove "points at the release the panel runs from"
  record file "$HOME/.config/systemd/user/devmagic-panel.service" remove "the panel's systemd user service"
  record file "$HOME/.config/devmagic-panel/secrets.json" ask "panel password hash, MySQL admin account and the Anthropic key"
  record dir "$HOME/.config/devmagic-panel" ask "the panel's settings"
  record dir "$DATA_DIR" ask "run history, uploaded dumps, and Mailpit when installed from the panel"
  record dir "$LOG_DIR" ask "install and update logs"
  printf '%s\n' "${MANIFEST[@]}"
}

# A path the uninstaller may delete: absolute, no "..", and never a folder
# that holds more than the panel's own files.
safe_path() {
  local path="${1%/}"
  [[ "$path" == /* && "$path" != *..* ]] || return 1
  case "$path" in
    / | /etc | /etc/ssl | /etc/apache2 | /usr | /usr/local | /usr/local/bin | /usr/local/lib | /var | /var/lib | /var/www | /home | "$HOME" | "$HOME/.config" | "$HOME/.local" | "$HOME/.local/share" | "$HOME/.local/state" | "$WEB_DIR" | "$CERTS_DIR" | "$REPO") return 1 ;;
  esac
  [[ "$path" == /*/* ]]
}

# The local CA, its copy in the system trust store, and its entry in a browser store.
is_ca_entry() {
  [[ "$1" == store || "$2" == "$CA_DIR" || "$2" == "$SYSTEM_CA_FILE" ]]
}

# Removes one path, as root unless it is yours: under your home or the panel's data folder.
remove_path() {
  local path="$1"
  safe_path "$path" || { dmp_warn "left $path alone: not a path the uninstaller removes"; return 0; }
  [[ -e "$path" || -L "$path" ]] || (( DRY_RUN )) || return 0
  if [[ "$path" == "$HOME"/* || "$path" == "$DATA_DIR" || "$path" == "$DATA_DIR"/* ]]; then
    as_user rm -rf -- "$path"
  else
    as_root rm -rf -- "$path"
  fi
}

# The panel's two files in a site: Local mode and the login helper.
site_panel_files() {
  local dir
  for dir in "$WEB_DIR"/*/wp-content/mu-plugins; do
    [[ -d "$dir" ]] || continue
    [[ -f "$dir/devmagic-panel-local.php" ]] && printf '%s\n' "$dir/devmagic-panel-local.php"
    [[ -f "$dir/devmagic-panel-login.php" ]] && printf '%s\n' "$dir/devmagic-panel-login.php"
  done
  return 0
}

# Sites whose certificate in CERTS_DIR is signed with the panel's CA, other
# than the panel's own: removing the CA would break https for them. Sites
# with certificates from another CA (like devmagic's LocalhostCA) are not.
ca_signed_sites() {
  local ca="$CA_DIR/ca.pem" dir name
  [[ -r "$ca" ]] || return 0
  for dir in "$CERTS_DIR"/*/; do
    dir="${dir%/}"
    name="$(basename "$dir")"
    [[ "$dir" == "$CA_DIR" || "$name" == "$PANEL_DOMAIN" ]] && continue
    [[ -r "$dir/$name.crt" ]] || continue
    if openssl verify -no-CApath -CAfile "$ca" -no_check_time "$dir/$name.crt" >/dev/null 2>&1; then
      printf '%s\n' "$name"
    fi
  done
  return 0
}

# Browser stores with the panel's CA: those install.sh listed, and any other
# Chrome or Firefox store that has it under the panel's nickname.
ca_browser_stores() {
  local db
  printf '%s\n' "$@"
  for db in "$HOME/.pki/nssdb" "$HOME"/.mozilla/firefox/*/ "$HOME"/snap/firefox/common/.mozilla/firefox/*/; do
    db="${db%/}"
    [[ -f "$db/cert9.db" ]] || continue
    if certutil -L -d "sql:$db" -n "$NSS_NICKNAME" >/dev/null 2>&1; then
      printf '%s\n' "$db"
    fi
  done
}

uninstall_main() {
  detect_settings
  (( DRY_RUN )) && dmp_warn "dry run: nothing will be changed"
  [[ -r "$STATE_DIR/installed-files" ]] || dmp_warn "no $STATE_DIR/installed-files (installed before v0.5.0): using the usual list"
  local -a entries=() site_files=() ca_sites=() listed_stores=() stores=()
  local entry kind path policy note extra listed
  mapfile -t entries < <(uninstall_entries)
  mapfile -t site_files < <(site_panel_files)

  # The releases and the v0.5 clone, when the list is older than them.
  for extra in "dir|$RELEASES_DIR|the installed releases of the panel" "link|$CURRENT_LINK|points at the release the panel runs from" "dir|$LEGACY_APP_DIR|the v0.5 copy of the panel"; do
    IFS='|' read -r kind path note <<< "$extra"
    [[ -e "$path" || -L "$path" ]] || continue
    listed=0
    for entry in "${entries[@]}"; do
      if [[ "$(cut -f2 <<< "$entry")" == "$path" ]]; then
        listed=1
      fi
    done
    (( listed )) || entries+=("$(printf '%s\t%s\tremove\t%s' "$kind" "$path" "$note")")
  done

  # The CA is one question of its own: removed by default when no site
  # certificate is signed with it, kept by default when one is.
  local has_ca=0
  if [[ -e "$CA_DIR" ]]; then
    has_ca=1
    mapfile -t ca_sites < <(ca_signed_sites)
  fi
  for entry in "${entries[@]}"; do
    IFS=$'\t' read -r kind path policy note <<< "$entry"
    [[ "$kind" == store ]] && listed_stores+=("$path")
  done
  mapfile -t stores < <(ca_browser_stores "${listed_stores[@]}" | awk 'NF && !seen[$0]++')

  local -a removed=() asked=() kept=()
  for entry in "${entries[@]}"; do
    IFS=$'\t' read -r kind path policy note <<< "$entry"
    if is_ca_entry "$kind" "$path"; then
      continue
    elif [[ "$policy" == remove ]]; then
      removed+=("$path  ($note)")
    elif [[ "$policy" == ask ]]; then
      asked+=("$path  ($note)")
    else
      kept+=("$path  ($note)")
    fi
  done
  if (( has_ca )); then
    if [[ ! -r "$CA_DIR/ca.pem" ]]; then
      asked+=("$CA_DIR and its trust in the system and ${#stores[@]} browser store(s)  (the local CA; its certificate could not be read to check which sites use it)")
    elif (( ${#ca_sites[@]} == 0 )); then
      asked+=("$CA_DIR and its trust in the system and ${#stores[@]} browser store(s)  (the local CA; no site certificate is signed with it)")
    else
      asked+=("$CA_DIR and its trust in the system and ${#stores[@]} browser store(s)  (the local CA; it signs the certificates of ${ca_sites[*]})")
    fi
  fi
  (( ${#site_files[@]} > 0 )) && asked+=("the panel's ${#site_files[@]} files in your sites (Local mode and the login helper)")
  # nginx next to Apache goes back as it was, listed or not (installs before the panel knew it).
  local nginx_on=0 nginx_sites
  if nginx_set_up; then
    nginx_on=1
    nginx_sites="$(nginx_panel_sites | wc -l)"
    (( nginx_sites == 0 )) || removed+=("$nginx_sites site(s) on nginx go back to Apache, with their names, folders, databases and certificates as they are")
    if ! printf '%s\n' "${entries[@]}" | grep -q $'^setting\tnginx:'; then
      removed+=("nginx:$NGINX_ADDRESS  (nginx next to Apache: Apache goes back on every address, Debian's default nginx site back on, and nginx stops; nginx stays installed)")
    fi
  fi
  local cron_tasks
  cron_tasks="$(crontab_block_tasks)"
  [[ -n "$cron_tasks" ]] && removed+=("the devmagic-panel block in your crontab  ($cron_tasks task(s) of the panel; your own lines stay)")

  dmp_step "Uninstalling devmagic-panel"
  printf '   Removed:\n'
  printf '     %s\n' "${removed[@]}"
  printf '   Asked about first:\n'
  printf '     %s\n' "${asked[@]}"
  if (( ${#kept[@]} > 0 )); then
    printf '   Kept:\n'
    printf '     %s\n' "${kept[@]}"
  fi
  printf '   Never touched: your sites, their databases and certificates, other CAs (like devmagic'\''s LocalhostCA), the wpcore cores and /etc/wpcore.conf, WP-CLI, Apache, PHP and MySQL.\n'
  printf '   Kept, as sites run on them: the PHP-FPM pools of sites with a PHP of their own and Apache'\''s devmagic-panel-php.conf, which sends PHP to them (and to every site once mod_php is off).\n'
  printf '   The panel stops first: a running install or import is cut off.\n'

  if (( ! DRY_RUN && ! ASSUME_YES )); then
    confirm "Uninstall devmagic-panel now?" n || { dmp_ok "nothing changed"; return 0; }
  fi

  # Every question first, so nothing is half removed while you answer.
  local remove_backups=0 remove_state=0 remove_data=0 remove_logs=0 remove_linger=0 remove_site_files=0 remove_ca=0
  confirm "Remove the backups in $BACKUP_DIR (certs, vhosts, hosts and database snapshots)?" n && remove_backups=1
  confirm "Remove $STATE_DIR (deleted sites you can still restore, and the registry of panel-made sites)?" n && remove_state=1
  confirm "Remove the panel's data: settings, saved password, MySQL account, run history, uploads and Mailpit?" y && remove_data=1
  confirm "Remove the install logs in $LOG_DIR?" y && remove_logs=1
  for entry in "${entries[@]}"; do
    [[ "$entry" == setting$'\t'linger:* ]] || continue
    confirm "Turn lingering off for $PANEL_USER (your user services stop at logout again)?" n && remove_linger=1
  done
  if (( ${#site_files[@]} > 0 )); then
    confirm "Remove the panel's files from your sites? Without Local mode a site can email real people again." n && remove_site_files=1
  fi
  if (( has_ca )); then
    if [[ ! -r "$CA_DIR/ca.pem" ]]; then
      confirm "Remove the panel's local CA and its trust? Its certificate could not be read, so sites signed with it are not known." n && remove_ca=1
    elif (( ${#ca_sites[@]} == 0 )); then
      confirm "Remove the panel's local CA and its trust in the system and your browsers? No site certificate is signed with it." y && remove_ca=1
    else
      confirm "Remove the panel's local CA anyway? ${ca_sites[*]} would stop working over https until their certificates are reissued." n && remove_ca=1
    fi
  fi

  dmp_step "Stopping the panel and Mailpit"
  as_user systemctl --user disable --now devmagic-panel.service devmagic-panel-mailpit.service || true

  if [[ -n "$cron_tasks" ]]; then
    dmp_step "Taking the panel's tasks out of your crontab"
    remove_crontab_block
  fi

  # nginx and the panel's own site go while dmp-root is still there.
  if (( nginx_on )); then
    nginx_sites_back_to_apache
    dmp_step "Turning nginx off; Apache answers on every address again"
    as_root "$DMP" nginx-teardown || dmp_warn "could not turn nginx off: put /etc/apache2/ports.conf back from $STATE_DIR/nginx/ports.conf by hand"
  fi
  dmp_step "Removing https://$PANEL_DOMAIN"
  as_root "$DMP" vhost-remove "$PANEL_DOMAIN" || dmp_warn "could not remove the vhost of $PANEL_DOMAIN"
  as_root "$DMP" hosts-remove "$PANEL_DOMAIN" || dmp_warn "could not remove $PANEL_DOMAIN from /etc/hosts"
  as_root "$DMP" cert-remove "$PANEL_DOMAIN" || dmp_warn "could not remove the certificate of $PANEL_DOMAIN"

  dmp_step "Removing the panel's files"
  for entry in "${entries[@]}"; do
    IFS=$'\t' read -r kind path policy note <<< "$entry"
    [[ "$policy" == keep ]] && continue
    is_ca_entry "$kind" "$path" && continue
    case "$kind:$path" in
      line:* | modules:* | packages:*) continue ;;
      # The folders dmp-root, sudo and config.env live in go last.
      *:"$DMP_PREFIX" | *:"$DMP_PREFIX"/* | *:"$SUDOERS_FILE" | *:"$CONFIG_DIR" | *:"$CONFIG_DIR"/*) continue ;;
      # Turned off above, with nginx-teardown.
      setting:nginx:*) continue ;;
      setting:linger:*)
        (( remove_linger )) && as_root loginctl disable-linger "${path#linger:}"
        continue
        ;;
      link:/usr/local/bin/wpcore)
        # Only the link install.sh made; a wpcore of your own stays.
        if [[ "$(readlink /usr/local/bin/wpcore 2>/dev/null)" == "$DMP_PREFIX/bin/wpcore" ]]; then
          as_root rm -f /usr/local/bin/wpcore
        fi
        continue
        ;;
    esac
    case "$path" in
      "$BACKUP_DIR") (( remove_backups )) || continue ;;
      "$STATE_DIR/installed-files") ;;
      "$STATE_DIR") (( remove_state )) || continue ;;
      "$HOME/.config/devmagic-panel" | "$HOME/.config/devmagic-panel/"* | "$DATA_DIR") (( remove_data )) || continue ;;
      "$LOG_DIR") (( remove_logs )) || continue ;;
      *) [[ "$policy" == remove ]] || continue ;;
    esac
    remove_path "$path"
  done
  remove_path "$HOME/.config/systemd/user/devmagic-panel-mailpit.service"
  remove_path "$AUTOSTART_FILE"
  as_user systemctl --user daemon-reload || true

  if (( remove_site_files )); then
    local site_file
    for site_file in "${site_files[@]}"; do
      as_user rm -f -- "$site_file" || dmp_warn "could not remove $site_file"
    done
  fi

  if (( remove_ca )); then
    dmp_step "Removing the panel's local CA and its trust"
    local db
    for db in "${stores[@]}"; do
      as_user certutil -D -d "sql:$db" -n "$NSS_NICKNAME" || dmp_warn "could not remove the CA from $db"
    done
    as_root rm -f -- "$SYSTEM_CA_FILE"
    as_root update-ca-certificates --fresh || dmp_warn "update-ca-certificates failed: run it again with sudo"
    remove_path "$CA_DIR"
  fi

  # Last: the root scripts, the sudoers rule that allows them, and config.env.
  as_root rm -f -- "$SUDOERS_FILE"
  as_root rm -rf -- "$DMP_PREFIX"
  as_root rm -rf -- "$CONFIG_DIR"

  if (( DRY_RUN )); then
    dmp_ok "dry run done: nothing was changed"
  else
    dmp_ok "devmagic-panel is uninstalled"
  fi
  if [[ "$REPO" != "$RELEASES_DIR"/* ]]; then
    printf '   This folder (%s) stays: delete it when you no longer need it.\n' "$REPO"
  fi
  if (( has_ca && ! remove_ca )); then
    printf '   The local CA stays trusted, so sites with its certificates keep working over https. To remove it by hand later:\n'
    printf '     sudo rm -rf %s %s && sudo update-ca-certificates --fresh\n' "$CA_DIR" "$SYSTEM_CA_FILE"
    printf '     certutil -D -d sql:%s -n "%s"   (and the same for each Firefox profile)\n' "$HOME/.pki/nssdb" "$NSS_NICKNAME"
  fi
  if (( remove_data )); then
    printf '   Panels before v0.7.0 used a GitHub token for updates: if you made one, delete it at https://github.com/settings/personal-access-tokens\n'
  fi
  return 0
}

# ── main ─────────────────────────────────────────────────────

main() {
  start_log
  (( DRY_RUN )) && dmp_warn "dry run: nothing will be changed"
  step_at checks
  preflight
  from_panel_begin
  detect_settings
  step_at packages
  check_dependencies
  install_dependencies
  # Its npm builds a checkout, and the panel's CLI runs on it.
  PATH="$(dirname "$NODE_BIN"):$PATH"
  txn_begin
  step_at config
  write_config
  step_at release
  prepare_release
  step_at scripts
  install_scripts
  install_sudoers
  step_at backup
  backup
  step_at system
  as_root "$DMP" site-marker-migrate
  enable_apache_modules
  setup_php_fpm
  setup_ca
  trust_ca_in_browsers
  reissue_existing_certs
  setup_panel_site
  as_root "$DMP" apache-reload
  setup_nginx
  setup_secrets
  step_at restart
  install_service
  step_at finish
  install_mailpit
  install_autostart
  write_manifest
  txn_commit
  dmp_ok "devmagic-panel is installed: https://$PANEL_DOMAIN, running $RELEASE_NAME"
  printf '   Restart your browsers so they pick up the new CA.\n'
  printf '   Later releases install from the panel'\''s Updates page; this installer stays at %s/install.sh.\n' "$CURRENT_LINK"
  printf '   To undo the changes to certs, vhosts and hosts (asks for your password):\n'
  printf '     sudo %s/bin/dmp-restore --list\n' "$DMP_PREFIX"
  printf '     sudo %s/bin/dmp-restore            (restores the newest backup)\n' "$DMP_PREFIX"
  org_sign_in_hints
}

# Sourced (by the tests), it only defines its functions.
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

if (( UNINSTALL )); then
  uninstall_main
else
  main
fi
