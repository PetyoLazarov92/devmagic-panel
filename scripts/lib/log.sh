# shellcheck shell=bash
# Logging helpers shared by dmp-root and install.sh.
# Lines start with a fixed marker so the panel can show them as steps:
#   ==> step   ok: done   warn: notice   error: failure (stderr)

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  DMP_C_BLUE=$'\033[0;34m' DMP_C_GREEN=$'\033[0;32m' DMP_C_YELLOW=$'\033[1;33m'
  DMP_C_RED=$'\033[0;31m' DMP_C_RESET=$'\033[0m'
else
  DMP_C_BLUE='' DMP_C_GREEN='' DMP_C_YELLOW='' DMP_C_RED='' DMP_C_RESET=''
fi

dmp_step() { printf '%s==>%s %s\n' "$DMP_C_BLUE" "$DMP_C_RESET" "$*"; }
dmp_ok() { printf '%sok:%s %s\n' "$DMP_C_GREEN" "$DMP_C_RESET" "$*"; }
dmp_warn() { printf '%swarn:%s %s\n' "$DMP_C_YELLOW" "$DMP_C_RESET" "$*"; }
dmp_error() { printf '%serror:%s %s\n' "$DMP_C_RED" "$DMP_C_RESET" "$*" >&2; }

# Exit codes: 1 = the operation failed, 2 = bad usage or input.
dmp_die() { dmp_error "$*"; exit 1; }
dmp_usage_error() { dmp_error "$*"; exit 2; }
