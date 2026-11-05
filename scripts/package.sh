#!/usr/bin/env bash
# Packs the built panel into a release the way the release workflow ships it
# and install.sh installs it: devmagic-panel-<name>.tar.gz, its .sha256, and
# devmagic-panel-<name>.json (release.json: version, commit, and checksums of
# install.sh and the root scripts, so the panel can tell what an update
# changes before downloading it). Run after npm run build.
#
#   scripts/package.sh [--out DIR] [--name NAME]
#
# NAME is v<version> when the checkout is that release tag with nothing
# changed, else v<version>-dev.<commit>. The package holds the built code, the
# server's production dependencies, the root scripts and install.sh; no
# sources, tests or build tools.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd -P)"
# shellcheck source=scripts/lib/log.sh
source "$REPO/scripts/lib/log.sh"

OUT="$REPO/dist"
NAME=""
# A release folder name: v0.6.0, or v0.6.0-dev.1a2b3c4 for a build between releases.
NAME_RE='^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,40})?$'

while (( $# > 0 )); do
  case "$1" in
    --out) OUT="${2:?--out needs a folder}"; shift ;;
    --name) NAME="${2:?--name needs a name}"; shift ;;
    -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) dmp_usage_error "unknown option: $1" ;;
  esac
  shift
done

for built in shared/dist/index.js server/dist/index.js server/dist/cli.js web/dist/index.html; do
  [[ -f "$REPO/$built" ]] || dmp_die "no $built: run npm run build first"
done

version="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$REPO/package.json" | head -n 1)"
[[ -n "$version" ]] || dmp_die "no version in package.json"
commit="unknown"
dirty=0
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  commit="$(git -C "$REPO" rev-parse HEAD)"
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || dirty=1
fi
if [[ -z "$NAME" ]]; then
  if (( ! dirty )) && [[ "$(git -C "$REPO" rev-parse -q --verify "refs/tags/v$version^{commit}" 2>/dev/null)" == "$commit" ]]; then
    NAME="v$version"
  else
    NAME="v$version-dev.${commit:0:7}"
    (( dirty )) && NAME="$NAME.dirty"
  fi
fi
[[ "$NAME" =~ $NAME_RE ]] || dmp_usage_error "not a release name: $NAME (like v0.6.0 or v0.6.0-dev.1a2b3c4)"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
STAGE="$(mktemp -d "$OUT/.stage.XXXXXX")"
trap 'rm -rf -- "$STAGE"' EXIT
BASE="devmagic-panel-$NAME"
PKG="$STAGE/$BASE"

dmp_step "Packing $NAME from ${commit:0:9}"
install -d "$PKG/scripts/bin" "$PKG/scripts/lib" "$PKG/scripts/php" "$PKG/scripts/php-compat" "$PKG/shared" "$PKG/server" "$PKG/web"
cp -p "$REPO/package.json" "$REPO/package-lock.json" "$REPO/.nvmrc" "$REPO/install.sh" "$REPO/get.sh" "$REPO/README.md" "$REPO/CHANGELOG.md" "$REPO/LICENSE" "$PKG/"
cp -p "$REPO/scripts/bin/dmp-root" "$REPO/scripts/bin/dmp-restore" "$REPO/scripts/bin/wpcore" "$PKG/scripts/bin/"
cp -p "$REPO"/scripts/lib/*.sh "$PKG/scripts/lib/"
cp -p "$REPO"/scripts/php/*.php "$REPO/scripts/php/starting.html" "$PKG/scripts/php/"
cp -p "$REPO/scripts/php-compat/composer.json" "$REPO/scripts/php-compat/composer.lock" "$PKG/scripts/php-compat/"
for part in shared server web; do
  cp -p "$REPO/$part/package.json" "$PKG/$part/"
  cp -R "$REPO/$part/dist" "$PKG/$part/"
done

dmp_step "Installing the server's production dependencies"
# Only what the server loads: no build tools, no React (the web build is static files).
(cd "$PKG" && npm ci --omit=dev --workspace server --include-workspace-root=false --ignore-scripts --no-audit --no-fund --loglevel=error)

# The package must start: every module the server imports has to be in it.
# Off only in the package tests, whose npm is a stub.
if [[ -z "${DMP_PACKAGE_SKIP_CHECK:-}" ]]; then
  (cd "$PKG" && node --disable-warning=ExperimentalWarning --input-type=module -e "await import('./server/dist/app.js'); await import('./server/dist/mcp.js');") \
    || dmp_die "the packed server does not load: a runtime dependency is missing"
  dmp_ok "the packed server loads"
fi

sha() { sha256sum "$1" | cut -d' ' -f1; }

# release.json, in the package and next to it.
{
  printf '{\n'
  printf '  "name": "%s",\n  "version": "%s",\n  "commit": "%s",\n' "$NAME" "$version" "$commit"
  printf '  "built": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "installer": "%s",\n' "$(sha "$PKG/install.sh")"
  printf '  "scripts": {'
  sep=''
  while IFS= read -r file; do
    printf '%s\n    "%s": "%s"' "$sep" "$file" "$(sha "$PKG/scripts/$file")"
    sep=','
  done < <(cd "$PKG/scripts" && find bin lib php -type f | LC_ALL=C sort)
  printf '\n  }\n}\n'
} > "$PKG/release.json"

tar --owner=0 --group=0 --numeric-owner -C "$STAGE" -czf "$OUT/$BASE.tar.gz" "$BASE"
(cd "$OUT" && sha256sum "$BASE.tar.gz" > "$BASE.tar.gz.sha256")
cp "$PKG/release.json" "$OUT/$BASE.json"
dmp_ok "$OUT/$BASE.tar.gz ($(du -h "$OUT/$BASE.tar.gz" | cut -f1)), with $BASE.tar.gz.sha256 and $BASE.json"
