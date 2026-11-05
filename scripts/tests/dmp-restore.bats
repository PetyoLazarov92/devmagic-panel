#!/usr/bin/env bats

load helpers

DMP_RESTORE_BIN="$BATS_TEST_DIRNAME/../bin/dmp-restore"
restore() { "$DMP_RESTORE_BIN" "$@"; }

setup() {
  setup_tree
  dmp ca-create
  dmp cert-issue local.site.com
  dmp vhost-write local.site.com
  dmp hosts-add local.site.com
  dmp backup
  ARCHIVE="$(ls "$T"/backups/devmagic-panel-backup-*.tar.gz)"
  # Archive names carry seconds; make sure later backups get a new name.
  sleep 1
}

# A tar holding the given paths (relative to /), named like a backup.
craft() {
  local name="$T/backups/devmagic-panel-backup-20990101-000000.tar.gz"
  tar -czf "$name" -C / "$@"
  printf '%s' "$name"
}

@test "restores hosts, vhosts and certs and keeps a backup of the state before" {
  original_hosts="$(cat "$T/hosts")"
  original_crt="$(sha256sum < "$T/certs/local.site.com/local.site.com.crt")"
  dmp hosts-add local.other.com
  dmp cert-issue local.site.com local.site.de
  dmp cert-issue local.other.com
  dmp vhost-write local.other.com

  run restore --yes "$ARCHIVE"
  [ "$status" -eq 0 ]
  [ "$(cat "$T/hosts")" = "$original_hosts" ]
  [ "$(sha256sum < "$T/certs/local.site.com/local.site.com.crt")" = "$original_crt" ]
  [ ! -e "$T/sites-available/local.other.com-ssl.conf" ]
  [ ! -e "$T/sites-enabled/local.other.com-ssl.conf" ]
  [ -L "$T/sites-enabled/local.site.com-ssl.conf" ]
  [ "$(ls "$T"/backups/devmagic-panel-backup-*.tar.gz | wc -l)" -eq 2 ]
}

@test "without an archive it restores the newest backup" {
  dmp hosts-add local.other.com
  dmp backup
  dmp hosts-remove local.other.com
  run restore --yes
  [ "$status" -eq 0 ]
  grep -q '^127.0.0.1 local.other.com$' "$T/hosts"
}

@test "--list shows backups newest first" {
  dmp backup
  run restore --list
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 2 ]
  [[ "${lines[0]}" > "${lines[1]}" ]]
}

@test "asks before restoring and does nothing on no" {
  dmp hosts-add local.other.com
  before="$(cat "$T/hosts")"
  run bash -c "echo n | '$DMP_RESTORE_BIN' '$ARCHIVE'"
  [ "$status" -eq 1 ]
  [ "$(cat "$T/hosts")" = "$before" ]
}

@test "refuses archives outside the backup folder" {
  cp "$ARCHIVE" "$T/devmagic-panel-backup-20990101-000000.tar.gz"
  run restore --yes "$T/devmagic-panel-backup-20990101-000000.tar.gz"
  [ "$status" -eq 2 ]
}

@test "refuses files that are not named like a backup" {
  cp "$ARCHIVE" "$T/backups/evil.tar.gz"
  run restore --yes "$T/backups/evil.tar.gz"
  [ "$status" -eq 2 ]
}

@test "refuses an archive with paths a backup never holds" {
  mkdir -p "$T/elsewhere"
  echo 'evil' > "$T/elsewhere/sudoers"
  archive="$(craft "${T#/}/hosts" "${T#/}/elsewhere/sudoers")"
  before="$(cat "$T/hosts")"
  run restore --yes "$archive"
  [ "$status" -eq 1 ]
  [[ "$output" == *"which a backup never contains"* ]]
  [ "$(cat "$T/hosts")" = "$before" ]
}

@test "refuses links outside sites-enabled" {
  ln -s /etc/passwd "$T/certs/local.site.com/evil"
  archive="$(craft "${T#/}/certs")"
  run restore --yes "$archive"
  [ "$status" -eq 1 ]
  [[ "$output" == *"link outside sites-enabled"* ]]
}

@test "refuses sites-enabled links that leave sites-available" {
  ln -s /etc/shadow "$T/sites-enabled/evil.conf"
  archive="$(craft "${T#/}/sites-enabled")"
  run restore --yes "$archive"
  [ "$status" -eq 1 ]
  [[ "$output" == *"points to /etc/shadow"* ]]
}
