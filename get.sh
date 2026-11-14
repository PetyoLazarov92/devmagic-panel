#!/usr/bin/env bash
# Installs devmagic-panel from its newest release, or the one given with
# --version: gets the package and its checksum, checks it, unpacks it in a
# temporary folder and runs its install.sh, which puts the release in
# ~/.local/share/devmagic-panel/releases and asks the usual questions.
#
# Any access to the repository is enough, and no token is needed. It uses the
# first of these that works:
#   - the package next to this script, in a clone of the pkg/latest branch;
#   - public HTTPS, when the repository is public;
#   - the GitHub CLI, when gh is signed in with access to the repository;
#   - git over SSH, when your key can read it (its pkg/vX.Y.Z package tags).
#
#   bash get.sh [--version v0.7.0] [--repo owner/name] [install.sh options, like --dry-run]
set -euo pipefail

SLUG="${DMP_RELEASE_REPO:-PetyoLazarov92/devmagic-panel}"
GIT_URL="${DMP_GIT_URL:-}"
VERSION=""
PASS=()
TAG_RE='^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$'

step() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while (( $# > 0 )); do
  case "$1" in
    --version) VERSION="${2:?--version needs a release, like v0.7.0}"; shift ;;
    --repo) SLUG="${2:?--repo needs owner/name}"; shift ;;
    -h | --help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PASS+=("$1") ;;
  esac
  shift
done
if [[ -n "$VERSION" && ! "$VERSION" =~ $TAG_RE ]]; then
  printf 'error: not a release: %s (like v0.7.0)\n' "$VERSION" >&2
  exit 2
fi
if [[ ! "$SLUG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*/[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
  printf 'error: not a repository: %s (like owner/name)\n' "$SLUG" >&2
  exit 2
fi
GIT_URL="${GIT_URL:-git@github.com:$SLUG.git}"
[[ "$GIT_URL" != -* ]] || die "not a git remote: $GIT_URL"

# Node and the rest come later: install.sh checks them and offers to install them.
for cmd in tar sha256sum; do
  command -v "$cmd" >/dev/null || die "$cmd is required"
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/devmagic-panel-get.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG=""
PROBLEMS=()

# Why a way did not work, for the message when none does.
problem() { PROBLEMS+=("$1: $2"); }

# The package and its checksum in $1, for $TAG, into $WORK.
take() {
  cp -- "$1/devmagic-panel-$TAG.tar.gz" "$1/devmagic-panel-$TAG.tar.gz.sha256" "$WORK/"
}

# A package next to this script, as in a clone of pkg/latest or pkg/vX.Y.Z.
from_here() {
  local f name
  for f in "$HERE"/devmagic-panel-v*.tar.gz; do
    [[ -f "$f" && -f "$f.sha256" ]] || continue
    name="$(basename "$f" .tar.gz)"
    TAG="${name#devmagic-panel-}"
    [[ "$TAG" =~ $TAG_RE ]] || continue
    [[ -z "$VERSION" || "$VERSION" == "$TAG" ]] || continue
    take "$HERE"
    return 0
  done
  TAG=""
  return 1
}

# Public HTTPS: the releases API and the download addresses, with no login.
via_https() {
  command -v curl >/dev/null || { problem 'public HTTPS' 'curl is not installed'; return 1; }
  local api="https://api.github.com/repos/$SLUG/releases" url json pkg
  url="$api/latest"
  [[ -n "$VERSION" ]] && url="$api/tags/$VERSION"
  local -a get=(curl -fsSL --proto '=https' --proto-redir '=https')
  json="$("${get[@]}" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$url" 2>/dev/null)" \
    || { problem 'public HTTPS' "$SLUG is not public, or GitHub could not be reached"; return 1; }
  # The tag, read without a JSON tool; the package's address follows from it.
  TAG="$(grep -oE '"tag_name": *"[^"]*"' <<< "$json" | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/' || true)"
  [[ "$TAG" =~ $TAG_RE ]] || { problem 'public HTTPS' 'the release has no version tag'; return 1; }
  pkg="devmagic-panel-$TAG.tar.gz"
  grep -qF "\"$pkg.sha256\"" <<< "$json" \
    || { problem 'public HTTPS' "release $TAG has no package yet: its release workflow may still be running"; return 1; }
  local dl="https://github.com/$SLUG/releases/download/$TAG"
  if ! "${get[@]}" -o "$WORK/$pkg" "$dl/$pkg" || ! "${get[@]}" -o "$WORK/$pkg.sha256" "$dl/$pkg.sha256"; then
    problem 'public HTTPS' "could not download the package of $TAG"
    return 1
  fi
}

# The GitHub CLI, with its own sign-in.
via_gh() {
  command -v gh >/dev/null || { problem 'GitHub CLI' 'gh is not installed'; return 1; }
  TAG="$VERSION"
  if [[ -z "$TAG" ]]; then
    TAG="$(GH_PROMPT_DISABLED=1 gh api "repos/$SLUG/releases/latest" --jq .tag_name 2>/dev/null)" \
      || { problem 'GitHub CLI' "gh cannot read $SLUG: sign in with gh auth login, with an account that can read it"; return 1; }
  fi
  [[ "$TAG" =~ $TAG_RE ]] || { problem 'GitHub CLI' 'the release has no version tag'; return 1; }
  GH_PROMPT_DISABLED=1 gh release download "$TAG" -R "$SLUG" -p "devmagic-panel-$TAG.tar.gz" -p "devmagic-panel-$TAG.tar.gz.sha256" -D "$WORK" >/dev/null 2>&1 \
    || { problem 'GitHub CLI' "could not download the package of $TAG"; return 1; }
}

# git over SSH (or git's own HTTPS sign-in) on the package tags.
via_git() {
  command -v git >/dev/null || { problem 'git over SSH' 'git is not installed'; return 1; }
  local -a quiet=(env GIT_TERMINAL_PROMPT=0 'GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=15')
  TAG="$VERSION"
  if [[ -z "$TAG" ]]; then
    TAG="$("${quiet[@]}" git ls-remote --tags --refs "$GIT_URL" 'refs/tags/pkg/v*' 2>/dev/null | sed -E 's#^.*refs/tags/pkg/##' | grep -E "$TAG_RE" | sort -V | tail -1)" || true
    [[ -n "$TAG" ]] || { problem 'git over SSH' "git cannot read the package tags of $GIT_URL"; return 1; }
  fi
  "${quiet[@]}" git clone -q --depth 1 --branch "pkg/$TAG" -- "$GIT_URL" "$WORK/pkg" 2>/dev/null \
    || { problem 'git over SSH' "git cannot fetch pkg/$TAG from $GIT_URL"; return 1; }
  take "$WORK/pkg"
}

if from_here; then
  step "Installing $TAG from the package next to this script"
else
  step "Looking for ${VERSION:-the newest release} of $SLUG"
  if via_https; then
    printf 'ok: %s through public HTTPS\n' "$TAG"
  elif via_gh; then
    printf 'ok: %s through the GitHub CLI\n' "$TAG"
  elif via_git; then
    printf 'ok: %s through git over SSH\n' "$TAG"
  else
    printf 'error: no way could read the releases of %s:\n' "$SLUG" >&2
    printf '  %s\n' "${PROBLEMS[@]}" >&2
    printf 'Any one of them is enough: make the repository public, sign in with gh auth login, or use an SSH key that can read it.\n' >&2
    exit 1
  fi
fi

BASE="devmagic-panel-$TAG.tar.gz"
(cd "$WORK" && sha256sum -c --quiet "$BASE.sha256") || die "$BASE does not match its checksum; nothing was installed"
printf 'ok: checksum matches\n'

mkdir "$WORK/release"
tar -xzf "$WORK/$BASE" -C "$WORK/release" --strip-components=1 --no-same-owner
[[ -x "$WORK/release/install.sh" && -f "$WORK/release/release.json" ]] || die "$BASE is not a devmagic-panel release"

step "Running the installer of $TAG"
"$WORK/release/install.sh" "${PASS[@]}"
