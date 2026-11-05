#!/usr/bin/env bats

# get.sh against stub curl, gh and git that serve a fake release from a temp
# folder: nothing goes to GitHub, and the release's install.sh only records
# how it ran. Each stub works only when its *_OK variable is set.

setup() {
  FIX="$BATS_TEST_TMPDIR/fixtures"
  export INSTALL_LOG="$BATS_TEST_TMPDIR/install.log"
  export STUB_LOG="$BATS_TEST_TMPDIR/stubs.log"
  mkdir -p "$FIX/devmagic-panel-v1.2.3"
  cat > "$FIX/devmagic-panel-v1.2.3/install.sh" <<'EOF'
#!/usr/bin/env bash
{
  echo "ARGS $*"
  echo "FROM $(basename "$(dirname "$(readlink -f "$0")")")"
} >> "$INSTALL_LOG"
EOF
  chmod +x "$FIX/devmagic-panel-v1.2.3/install.sh"
  printf '{\n  "name": "v1.2.3"\n}\n' > "$FIX/devmagic-panel-v1.2.3/release.json"
  tar -czf "$FIX/devmagic-panel-v1.2.3.tar.gz" -C "$FIX" devmagic-panel-v1.2.3
  (cd "$FIX" && sha256sum devmagic-panel-v1.2.3.tar.gz > devmagic-panel-v1.2.3.tar.gz.sha256)
  dl="https://github.com/PetyoLazarov92/devmagic-panel/releases/download/v1.2.3"
  printf '{"tag_name": "v1.2.3", "assets": [{"name": "devmagic-panel-v1.2.3.tar.gz", "browser_download_url": "%s/devmagic-panel-v1.2.3.tar.gz"}, {"name": "devmagic-panel-v1.2.3.tar.gz.sha256", "browser_download_url": "%s/devmagic-panel-v1.2.3.tar.gz.sha256"}]}\n' "$dl" "$dl" > "$FIX/release.json"

  STUBS="$BATS_TEST_TMPDIR/stubs"
  mkdir -p "$STUBS"
  # curl: the public API and download addresses.
  cat > "$STUBS/curl" <<EOF
#!/usr/bin/env bash
echo "curl \$*" >> "$STUB_LOG"
[[ -n "\${CURL_OK:-}" ]] || exit 22
out=""
url="\${*: -1}"
while (( \$# > 0 )); do
  [[ "\$1" == -o ]] && { out="\$2"; shift; }
  shift
done
case "\$url" in
  */repos/PetyoLazarov92/devmagic-panel/releases/latest | */repos/PetyoLazarov92/devmagic-panel/releases/tags/v1.2.3) cat "$FIX/release.json" ;;
  */releases/download/v1.2.3/devmagic-panel-v1.2.3.tar.gz) cp "$FIX/devmagic-panel-v1.2.3.tar.gz" "\$out" ;;
  */releases/download/v1.2.3/devmagic-panel-v1.2.3.tar.gz.sha256) cp "$FIX/\${CURL_SUM:-devmagic-panel-v1.2.3.tar.gz.sha256}" "\$out" ;;
  *) exit 22 ;;
esac
EOF
  # gh: the newest tag and a download into -D.
  cat > "$STUBS/gh" <<EOF
#!/usr/bin/env bash
echo "gh \$*" >> "$STUB_LOG"
[[ -n "\${GH_OK:-}" ]] || { echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4; }
case "\$1 \$2" in
  'api repos/PetyoLazarov92/devmagic-panel/releases/latest') echo v1.2.3 ;;
  'release download') cp "$FIX"/devmagic-panel-v1.2.3.tar.gz* "\${*: -1}/" ;;
  *) exit 1 ;;
esac
EOF
  # git: the package tags, and a clone of one of them.
  cat > "$STUBS/git" <<EOF
#!/usr/bin/env bash
echo "git \$*" >> "$STUB_LOG"
[[ -n "\${GIT_OK:-}" ]] || { echo 'git@github.com: Permission denied (publickey).' >&2; exit 128; }
case "\$1" in
  ls-remote) printf 'aaa\trefs/tags/pkg/v1.2.2\nbbb\trefs/tags/pkg/v1.2.3\nccc\trefs/tags/pkg/v1.10.0-x\n' ;;
  clone) mkdir -p "\${*: -1}" && cp "$FIX"/devmagic-panel-v1.2.3.tar.gz* "\${*: -1}/" ;;
  *) exit 1 ;;
esac
EOF
  # node: get.sh must not need it, since install.sh offers to install it.
  printf '#!/bin/sh\necho "node $*" >> "%s"\nexit 99\n' "$STUB_LOG" > "$STUBS/node"
  chmod +x "$STUBS/curl" "$STUBS/gh" "$STUBS/git" "$STUBS/node"
  export PATH="$STUBS:$PATH"
  export TMPDIR="$BATS_TEST_TMPDIR/tmp"
  mkdir -p "$TMPDIR"
  GET="$BATS_TEST_DIRNAME/../../get.sh"
}

@test "a public repository: the newest release through HTTPS, checked, its installer run, never with a token" {
  CURL_OK=1 run bash "$GET" --dry-run --yes < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok: v1.2.3 through public HTTPS"*"ok: checksum matches"* ]]
  [[ "$(cat "$INSTALL_LOG")" == *"ARGS --dry-run --yes"*"FROM release"* ]]
  grep -q 'https://api.github.com/repos/PetyoLazarov92/devmagic-panel/releases/latest$' "$STUB_LOG"
  ! grep -qi 'authorization' "$STUB_LOG"
  ! grep -q '^gh \|^git \|^node ' "$STUB_LOG"
  # The download folder is gone.
  [ -z "$(ls -A "$TMPDIR")" ]
}

@test "a release whose package is not published yet is reported, and nothing is downloaded" {
  printf '{"tag_name": "v1.2.3", "assets": []}\n' > "$FIX/release.json"
  CURL_OK=1 run bash "$GET" < /dev/null
  [ "$status" -eq 1 ]
  [[ "$output" == *"public HTTPS: release v1.2.3 has no package yet"* ]]
  ! grep -q '/releases/download/' "$STUB_LOG"
}

@test "--version installs that release; a bad version or repository is refused" {
  CURL_OK=1 run bash "$GET" --version v1.2.3 < /dev/null
  [ "$status" -eq 0 ]
  grep -q '/releases/tags/v1.2.3$' "$STUB_LOG"
  ! grep -q '/releases/latest' "$STUB_LOG"
  run bash "$GET" --version 'v1.2;rm' < /dev/null
  [ "$status" -eq 2 ]
  run bash "$GET" --repo '-x/y' < /dev/null
  [ "$status" -eq 2 ]
}

@test "a private repository: the GitHub CLI when it is signed in" {
  GH_OK=1 run bash "$GET" < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok: v1.2.3 through the GitHub CLI"* ]]
  grep -q '^gh release download v1.2.3 -R PetyoLazarov92/devmagic-panel -p devmagic-panel-v1.2.3.tar.gz -p devmagic-panel-v1.2.3.tar.gz.sha256 -D ' "$STUB_LOG"
  [[ "$(cat "$INSTALL_LOG")" == *"FROM release"* ]]
}

@test "a private repository: git over SSH on the newest package tag" {
  GIT_OK=1 run bash "$GET" < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok: v1.2.3 through git over SSH"* ]]
  grep -q "^git ls-remote --tags --refs git@github.com:PetyoLazarov92/devmagic-panel.git refs/tags/pkg/v\*$" "$STUB_LOG"
  grep -q '^git clone -q --depth 1 --branch pkg/v1.2.3 -- git@github.com:PetyoLazarov92/devmagic-panel.git ' "$STUB_LOG"
  [[ "$(cat "$INSTALL_LOG")" == *"FROM release"* ]]
}

@test "the package next to it, as in a clone of pkg/latest, installs with no download" {
  here="$BATS_TEST_TMPDIR/clone"
  mkdir -p "$here"
  cp "$GET" "$here/get.sh"
  cp "$FIX"/devmagic-panel-v1.2.3.tar.gz* "$here/"
  run bash "$here/get.sh" < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"Installing v1.2.3 from the package next to this script"* ]]
  [ ! -e "$STUB_LOG" ]
  [[ "$(cat "$INSTALL_LOG")" == *"FROM release"* ]]
}

@test "a package that does not match its checksum is never run" {
  printf '0000  devmagic-panel-v1.2.3.tar.gz\n' > "$FIX/bad.sha256"
  CURL_OK=1 CURL_SUM=bad.sha256 run bash "$GET" < /dev/null
  [ "$status" -eq 1 ]
  [[ "$output" == *"does not match its checksum; nothing was installed"* ]]
  [ ! -e "$INSTALL_LOG" ]
  [ -z "$(ls -A "$TMPDIR")" ]
}

@test "with no way in, it says why each failed and what any one of them needs" {
  run bash "$GET" < /dev/null
  [ "$status" -eq 1 ]
  [[ "$output" == *"no way could read the releases of PetyoLazarov92/devmagic-panel"* ]]
  [[ "$output" == *"public HTTPS: PetyoLazarov92/devmagic-panel is not public"* ]]
  [[ "$output" == *"GitHub CLI: gh cannot read PetyoLazarov92/devmagic-panel"* ]]
  [[ "$output" == *"git over SSH: git cannot read the package tags"* ]]
  [[ "$output" == *"make the repository public, sign in with gh auth login, or use an SSH key"* ]]
  [ ! -e "$INSTALL_LOG" ]
}
