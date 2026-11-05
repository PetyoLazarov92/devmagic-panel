# shellcheck shell=bash
# Input checks for every name that reaches a root operation.

# A local hostname: lowercase labels, and it must be clearly local
# (local.* or www.local.*, *.test, *.localhost). This stops the
# passwordless sudo rule from minting trusted certs or hosts entries for
# real public domains.
dmp_is_local_name() {
  local name="$1"
  local label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
  (( ${#name} <= 253 )) || return 1
  [[ "$name" =~ ^${label}(\.${label})+$ ]] || return 1
  [[ "$name" == local.* || "$name" == www.local.* || "$name" == *.test || "$name" == *.localhost ]]
}

dmp_require_local_name() {
  dmp_is_local_name "$1" || dmp_usage_error "not a valid local domain: '$1' (use local.example.com, *.test or *.localhost)"
}

# Removes duplicates and the primary domain from an alias list, keeping order.
# Usage: mapfile -t aliases < <(dmp_unique_aliases "$domain" "${aliases[@]}")
dmp_unique_aliases() {
  local domain="$1" name seen=" "
  shift
  for name in "$@"; do
    [[ "$name" == "$domain" || "$seen" == *" $name "* ]] && continue
    seen+="$name "
    printf '%s\n' "$name"
  done
}

# A path a site is served under in its parent's vhost, like /learn or
# /blog/en: segments of letters, digits, dots, dashes and underscores, never
# "." or "..", so Apache reads it as a plain path.
dmp_require_mount_path() {
  local path="$1"
  if [[ ! "$path" =~ ^(/[A-Za-z0-9._-]+)+$ || "$path/" == */./* || "$path/" == */../* ]]; then
    dmp_usage_error "not a valid path: '$path' (use /learn)"
  fi
}

# A plain hostname (any public or local domain), for the uploads proxy target.
# No scheme, port, path or anything Apache could read as syntax.
dmp_require_hostname() {
  local name="$1"
  local label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
  if (( ${#name} > 253 )) || [[ ! "$name" =~ ^${label}(\.${label})+$ ]]; then
    dmp_usage_error "not a valid hostname: '$name'"
  fi
}
