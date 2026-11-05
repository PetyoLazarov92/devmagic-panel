# shellcheck shell=bash
# Archives everything the panel may change: certs and CA keys, Apache vhosts,
# the hosts file and the system CA folder. The archive holds private keys,
# so it is readable only by the panel user.

dmp_backup() {
  local stamp archive
  local -a paths=()
  stamp="$(date +%Y%m%d-%H%M%S)"
  archive="$BACKUP_DIR/devmagic-panel-backup-$stamp.tar.gz"

  local p
  for p in "$CERTS_DIR" "$APACHE_SITES_AVAILABLE" "$APACHE_SITES_ENABLED" "$HOSTS_FILE" "$SYSTEM_CA_DIR"; do
    [[ -e "$p" ]] && paths+=("${p#/}")
  done
  (( ${#paths[@]} > 0 )) || dmp_die "nothing to back up"

  dmp_step "Backing up ${#paths[@]} locations to $archive"
  install -d -m 0700 -o "$PANEL_USER" -g "$PANEL_GROUP" "$BACKUP_DIR"
  (umask 077 && tar -czf "$archive" -C / "${paths[@]}") || dmp_die "backup failed"
  chown "$PANEL_USER:$PANEL_GROUP" "$archive"
  chmod 0600 "$archive"
  dmp_ok "backup written: $archive"
}
