#!/usr/bin/env bats

# install.sh --from-panel, run for real against stubs: sudo records what it
# would run as root (and fails on request), systemctl and apt-get record,
# curl answers /healthz with a chosen version. Nothing touches the system.

PASSWORD='s3cret pass'

setup() {
  STUBS="$BATS_TEST_TMPDIR/stubs"
  mkdir -p "$STUBS"
  export SUDO_LOG="$BATS_TEST_TMPDIR/sudo.log" AUTH="$BATS_TEST_TMPDIR/sudo-auth" SUDO_PASSWORD="$PASSWORD"
  : > "$SUDO_LOG"
  # sudo: -S -v checks the password from stdin, -n runs only with the
  # credential (and fails for commands matching the pattern SUDO_FAIL; `test`
  # says no for paths matching SUDO_MISSING), -K drops it. Every path is
  # answered here, never read from this machine. SUDO_LAPSE_EVERY drops it every n commands, as a
  # credential kept per calling process would.
  cat > "$STUBS/sudo" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -K) rm -f "$AUTH"; echo "SUDO -K" >> "$SUDO_LOG"; exit 0 ;;
  -S) IFS= read -r pw || pw=""
      if [[ "$pw" == "$SUDO_PASSWORD" ]]; then touch "$AUTH"; echo "SUDO validated" >> "$SUDO_LOG"; exit 0; fi
      exit 1 ;;
  -n) shift
      [[ -f "$AUTH" ]] || exit 1
      [[ "$*" == true ]] && exit 0
      echo "SUDO $*" >> "$SUDO_LOG"
      if [[ -n "${SUDO_LAPSE_EVERY:-}" ]] && (( $(grep -c '^SUDO [^-v]' "$SUDO_LOG") % SUDO_LAPSE_EVERY == 0 )); then rm -f "$AUTH"; fi
      if [[ -n "${SUDO_FAIL:-}" ]] && grep -qE -- "$SUDO_FAIL" <<< "$*"; then echo "failed on purpose: $*" >&2; exit 1; fi
      if [[ "$1" == test && -n "${SUDO_MISSING:-}" ]] && grep -qE -- "$SUDO_MISSING" <<< "$*"; then exit 1; fi
      [[ "$*" == *"dmp-root backup" ]] && echo "ok: backup written: $BACKUP_ARCHIVE"
      exit 0 ;;
  *) echo "SUDO WITHOUT -n: $*" >> "$SUDO_LOG"; exit 99 ;;
esac
EOF
  printf '#!/bin/sh\necho "systemctl $*" >> "%s"\n' "$BATS_TEST_TMPDIR/systemctl.log" > "$STUBS/systemctl"
  # shellcheck disable=SC2016 # the stub expands these when it runs
  printf '#!/bin/sh\ncase "$*" in *"/healthz"*) printf "{\\"status\\":\\"ok\\",\\"version\\":\\"%%s\\"}" "${HEALTH_VERSION:-9.9.9}" ;; *) exit 22 ;; esac\n' > "$STUBS/curl"
  printf '#!/bin/sh\necho "apt-get $*" >> "%s"\n' "$BATS_TEST_TMPDIR/apt.log" > "$STUBS/apt-get"
  printf '#!/bin/sh\necho "install ok installed"\n' > "$STUBS/dpkg-query"
  printf '#!/bin/sh\necho no\n' > "$STUBS/loginctl"
  for cmd in certutil sleep wp; do printf '#!/bin/sh\nexit 0\n' > "$STUBS/$cmd"; done
  chmod +x "$STUBS"/*
  export PATH="$STUBS:$PATH"

  export HOME="$BATS_TEST_TMPDIR/home" XDG_STATE_HOME="$BATS_TEST_TMPDIR/xdg"
  mkdir -p "$HOME/.config/devmagic-panel"
  printf '{}\n' > "$HOME/.config/devmagic-panel/secrets.json"
  export DMP_INSTALL_CONFIG_DIR="$BATS_TEST_TMPDIR/etc" DMP_INSTALL_DATA_DIR="$BATS_TEST_TMPDIR/data" DMP_INSTALL_STATE_DIR="$BATS_TEST_TMPDIR/state"
  export DMP_INSTALL_OS_RELEASE="$BATS_TEST_TMPDIR/os-release" DMP_INSTALL_MOUNTS="$BATS_TEST_TMPDIR/mounts"
  printf 'ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04 LTS"\n' > "$DMP_INSTALL_OS_RELEASE"
  printf '/dev/sda1 / ext4 rw 0 0\n' > "$DMP_INSTALL_MOUNTS"
  BACKUPS="$BATS_TEST_TMPDIR/backups"
  export BACKUP_ARCHIVE="$BACKUPS/devmagic-panel-backup-20261031-120000.tar.gz"
  mkdir -p "$DMP_INSTALL_CONFIG_DIR" "$BACKUPS" "$BATS_TEST_TMPDIR/www" "$BATS_TEST_TMPDIR/certs"
  printf 'PANEL_DOMAIN=local.devmagic\nWEB_DIR=%s\nCERTS_DIR=%s\nBACKUP_DIR=%s\nSTATE_DIR=%s\n' "$BATS_TEST_TMPDIR/www" "$BATS_TEST_TMPDIR/certs" "$BACKUPS" "$DMP_INSTALL_STATE_DIR" > "$DMP_INSTALL_CONFIG_DIR/config.env"

  DATA="$DMP_INSTALL_DATA_DIR"
  release "$DATA/releases/v9.9.8" v9.9.8
  release "$DATA/releases/v9.9.9" v9.9.9
  ln -s releases/v9.9.8 "$DATA/current"
  # The panel's own Node, which the installer prefers; it only has to pass the version check.
  mkdir -p "$DATA/node/current/bin"
  printf '#!/bin/sh\nexit 0\n' > "$DATA/node/current/bin/node"
  chmod +x "$DATA/node/current/bin/node"
  INSTALL="$DATA/releases/v9.9.9/install.sh"
  STATUS="$DATA/update-status.json"
}

# A release as the panel downloads it: install.sh, the root scripts and release.json.
release() {
  local dir="$1" name="$2"
  mkdir -p "$dir/scripts"
  cp "$BATS_TEST_DIRNAME/../../install.sh" "$dir/install.sh"
  cp -R "$BATS_TEST_DIRNAME/../bin" "$BATS_TEST_DIRNAME/../lib" "$BATS_TEST_DIRNAME/../php" "$dir/scripts/"
  printf '{\n  "name": "%s",\n  "version": "%s",\n  "commit": "abc"\n}\n' "$name" "${name#v}" > "$dir/release.json"
}

update() { run bash -c "printf '%s\n' \"\$1\" | \"$INSTALL\" --from-panel" _ "${1-$PASSWORD}"; }

# A field of the status file: a string without its quotes, or true/false.
field() { sed -n -E "s/^  \"$1\": (\"(.*)\"|([a-z]+)),?$/\2\3/p" "$STATUS"; }

# Fails the test when the command succeeds (a bare ! does not fail a bats test).
refute() {
  if "$@"; then
    echo "expected this to fail: $*" >&2
    return 1
  fi
}

# The line numbers of the first sudo command matching each pattern, in order.
order() { local p; for p in "$@"; do grep -n -F -- "$p" "$SUDO_LOG" | head -1 | cut -d: -f1; done; }

@test "with the password on stdin it updates in one go: root scripts staged and swapped whole, switched, checked, credential dropped" {
  update
  [ "$status" -eq 0 ]
  [ "$(field state)" = "done" ]
  [ "$(field release)" = v9.9.9 ]
  [ "$(field previous)" = v9.9.8 ]
  [ "$(field rolledBack)" = false ]
  [ "$(readlink "$DATA/current")" = releases/v9.9.9 ]
  refute grep -q 'WITHOUT -n' "$SUDO_LOG"
  # Kept first, staged, then swapped in two renames; what was kept goes at the end.
  read -r -a lines <<< "$(order 'cp -a -- /usr/local/lib/devmagic-panel /usr/local/lib/devmagic-panel.update/prev' \
    'cp -a -- /usr/local/lib/devmagic-panel /usr/local/lib/devmagic-panel.update/new' \
    'mv -T -- /usr/local/lib/devmagic-panel /usr/local/lib/devmagic-panel.update/old' \
    'mv -T -- /usr/local/lib/devmagic-panel.update/new /usr/local/lib/devmagic-panel' \
    'dmp-root backup' 'dmp-root apache-reload' | tr '\n' ' ')"
  [ "${#lines[@]}" -eq 6 ]
  for i in 1 2 3 4 5; do [ "${lines[$((i - 1))]}" -lt "${lines[$i]}" ]; done
  committed="$(grep -n -x 'SUDO rm -rf -- /usr/local/lib/devmagic-panel.update' "$SUDO_LOG" | tail -n 1 | cut -d: -f1)"
  [ "$committed" -gt "${lines[5]}" ]
  grep -q 'install -m 0755 -o root -g root .*/dmp-root .* /usr/local/lib/devmagic-panel.update/new/bin/' "$SUDO_LOG"
  grep -q 'systemctl --user restart devmagic-panel.service' "$BATS_TEST_TMPDIR/systemctl.log"
  [ "$(tail -n 1 "$SUDO_LOG")" = "SUDO -K" ]
}

@test "the password is never in the output, the log, the status file or a command line" {
  update
  [ "$status" -eq 0 ]
  [[ "$output" != *"$PASSWORD"* ]]
  refute grep -rqF "$PASSWORD" "$XDG_STATE_HOME" "$STATUS" "$SUDO_LOG"
}

@test "a wrong password stops before anything changes" {
  update 'wrong'
  [ "$status" -eq 1 ]
  [[ "$output" == *"sudo did not accept the password: nothing was changed"* ]]
  [ "$(field state)" = failed ]
  [ "$(field step)" = password ]
  [ "$(field rolledBack)" = false ]
  refute grep -q '^SUDO [^-]' "$SUDO_LOG"
  [ "$(readlink "$DATA/current")" = releases/v9.9.8 ]
  [ ! -e "$BATS_TEST_TMPDIR/apt.log" ]
}

@test "sudo's credential lapsing is renewed from the password, never by asking" {
  export SUDO_LAPSE_EVERY=4
  update
  [ "$status" -eq 0 ]
  [ "$(grep -c '^SUDO validated' "$SUDO_LOG")" -gt 2 ]
  refute grep -q 'WITHOUT -n' "$SUDO_LOG"
}

@test "a failing system step puts back the root scripts, config.env, sudoers and the backup; current never moved" {
  export SUDO_FAIL='dmp-root apache-reload'
  update
  [ "$status" -ne 0 ]
  [ "$(field state)" = failed ]
  [ "$(field step)" = system ]
  [ "$(field rolledBack)" = true ]
  [ "$(readlink "$DATA/current")" = releases/v9.9.8 ]
  read -r -a lines <<< "$(order 'dmp-root apache-reload' \
    'mv -T -- /usr/local/lib/devmagic-panel /usr/local/lib/devmagic-panel.update/failed' \
    'mv -T -- /usr/local/lib/devmagic-panel.update/prev /usr/local/lib/devmagic-panel' \
    "install -m 0644 -o root -g root /usr/local/lib/devmagic-panel.update/config.env $DMP_INSTALL_CONFIG_DIR/config.env" \
    "dmp-restore --yes $BACKUP_ARCHIVE" | tr '\n' ' ')"
  [ "${#lines[@]}" -eq 5 ]
  for i in 1 2 3 4; do [ "${lines[$((i - 1))]}" -lt "${lines[$i]}" ]; done
  # The panel was never restarted: it still runs the release before.
  [ ! -e "$BATS_TEST_TMPDIR/systemctl.log" ] || ! grep -q restart "$BATS_TEST_TMPDIR/systemctl.log"
  [ "$(tail -n 1 "$SUDO_LOG")" = "SUDO -K" ]
}

@test "a failure between the two renames, with the root scripts' folder gone, puts the kept one back" {
  export SUDO_FAIL='mv -T -- /usr/local/lib/devmagic-panel.update/new /usr/local/lib/devmagic-panel'
  export SUDO_MISSING='test -d /usr/local/lib/devmagic-panel$'
  update
  [ "$status" -ne 0 ]
  [ "$(field step)" = scripts ]
  [ "$(field rolledBack)" = true ]
  refute grep -q 'mv -T -- /usr/local/lib/devmagic-panel /usr/local/lib/devmagic-panel.update/failed' "$SUDO_LOG"
  grep -q 'mv -T -- /usr/local/lib/devmagic-panel.update/prev /usr/local/lib/devmagic-panel' "$SUDO_LOG"
}

@test "a new panel that does not answer with its version is switched back and restarted on the release before" {
  export HEALTH_VERSION=9.9.8
  update
  [ "$status" -ne 0 ]
  [ "$(field step)" = restart ]
  [ "$(field rolledBack)" = true ]
  [[ "$(field message)" == *"did not answer with v9.9.9"* ]]
  [ "$(readlink "$DATA/current")" = releases/v9.9.8 ]
  [ "$(grep -c 'restart devmagic-panel.service' "$BATS_TEST_TMPDIR/systemctl.log")" -eq 2 ]
  grep -qF "dmp-restore --yes $BACKUP_ARCHIVE" "$SUDO_LOG"
}

@test "a failure before the root scripts change has nothing to put back but config.env" {
  export SUDO_FAIL='install -d -m 0755 -o root -g root /usr/local/lib/devmagic-panel.update/new/bin'
  update
  [ "$status" -ne 0 ]
  [ "$(field step)" = scripts ]
  [ "$(field rolledBack)" = true ]
  refute grep -q 'mv -T -- /usr/local/lib/devmagic-panel.update/prev' "$SUDO_LOG"
  refute grep -q 'dmp-restore' "$SUDO_LOG"
}

@test "a rollback that cannot put everything back says so and names the release to reinstall" {
  export SUDO_FAIL='dmp-root apache-reload|dmp-restore --yes'
  update
  [ "$status" -ne 0 ]
  [ "$(field rolledBack)" = false ]
  [[ "$(field message)" == *"run v9.9.8's install.sh in a terminal"* ]]
}

@test "it refuses a first install, a checkout, and a password typed on a terminal" {
  rm "$DMP_INSTALL_CONFIG_DIR/config.env"
  update
  [ "$status" -eq 1 ]
  [[ "$output" == *"run ./install.sh in a terminal for the first install"* ]]
  refute grep -q '^SUDO [^-]' "$SUDO_LOG"
  run bash -c "printf 'x\n' | '$BATS_TEST_DIRNAME/../../install.sh' --from-panel"
  [ "$status" -eq 1 ]
  [[ "$output" == *"runs from a release, not a checkout"* ]]
}
