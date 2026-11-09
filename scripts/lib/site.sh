# shellcheck shell=bash
# Site folders under WEB_DIR. Based on devmagic includes/mkwpwebsite.sh,
# changed from chmod 777 to the panel user as owner and the web server
# group with setgid, so new files stay writable by both and nobody else.
#
# The panel records every folder it creates in a root-owned registry,
# $STATE_DIR/sites/<domain>, with the folder's path and its device:inode.
# Removal requires a matching entry, so the panel can only ever delete folders
# it made: never a site set up by hand or by devmagic, never one swapped or
# renamed in place, and nothing of the panel's sits in the site's repo.

# The old marker inside the folder; only read now, by dmp_site_marker_migrate.
DMP_SITE_MARKER=".devmagic-panel-site"

dmp_site_registry_entry() {
  printf '%s/sites/%s' "$STATE_DIR" "$1"
}

# Writes the registry entry for a folder, atomically.
dmp_site_register() {
  local domain="$1" dir="$2" entry tmp
  # Root-owned in real use; the bats tests run as a normal user against a temp tree.
  if [[ $EUID -eq 0 ]]; then
    install -d -m 0755 -o root -g root "$STATE_DIR" "$STATE_DIR/sites"
  else
    install -d -m 0755 "$STATE_DIR" "$STATE_DIR/sites"
  fi
  entry="$(dmp_site_registry_entry "$domain")"
  tmp="$(mktemp "$STATE_DIR/sites/.dmp-site.XXXXXX")"
  printf '%s\n%s\n' "$dir" "$(stat -c '%d:%i' "$dir")" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$entry"
}

# Where the record of a site taken over lives: its original vhosts and how it was.
dmp_takeover_dir() { printf '%s/taken-over/%s' "$STATE_DIR" "$1"; }

# The folder a site lives in: WEB_DIR/<domain>, or for a site taken over the
# folder it had (a real folder right in WEB_DIR), when both its registry entry
# (same device:inode) and its takeover record name it. A registry entry alone
# never points a domain at another folder.
dmp_site_folder() {
  local domain="$1" entry dir manifest
  entry="$(dmp_site_registry_entry "$domain")"
  manifest="$(dmp_takeover_dir "$domain")/manifest.env"
  if [[ -f "$entry" && ! -L "$entry" && -O "$entry" && -f "$manifest" && ! -L "$manifest" && -O "$manifest" ]]; then
    dir="$(sed -n 1p "$entry")"
    if [[ "${dir%/*}" == "$WEB_DIR" && "${dir##*/}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$ && -d "$dir" && ! -L "$dir" ]] \
      && [[ "$(sed -n 2p "$entry")" == "$(stat -c '%d:%i' "$dir")" ]] && grep -qxF "DOCROOT=$dir" "$manifest"; then
      printf '%s' "$dir"
      return 0
    fi
  fi
  printf '%s/%s' "$WEB_DIR" "$domain"
}

dmp_site_dir_create() {
  local domain="$1" dir
  dir="$WEB_DIR/$domain"
  if [[ -e "$dir" ]]; then
    dmp_ok "site folder exists: $dir"
    return 0
  fi
  install -d -m 2775 -o "$PANEL_USER" -g "$WEB_GROUP" "$dir"
  dmp_site_register "$domain" "$dir"
  dmp_ok "site folder created: $dir"
}

dmp_site_dir_remove() {
  local domain="$1" dir entry
  dir="$(dmp_site_folder "$domain")"
  entry="$(dmp_site_registry_entry "$domain")"
  if [[ ! -e "$dir" ]]; then
    rm -f -- "$entry"
    dmp_ok "no site folder: $dir"
    return 0
  fi
  [[ -d "$dir" && ! -L "$dir" ]] || dmp_die "$dir is not a plain folder, leaving it as is"
  [[ -f "$entry" && ! -L "$entry" && -O "$entry" ]] \
    || dmp_die "$dir was not created by devmagic-panel; leaving it as is"
  [[ "$(sed -n 1p "$entry")" == "$dir" && "$(sed -n 2p "$entry")" == "$(stat -c '%d:%i' "$dir")" ]] \
    || dmp_die "$dir is not the folder devmagic-panel created for $domain; leaving it as is"
  dmp_step "Removing $dir"
  rm -rf --one-file-system -- "$dir"
  rm -f -- "$entry"
  dmp_ok "site folder removed: $dir"
}

# Moves markers that older versions left inside site folders into the
# registry, then deletes them, so they stop showing up in git status. Only a
# marker owned by the user running this (root) and naming its own folder counts.
dmp_site_marker_migrate() {
  local marker dir domain moved=0
  for marker in "$WEB_DIR"/*/"$DMP_SITE_MARKER"; do
    [[ -e "$marker" ]] || continue
    dir="${marker%/*}"
    domain="${dir##*/}"
    if ! dmp_is_local_name "$domain" || [[ -L "$dir" || -L "$marker" || ! -f "$marker" || ! -O "$marker" ]] \
      || [[ "$(head -n 1 "$marker")" != "$domain" ]]; then
      dmp_warn "leaving $marker as is: it is not a marker devmagic-panel wrote"
      continue
    fi
    dmp_site_register "$domain" "$dir"
    rm -f -- "$marker"
    moved=$((moved + 1))
  done
  dmp_ok "site markers moved out of site folders: $moved"
}
