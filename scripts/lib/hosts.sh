# shellcheck shell=bash
# /etc/hosts entries live in one marked block:
#
#   # BEGIN devmagic-panel (managed by the panel, edit sites there)
#   127.0.0.1 local.site.com local.site.de
#   # END devmagic-panel
#
# One line per site, keyed by its primary domain (the first name). Lines
# outside the block, written by hand or by devmagic, are never changed. The
# address is where the site runs, read from the system: NGINX_ADDRESS when
# nginx serves it (dmp_nginx_site_on), else APACHE_ADDRESS.

DMP_HOSTS_BEGIN="# BEGIN devmagic-panel (managed by the panel, edit sites there)"
DMP_HOSTS_END="# END devmagic-panel"

# Rewrites the hosts file without the given domain's line and, when a new
# line is passed, with that line added. Keeps the inode, owner and mode.
dmp_hosts_rewrite() {
  local domain="$1" new_line="${2:-}"
  local -a before=() block=() after=()
  local line state=before

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$state" in
      before)
        if [[ "$line" == "$DMP_HOSTS_BEGIN" ]]; then state=block; else before+=("$line"); fi ;;
      block)
        if [[ "$line" == "$DMP_HOSTS_END" ]]; then state=after; else block+=("$line"); fi ;;
      after)
        if [[ "$line" == "$DMP_HOSTS_BEGIN" ]]; then dmp_die "$HOSTS_FILE has two devmagic-panel blocks, fix it by hand"; fi
        after+=("$line") ;;
    esac
  done < "$HOSTS_FILE"
  if [[ "$state" == block ]]; then dmp_die "$HOSTS_FILE has a devmagic-panel BEGIN line without END, fix it by hand"; fi

  local -a kept=()
  local -a fields
  for line in "${block[@]}"; do
    read -r -a fields <<< "$line"
    [[ "${fields[1]:-}" == "$domain" ]] || kept+=("$line")
  done
  if [[ -n "$new_line" ]]; then kept+=("$new_line"); fi

  local tmp
  tmp="$(mktemp)"
  {
    if (( ${#before[@]} > 0 )); then printf '%s\n' "${before[@]}"; fi
    if (( ${#kept[@]} > 0 )); then
      # A new block goes at the end, after one blank line.
      if [[ "$state" == before && ${#before[@]} -gt 0 && -n "${before[-1]}" ]]; then printf '\n'; fi
      printf '%s\n' "$DMP_HOSTS_BEGIN" "${kept[@]}" "$DMP_HOSTS_END"
    fi
    if (( ${#after[@]} > 0 )); then printf '%s\n' "${after[@]}"; fi
  } > "$tmp"
  cat "$tmp" > "$HOSTS_FILE"
  rm -f "$tmp"
}

dmp_hosts_add() {
  local domain="$1"
  shift
  local -a names
  mapfile -t names < <(dmp_unique_aliases "$domain" "$@")
  names=("$domain" "${names[@]}")
  local address="$APACHE_ADDRESS"
  dmp_nginx_site_on "$domain" && address="$NGINX_ADDRESS"
  dmp_step "Adding $domain to $HOSTS_FILE"
  dmp_hosts_rewrite "$domain" "$address ${names[*]}"
  dmp_ok "hosts entry written for $domain"
}

dmp_hosts_remove() {
  local domain="$1"
  dmp_step "Removing $domain from $HOSTS_FILE"
  dmp_hosts_rewrite "$domain"
  dmp_ok "hosts entry removed for $domain"
}
