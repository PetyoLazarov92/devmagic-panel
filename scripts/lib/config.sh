# shellcheck shell=bash
# Reads /etc/devmagic-panel/config.env without sourcing it.
#
# Only known keys are accepted and every value must be a plain token or an
# absolute path, so a broken or hostile file cannot run code. When running as
# root the location is fixed; DMP_CONFIG is honoured only for non-root runs,
# which is how the bats tests point the scripts at a temporary tree.

DMP_DEFAULT_CONFIG="/etc/devmagic-panel/config.env"

DMP_CONFIG_KEYS=(
  PANEL_USER PANEL_GROUP PANEL_PORT PANEL_DOMAIN
  WEB_DIR WEB_GROUP
  CERTS_DIR CA_DIR
  APACHE_SITES_AVAILABLE APACHE_SITES_ENABLED APACHE_LOG_DIR
  HOSTS_FILE SYSTEM_CA_DIR BACKUP_DIR
)

# Keys added after the first release; older config files leave them out and get these defaults.
# UPDATE_REPO and UPDATE_GIT_URL are the panel's (where it updates from); dmp-root only accepts them.
DMP_CONFIG_OPTIONAL_KEYS=(PHP_CONF_DIR PHP_LIB_DIR STATE_DIR UPDATE_REPO UPDATE_GIT_URL)
DMP_DEFAULT_PHP_CONF_DIR="/etc/php"
# Where Debian keeps each version's packaged php.ini (php.ini-production), to compare and restore.
DMP_DEFAULT_PHP_LIB_DIR="/usr/lib/php"
DMP_DEFAULT_STATE_DIR="/var/lib/devmagic-panel"

dmp_config_file() {
  if [[ $EUID -eq 0 ]]; then
    printf '%s' "$DMP_DEFAULT_CONFIG"
  else
    printf '%s' "${DMP_CONFIG:-$DMP_DEFAULT_CONFIG}"
  fi
}

dmp_is_config_key() {
  local key="$1" k
  for k in "${DMP_CONFIG_KEYS[@]}" "${DMP_CONFIG_OPTIONAL_KEYS[@]}"; do
    [[ "$k" == "$key" ]] && return 0
  done
  return 1
}

dmp_load_config() {
  local file key value line
  file="$(dmp_config_file)"
  [[ -f "$file" ]] || dmp_die "config not found: $file (run install.sh first)"

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^([A-Z_]+)=([A-Za-z0-9._/@:-]*)$ ]] || dmp_die "invalid line in $file: $line"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    dmp_is_config_key "$key" || dmp_die "unknown key in $file: $key"
    printf -v "$key" '%s' "$value"
  done < "$file"

  for key in "${DMP_CONFIG_KEYS[@]}"; do
    [[ -n "${!key:-}" ]] || dmp_die "missing key in $file: $key"
  done
  PHP_CONF_DIR="${PHP_CONF_DIR:-$DMP_DEFAULT_PHP_CONF_DIR}"
  PHP_LIB_DIR="${PHP_LIB_DIR:-$DMP_DEFAULT_PHP_LIB_DIR}"
  STATE_DIR="${STATE_DIR:-$DMP_DEFAULT_STATE_DIR}"
  for key in WEB_DIR CERTS_DIR CA_DIR APACHE_SITES_AVAILABLE APACHE_SITES_ENABLED \
    APACHE_LOG_DIR HOSTS_FILE SYSTEM_CA_DIR BACKUP_DIR PHP_CONF_DIR PHP_LIB_DIR STATE_DIR; do
    [[ "${!key}" == /* && "${!key}" != *..* ]] || dmp_die "$key must be an absolute path: ${!key}"
  done
  [[ "$PANEL_PORT" =~ ^[0-9]{2,5}$ ]] || dmp_die "PANEL_PORT must be a number: $PANEL_PORT"
}
