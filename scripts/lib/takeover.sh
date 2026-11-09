# shellcheck shell=bash
# Taking over a site made by hand: its Apache vhost becomes the panel's, so
# every panel feature works on it, and giving it back puts the original
# files back. dmp-root finds the vhost files itself, by the domain in their
# ServerName or ServerAlias, never from a path the caller gives.
#
# vhost-adopt <domain> --check   prints what it found, changes nothing
# vhost-adopt <domain> [--drop-lines]
#   keeps the originals with checksums in $STATE_DIR/taken-over/<domain>,
#   registers the folder where it is, writes the panel's vhost with the same
#   names, folder and sites under a path, and puts everything back when the
#   configtest fails. Lines the panel's vhost does not have are refused
#   unless --drop-lines (they stay in the kept originals).
# vhost-release <domain>
#   puts the kept originals back (checksums checked) instead of the panel's
#   vhost, and drops the folder's registry entry the takeover made.
#
# Nothing from a hand-made file is copied into the panel's vhost except the
# names (each a local name), the document root (a real folder right in
# WEB_DIR) and the sites under a path (each checked like vhost-write's).

# Lines a hand-made vhost may have that the panel's own vhost covers.
DMP_ADOPT_KNOWN='^(servername|serveralias|documentroot|sslengine|sslcertificatefile|sslcertificatekeyfile|sslcertificatechainfile|errorlog|customlog|rewriteengine|options|allowoverride|require|directoryindex|order|allow)$'

# The hand-made vhost files of a domain: ones whose names include it, not the panel's.
dmp_adopt_files() {
  local domain="$1" f name
  for f in "$APACHE_SITES_AVAILABLE"/*.conf; do
    [[ -f "$f" && ! -L "$f" ]] || continue
    dmp_vhost_is_managed "$f" && continue
    while IFS= read -r name; do
      if [[ "$name" == "$domain" ]]; then
        printf '%s\n' "$f"
        break
      fi
    done < <(dmp_vhost_names "$f")
  done
}

# Reads the hand-made files and prints NAME=, DOCROOT=, MOUNT=, FILE=,
# ENABLED=, EXTRA= and PROBLEM= lines: what the panel's vhost would keep, and
# what it would not.
dmp_adopt_read() {
  local domain="$1" f line word rest in_vhost=0 block_name="" port="" in_dir="" docroot="" dir_ok=0
  local -a files=()
  mapfile -t files < <(dmp_adopt_files "$domain")
  if (( ${#files[@]} == 0 )); then
    printf 'PROBLEM=%s\n' "no vhost made by hand names $domain"
    return 0
  fi
  local -A names=()
  local -a mounts=() docroots=()
  for f in "${files[@]}"; do
    printf 'FILE=%s\n' "${f##*/}"
    [[ -e "$APACHE_SITES_ENABLED/${f##*/}" ]] && printf 'ENABLED=%s\n' "${f##*/}"
    in_vhost=0
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      [[ -z "$line" || "$line" == \#* ]] && continue
      word="${line%%[[:space:]]*}"
      rest="${line#"$word"}"
      rest="${rest#"${rest%%[![:space:]]*}"}"
      case "${word,,}" in
        '<virtualhost')
          in_vhost=1
          block_name=""
          port="${rest%>}"
          ;;
        '</virtualhost>')
          [[ -z "$block_name" || "$block_name" == "$domain" ]] || printf 'PROBLEM=%s\n' "${f##*/} also holds $block_name: split it into a file of its own first"
          in_vhost=0
          ;;
        '<directory')
          in_dir="${rest%>}"
          in_dir="${in_dir//\"/}"
          dir_ok=0
          [[ "$in_dir" == "$docroot" || "$in_dir" == "$WEB_DIR/"* ]] && dir_ok=1
          (( dir_ok )) || printf 'EXTRA=%s\n' "$line"
          ;;
        '</directory>')
          (( dir_ok )) || printf 'EXTRA=%s\n' "$line"
          in_dir=""
          ;;
        servername)
          block_name="$rest"
          names["$rest"]=1
          ;;
        serveralias)
          # shellcheck disable=SC2086 # the aliases are words
          for word in $rest; do names["$word"]=1; done
          ;;
        documentroot)
          docroot="${rest//\"/}"
          docroot="${docroot%/}"
          docroots+=("$docroot")
          ;;
        alias)
          local at target
          at="${rest%%[[:space:]]*}"
          target="${rest#"$at"}"
          target="${target#"${target%%[![:space:]]*}"}"
          target="${target//\"/}"
          target="${target%/}"
          if [[ "$at" =~ ^(/[a-z0-9][a-z0-9-]{0,62})+$ && "${target%/*}" == "$WEB_DIR" ]] && dmp_is_local_name "${target##*/}" && [[ -d "$target" && ! -L "$target" ]]; then
            mounts+=("$at=${target##*/}")
          else
            printf 'EXTRA=%s\n' "$line"
          fi
          ;;
        rewriterule | rewritecond | redirect | redirectmatch)
          # The port 80 block's redirect to https is the panel's too; anything else is not.
          if [[ "$port" == *:80 && ( "${word,,}" == redirect* && "$rest" == *https://* || "${word,,}" == rewrite* && ( "$rest" == *https://* || "$rest" == *'%{HTTPS}'* || "$rest" == *'%{SERVER_NAME}'* || "$rest" == *'%{HTTP_HOST}'* ) ) ]]; then
            :
          else
            printf 'EXTRA=%s\n' "$line"
          fi
          ;;
        *)
          if [[ ! "${word,,}" =~ $DMP_ADOPT_KNOWN ]] || (( ! in_vhost )); then
            printf 'EXTRA=%s\n' "$line"
          fi
          ;;
      esac
    done < "$f"
  done
  local name
  for name in "${!names[@]}"; do
    if dmp_is_local_name "$name"; then
      printf 'NAME=%s\n' "$name"
    else
      printf 'PROBLEM=%s\n' "$name is not a local name: the panel only manages local.*, *.test and *.localhost names"
    fi
  done
  local unique
  unique="$(printf '%s\n' "${docroots[@]}" | sort -u)"
  if [[ -z "$unique" ]]; then
    printf 'PROBLEM=%s\n' "the vhost has no DocumentRoot"
  elif [[ "$(printf '%s\n' "$unique" | wc -l)" -gt 1 ]]; then
    printf 'PROBLEM=%s\n' "its blocks serve more than one folder: $(printf '%s ' "$unique")"
  elif [[ "${unique%/*}" != "$WEB_DIR" || ! "${unique##*/}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$ ]]; then
    printf 'PROBLEM=%s\n' "$unique is not a folder right in $WEB_DIR: move it there first"
  elif [[ ! -d "$unique" || -L "$unique" ]]; then
    printf 'PROBLEM=%s\n' "$unique is not a plain folder"
  else
    printf 'DOCROOT=%s\n' "$unique"
  fi
  for f in "${mounts[@]}"; do printf 'MOUNT=%s\n' "$f"; done
  if [[ -e "$(dmp_takeover_dir "$domain")" ]]; then
    printf 'PROBLEM=%s\n' "$domain was taken over already"
  fi
  if [[ -e "$(dmp_vhost_file "$domain")" ]] && dmp_vhost_is_managed "$(dmp_vhost_file "$domain")"; then
    printf 'PROBLEM=%s\n' "$domain has the panel's vhost already"
  fi
}

# vhost-adopt <domain> [--check | --drop-lines]
dmp_vhost_adopt() {
  local domain="$1" mode="${2:-}" report dir f
  [[ -z "$mode" || "$mode" == --check || "$mode" == --drop-lines ]] || dmp_usage_error "vhost-adopt takes --check or --drop-lines"
  report="$(dmp_adopt_read "$domain")"
  if [[ "$mode" == --check ]]; then
    printf '%s\n' "$report"
    return 0
  fi
  local problems extra docroot
  problems="$(printf '%s\n' "$report" | sed -n 's/^PROBLEM=//p')"
  [[ -z "$problems" ]] || dmp_die "$domain cannot be taken over: $(printf '%s' "$problems" | tr '\n' ';')"
  extra="$(printf '%s\n' "$report" | sed -n 's/^EXTRA=//p')"
  [[ -z "$extra" || "$mode" == --drop-lines ]] || dmp_die "the vhost has lines the panel's does not keep; run with --drop-lines to leave them out (they stay in the kept originals): $(printf '%s' "$extra" | tr '\n' ';')"
  docroot="$(printf '%s\n' "$report" | sed -n 's/^DOCROOT=//p')"
  [[ -f "$(dmp_cert_file "$domain")" ]] || dmp_die "no certificate for $domain yet, run: dmp-root cert-issue $domain"
  local -a files=() enabled=() aliases=()
  mapfile -t files < <(printf '%s\n' "$report" | sed -n 's/^FILE=//p')
  mapfile -t enabled < <(printf '%s\n' "$report" | sed -n 's/^ENABLED=//p')
  mapfile -t aliases < <(printf '%s\n' "$report" | sed -n 's/^NAME=//p' | grep -vxF "$domain" || true)
  # Read by dmp_vhost_render_site in vhost.sh.
  # shellcheck disable=SC2034
  DMP_VHOST_MOUNTS=()
  # shellcheck disable=SC2034
  mapfile -t DMP_VHOST_MOUNTS < <(printf '%s\n' "$report" | sed -n 's/^MOUNT=//p')

  dir="$(dmp_takeover_dir "$domain")"
  local registered=0 entry
  entry="$(dmp_site_registry_entry "$domain")"
  [[ -f "$entry" ]] || registered=1
  dmp_step "Taking over $domain: keeping its vhost in $dir"
  if [[ $EUID -eq 0 ]]; then
    install -d -m 0755 -o root -g root "$STATE_DIR" "$STATE_DIR/taken-over"
  else
    install -d -m 0755 "$STATE_DIR" "$STATE_DIR/taken-over"
  fi
  install -d -m 0700 "$dir"
  for f in "${files[@]}"; do cp -p -- "$APACHE_SITES_AVAILABLE/$f" "$dir/$f"; done
  {
    printf 'DOMAIN=%s\n' "$domain"
    printf 'AT=%s\n' "$(date +%s)"
    printf 'FILES=%s\n' "${files[*]}"
    printf 'ENABLED=%s\n' "${enabled[*]}"
    printf 'DOCROOT=%s\n' "$docroot"
    printf 'REGISTERED=%s\n' "$registered"
    printf 'DROPPED=%s\n' "$(printf '%s' "$extra" | grep -c . || true)"
  } > "$dir/manifest.env"
  (cd "$dir" && sha256sum -- "${files[@]}" manifest.env > SHA256SUMS)
  chmod 0600 "$dir"/*
  (( registered )) && dmp_site_register "$domain" "$docroot"

  # The originals leave sites-available, then the panel's vhost takes their place.
  for f in "${enabled[@]}"; do a2dissite -q "$f" >/dev/null 2>&1 || true; done
  for f in "${files[@]}"; do rm -f -- "$APACHE_SITES_AVAILABLE/$f"; done
  if ! (dmp_vhost_render_site "$domain" "" "${aliases[@]}" | dmp_vhost_install "$domain"); then
    dmp_adopt_put_back "$domain"
    dmp_die "Apache refused the panel's vhost for $domain; the original vhost is back"
  fi
  dmp_ok "took over $domain: the panel manages its vhost now; vhost-release $domain gives it back"
}

# The kept originals back in sites-available instead of the panel's vhost.
dmp_adopt_put_back() {
  local domain="$1" dir manifest f
  dir="$(dmp_takeover_dir "$domain")"
  manifest="$dir/manifest.env"
  if [[ -f "$(dmp_vhost_file "$domain")" ]] && dmp_vhost_is_managed "$(dmp_vhost_file "$domain")"; then
    a2dissite -q "$domain-ssl.conf" >/dev/null 2>&1 || true
    rm -f -- "$(dmp_vhost_file "$domain")"
  fi
  for f in $(dmp_trash_get "$manifest" FILES); do
    [[ "$f" =~ ^[A-Za-z0-9._-]+\.conf$ ]] || dmp_die "the takeover record names an odd file: $f"
    install -m 0644 -- "$dir/$f" "$APACHE_SITES_AVAILABLE/$f"
  done
  for f in $(dmp_trash_get "$manifest" ENABLED); do
    [[ "$f" =~ ^[A-Za-z0-9._-]+\.conf$ ]] || continue
    a2ensite -q "$f" >/dev/null || dmp_warn "a2ensite $f failed"
  done
  if [[ "$(dmp_trash_get "$manifest" REGISTERED)" == 1 ]]; then
    rm -f -- "$(dmp_site_registry_entry "$domain")"
  fi
  rm -rf -- "$dir"
  if dmp_apache_configtest >/dev/null 2>&1; then
    systemctl reload apache2 >/dev/null 2>&1 || true
  fi
}

# vhost-release <domain>: the site made by hand gets its own vhost back.
dmp_vhost_release() {
  local domain="$1" dir file keep
  dir="$(dmp_takeover_dir "$domain")"
  [[ -d "$dir" && ! -L "$dir" && -f "$dir/manifest.env" ]] || dmp_die "$domain was not taken over"
  (cd "$dir" && sha256sum --quiet -c SHA256SUMS) || dmp_die "the kept vhost of $domain does not match its checksums; restore it with dmp-restore"
  [[ "$(dmp_trash_get "$dir/manifest.env" DOMAIN)" == "$domain" ]] || dmp_die "the takeover record is not $domain's"
  file="$(dmp_vhost_file "$domain")"
  [[ -f "$file" ]] && dmp_vhost_require_managed "$file"
  if declare -F dmp_nginx_front_on >/dev/null && dmp_nginx_front_on "$domain"; then
    dmp_die "nginx answers for $domain in front of its vhost: take the site off nginx first"
  fi
  [[ ! -e "$NGINX_SITES_AVAILABLE/$domain.conf" ]] || dmp_die "$domain runs on nginx: move it back to Apache first"
  # The panel's vhost, kept until Apache takes the originals back.
  keep="$(mktemp)"
  [[ -f "$file" ]] && cp -p -- "$file" "$keep"
  dmp_step "Giving $domain its own vhost back"
  local manifest="$dir/manifest.env" f
  local -a files=() enabled=()
  read -r -a files <<< "$(dmp_trash_get "$manifest" FILES)"
  read -r -a enabled <<< "$(dmp_trash_get "$manifest" ENABLED)"
  for f in "${files[@]}" "${enabled[@]}"; do
    [[ "$f" =~ ^[A-Za-z0-9._-]+\.conf$ ]] || dmp_die "the takeover record names an odd file: $f"
  done
  if [[ -f "$file" ]]; then
    a2dissite -q "$domain-ssl.conf" >/dev/null 2>&1 || true
    rm -f -- "$file"
  fi
  for f in "${files[@]}"; do install -m 0644 -- "$dir/$f" "$APACHE_SITES_AVAILABLE/$f"; done
  for f in "${enabled[@]}"; do a2ensite -q "$f" >/dev/null || dmp_warn "a2ensite $f failed"; done
  if ! dmp_apache_configtest; then
    for f in "${enabled[@]}"; do a2dissite -q "$f" >/dev/null 2>&1 || true; done
    for f in "${files[@]}"; do rm -f -- "$APACHE_SITES_AVAILABLE/$f"; done
    if [[ -s "$keep" ]]; then
      install -m 0644 -- "$keep" "$file"
      a2ensite -q "$domain-ssl.conf" >/dev/null || true
    fi
    rm -f -- "$keep"
    dmp_die "Apache refused the original vhost of $domain; the panel's stays"
  fi
  rm -f -- "$keep"
  if [[ "$(dmp_trash_get "$manifest" REGISTERED)" == 1 ]]; then
    rm -f -- "$(dmp_site_registry_entry "$domain")"
  fi
  rm -rf -- "$dir"
  systemctl reload apache2 || dmp_die "apache reload failed"
  dmp_ok "gave $domain its own vhost back"
}
