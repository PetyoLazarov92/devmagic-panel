# shellcheck shell=bash
# Deleted sites. Removing a site first archives everything it had into a
# root-owned folder, $STATE_DIR/trash/<domain>-<stamp>/:
#
#   site.tar.gz     the site folder, owners and modes kept
#   config.tar.gz   its vhost files (Apache's, and nginx's for a site on nginx) and certificate folder
#   db.sql.gz       the database dump the panel exported (when there is one)
#   manifest.env    plain KEY=value facts, read without sourcing
#   SHA256SUMS      checksums of the files above
#
# The site is only removed once its archive checks out, and it can be put
# back until the entry is purged (14 days by default). Everything stays
# root-owned and private: a restore writes Apache config, which can run
# programs as root, so nobody but root may change what it restores from.
# Hosts lines outside the panel's block are never changed, here as anywhere.

DMP_TRASH_STAMP='^[0-9]{8}-[0-9]{6}$'
DMP_TRASH_SQL_NAME='^[A-Za-z0-9_]{1,64}$'
# Why a site went to the archive: deleted, or replaced by a reinstall or a restore.
DMP_TRASH_REASON='^(deleted|reinstall|restore)$'

dmp_trash_dir() { printf '%s/trash' "$STATE_DIR"; }

# An entry id is <domain>-<stamp>; checks both parts.
dmp_trash_require_id() {
  local id="$1"
  [[ "$id" =~ ^(.+)-([0-9]{8}-[0-9]{6})$ ]] || dmp_usage_error "not a trash entry: '$id'"
  dmp_require_local_name "${BASH_REMATCH[1]}"
}

# The vhost files a site may have, by the names the panel and devmagic use,
# and the panel's nginx file for a site on nginx.
dmp_trash_vhost_files() {
  local domain="$1" f
  for f in "$APACHE_SITES_AVAILABLE/$domain-ssl.conf" "$APACHE_SITES_AVAILABLE/$domain.conf" "$(dmp_nginx_site_file "$domain")"; do
    [[ -f "$f" && ! -L "$f" ]] && printf '%s\n' "$f"
  done
  return 0
}

dmp_trash_is_nginx() { [[ "$1" == "$NGINX_SITES_AVAILABLE/"* ]]; }

# Reads one KEY from a manifest without running anything in it.
dmp_trash_get() {
  local file="$1" key="$2" line
  while IFS= read -r line; do
    [[ "$line" == "$key="* ]] && { printf '%s' "${line#*=}"; return 0; }
  done < "$file"
  return 0
}

dmp_trash_verify() {
  local entry="$1" f
  [[ -f "$entry/SHA256SUMS" && -f "$entry/manifest.env" ]] || dmp_die "$entry is not a complete trash entry"
  (cd "$entry" && sha256sum --quiet -c SHA256SUMS) || dmp_die "$entry does not match its checksums"
  for f in "$entry"/*.tar.gz; do
    tar -tzf "$f" >/dev/null || dmp_die "$f cannot be read"
  done
}

# The folder an archive was made from: its FOLDER when that is right in
# WEB_DIR (a site taken over keeps its folder's name), else WEB_DIR/<domain>.
dmp_trash_folder() {
  local manifest="$1" domain="$2" folder
  folder="$(dmp_trash_get "$manifest" FOLDER)"
  if [[ "${folder%/*}" == "$WEB_DIR" && "${folder##*/}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$ ]]; then
    printf '%s' "$folder"
  else
    printf '%s/%s' "$WEB_DIR" "$domain"
  fi
}

# trash-site <domain> <stamp> <db-name|-> <db-user|-> [deleted|reinstall|restore]
dmp_trash_site() {
  local domain="$1" stamp="$2" db_name="$3" db_user="$4" reason="${5:-deleted}"
  [[ "$stamp" =~ $DMP_TRASH_STAMP ]] || dmp_usage_error "not a stamp: '$stamp' (YYYYMMDD-HHMMSS)"
  [[ "$reason" =~ $DMP_TRASH_REASON ]] || dmp_usage_error "not a reason: '$reason' (deleted, reinstall or restore)"
  [[ "$db_name" == - || "$db_name" =~ $DMP_TRASH_SQL_NAME ]] || dmp_usage_error "not a database name: '$db_name'"
  [[ "$db_user" == - || "$db_user" =~ $DMP_TRASH_SQL_NAME ]] || dmp_usage_error "not a database user: '$db_user'"

  local folder entry cert dump panel_made=0
  # A site taken over keeps its folder's name: the registry names it.
  folder="$(dmp_site_folder "$domain")"
  entry="$(dmp_trash_dir)/$domain-$stamp"
  cert="$(dmp_cert_dir "$domain")"
  dump="$BACKUP_DIR/sites/$domain-$stamp.sql.gz"
  [[ -d "$folder" && ! -L "$folder" ]] || dmp_die "$folder is not a plain folder"
  [[ ! -e "$entry" ]] || dmp_die "$entry already exists"

  local -a vhosts=() members=() enabled=() apache=()
  local nginx="" nginx_enabled=""
  mapfile -t vhosts < <(dmp_trash_vhost_files "$domain")
  (( ${#vhosts[@]} > 0 )) || dmp_die "no vhost named $domain-ssl.conf or $domain.conf; remove this site by hand"
  local f
  for f in "${vhosts[@]}"; do
    members+=("${f#/}")
    if dmp_trash_is_nginx "$f"; then
      nginx="${f##*/}"
      [[ -e "$NGINX_SITES_ENABLED/$nginx" ]] && nginx_enabled="$nginx"
    else
      apache+=("$f")
      [[ -e "$APACHE_SITES_ENABLED/${f##*/}" ]] && enabled+=("${f##*/}")
    fi
  done
  [[ -d "$cert" && ! -L "$cert" ]] && members+=("${cert#/}")

  local registry
  registry="$(dmp_site_registry_entry "$domain")"
  if [[ -f "$registry" && "$(sed -n 1p "$registry")" == "$folder" && "$(sed -n 2p "$registry")" == "$(stat -c '%d:%i' "$folder")" ]]; then
    panel_made=1
  fi

  dmp_step "Archiving $domain into $entry"
  install -d -m 0700 "$(dmp_trash_dir)"
  install -d -m 0700 "$entry"
  (umask 077 && tar -czf "$entry/site.tar.gz" --one-file-system -C "$WEB_DIR" "${folder##*/}") || { rm -rf -- "$entry"; dmp_die "could not archive $folder"; }
  (umask 077 && tar -czf "$entry/config.tar.gz" -C / "${members[@]}") || { rm -rf -- "$entry"; dmp_die "could not archive the vhost and certificate"; }
  if [[ -f "$dump" && ! -L "$dump" ]]; then
    [[ "$(stat -c %U "$dump")" == "$PANEL_USER" ]] || { rm -rf -- "$entry"; dmp_die "$dump is not the panel user's export"; }
    mv -- "$dump" "$entry/db.sql.gz"
  fi

  local names=() name
  while IFS= read -r name; do
    dmp_is_local_name "$name" && names+=("$name")
  done < <(dmp_vhost_names "${vhosts[0]}")
  {
    printf 'DOMAIN=%s\n' "$domain"
    printf 'STAMP=%s\n' "$stamp"
    printf 'DELETED_AT=%s\n' "$(date +%s)"
    printf 'REASON=%s\n' "$reason"
    printf 'FOLDER=%s\n' "$folder"
    printf 'PANEL_MADE=%s\n' "$panel_made"
    printf 'DB_NAME=%s\n' "$db_name"
    printf 'DB_USER=%s\n' "$db_user"
    printf 'NAMES=%s\n' "${names[*]}"
    printf 'VHOSTS=%s\n' "${apache[*]##*/}"
    printf 'ENABLED=%s\n' "${enabled[*]}"
    printf 'NGINX=%s\n' "$nginx"
    printf 'NGINX_ENABLED=%s\n' "$nginx_enabled"
  } > "$entry/manifest.env"
  (cd "$entry" && sha256sum -- *.gz > SHA256SUMS)
  chmod 0600 "$entry"/*
  dmp_trash_verify "$entry"
  printf 'SIZE=%s\n' "$(du -sb "$entry" | cut -f1)" >> "$entry/manifest.env"
  dmp_ok "archived $domain: $entry"
}

# trash-remove <domain> <stamp>: removes the site, only when its archive checks out.
dmp_trash_remove() {
  local domain="$1" stamp="$2" entry folder cert f nginx=0
  [[ "$stamp" =~ $DMP_TRASH_STAMP ]] || dmp_usage_error "not a stamp: '$stamp'"
  entry="$(dmp_trash_dir)/$domain-$stamp"
  [[ -d "$entry" ]] || dmp_die "no archive of $domain at $entry; archive it first"
  [[ "$(dmp_trash_get "$entry/manifest.env" DOMAIN)" == "$domain" ]] || dmp_die "$entry is not an archive of $domain"
  dmp_trash_verify "$entry"

  folder="$(dmp_trash_folder "$entry/manifest.env" "$domain")"
  cert="$(dmp_cert_dir "$domain")"
  dmp_step "Removing $domain (archived in $entry)"
  while IFS= read -r f; do
    if dmp_trash_is_nginx "$f"; then
      rm -f -- "$NGINX_SITES_ENABLED/${f##*/}"
      nginx=1
    else
      a2dissite -q "${f##*/}" >/dev/null 2>&1 || true
    fi
    rm -f -- "$f"
  done < <(dmp_trash_vhost_files "$domain")
  [[ -d "$cert" && ! -L "$cert" ]] && rm -rf -- "$cert"
  dmp_hosts_rewrite "$domain"
  if [[ -d "$folder" && ! -L "$folder" ]]; then
    rm -rf --one-file-system -- "$folder"
  fi
  rm -f -- "$(dmp_site_registry_entry "$domain")"
  dmp_apache_reload
  if (( nginx )); then
    dmp_nginx_php_write || dmp_warn "nginx -t fails after taking $domain out"
    dmp_nginx_reload_if_active
  fi
  dmp_ok "removed $domain; restore it from Deleted sites until it is purged"
}

# trash-list: one tab-separated line per entry: id, domain, deleted-at, size,
# panel-made, database, reason (deleted for archives older than reasons), and
# 1 when it holds the database export.
dmp_trash_list() {
  local entry manifest reason dump
  for entry in "$(dmp_trash_dir)"/*/; do
    manifest="$entry/manifest.env"
    [[ -f "$manifest" ]] || continue
    entry="${entry%/}"
    reason="$(dmp_trash_get "$manifest" REASON)"
    dump=0
    [[ -f "$entry/db.sql.gz" ]] && dump=1
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${entry##*/}" \
      "$(dmp_trash_get "$manifest" DOMAIN)" "$(dmp_trash_get "$manifest" DELETED_AT)" "$(dmp_trash_get "$manifest" SIZE)" \
      "$(dmp_trash_get "$manifest" PANEL_MADE)" "$(dmp_trash_get "$manifest" DB_NAME)" "${reason:-deleted}" "$dump"
  done
  return 0
}

dmp_trash_delete() {
  local id="$1" entry
  dmp_trash_require_id "$id"
  entry="$(dmp_trash_dir)/$id"
  [[ -d "$entry" && ! -L "$entry" ]] || dmp_die "no trash entry $id"
  rm -rf -- "$entry"
  dmp_ok "deleted $id for good"
}

# trash-purge <days>: deletes entries older than that.
dmp_trash_purge() {
  local days="$1" entry deleted now count=0
  if [[ ! "$days" =~ ^[0-9]{1,3}$ ]] || (( days < 1 )); then
    dmp_usage_error "days must be 1 to 999"
  fi
  now="$(date +%s)"
  for entry in "$(dmp_trash_dir)"/*/; do
    entry="${entry%/}"
    [[ -f "$entry/manifest.env" ]] || continue
    deleted="$(dmp_trash_get "$entry/manifest.env" DELETED_AT)"
    [[ "$deleted" =~ ^[0-9]+$ ]] || continue
    if (( now - deleted > days * 86400 )); then
      rm -rf -- "$entry"
      count=$((count + 1))
    fi
  done
  dmp_ok "purged $count deleted site(s) older than $days days"
}

# trash-dump <id>: a copy of a deleted site's database dump for the panel, to
# install another site from it. The archive stays as it is. Prints the copy.
dmp_trash_dump() {
  local id="$1" entry domain out
  dmp_trash_require_id "$id"
  entry="$(dmp_trash_dir)/$id"
  [[ -d "$entry" ]] || dmp_die "no trash entry $id"
  dmp_trash_verify "$entry"
  domain="$(dmp_trash_get "$entry/manifest.env" DOMAIN)"
  dmp_require_local_name "$domain"
  [[ "$id" == "$domain-"* ]] || dmp_die "$id does not belong to $domain"
  [[ -f "$entry/db.sql.gz" && ! -L "$entry/db.sql.gz" ]] || dmp_die "$id holds no database dump"
  out="$BACKUP_DIR/sites/copy-$id.sql.gz"
  install -d -m 0700 -o "$PANEL_USER" -g "$PANEL_GROUP" "$BACKUP_DIR/sites"
  install -m 0600 -o "$PANEL_USER" -g "$PANEL_GROUP" "$entry/db.sql.gz" "$out"
  printf 'DUMP=%s\n' "$out"
  dmp_ok "copied the database dump of $id for the panel"
}

# trash-restore <id>: puts a site back when nothing of it exists again. Prints
# the database dump it left for the panel to import, if any.
dmp_trash_restore() {
  local id="$1" entry manifest domain folder cert f member nginx nginx_enabled
  dmp_trash_require_id "$id"
  entry="$(dmp_trash_dir)/$id"
  manifest="$entry/manifest.env"
  [[ -d "$entry" ]] || dmp_die "no trash entry $id"
  dmp_trash_verify "$entry"
  domain="$(dmp_trash_get "$manifest" DOMAIN)"
  dmp_require_local_name "$domain"
  [[ "$id" == "$domain-"* ]] || dmp_die "$id does not belong to $domain"
  folder="$(dmp_trash_folder "$manifest" "$domain")"
  cert="$(dmp_cert_dir "$domain")"
  nginx="$(dmp_trash_get "$manifest" NGINX)"
  nginx_enabled="$(dmp_trash_get "$manifest" NGINX_ENABLED)"
  [[ -z "$nginx" || "$nginx" == "$domain.conf" ]] || dmp_die "$id names an nginx file of another site: $nginx"
  [[ -z "$nginx_enabled" || "$nginx_enabled" == "$domain.conf" ]] || dmp_die "$id names an nginx file of another site: $nginx_enabled"
  if [[ -n "$nginx" ]] && ! dmp_nginx_is_setup; then
    dmp_die "$domain ran on nginx; set nginx up next to Apache first (dmp-root nginx-setup)"
  fi

  # Installed again since? Then nothing is restored over it.
  local -a taken=()
  [[ -e "$folder" ]] && taken+=("folder $folder")
  [[ -e "$cert" ]] && taken+=("certificate $cert")
  for f in $(dmp_trash_get "$manifest" VHOSTS); do
    [[ -e "$APACHE_SITES_AVAILABLE/$f" ]] && taken+=("vhost $APACHE_SITES_AVAILABLE/$f")
  done
  [[ -n "$nginx" && -e "$NGINX_SITES_AVAILABLE/$nginx" ]] && taken+=("nginx site $NGINX_SITES_AVAILABLE/$nginx")
  (( ${#taken[@]} == 0 )) || dmp_die "$domain exists again ($(IFS=,; printf '%s' "${taken[*]}")); remove that first"

  # The config archive may only hold this site's vhosts and certificate.
  while IFS= read -r member; do
    case "/$member" in
      "$APACHE_SITES_AVAILABLE/$domain-ssl.conf" | "$APACHE_SITES_AVAILABLE/$domain.conf" | "$NGINX_SITES_AVAILABLE/$domain.conf" | "$cert" | "$cert/" | "$cert/"*) ;;
      *) dmp_die "unexpected file in the archive: $member" ;;
    esac
  done < <(tar -tzf "$entry/config.tar.gz")

  # The site archive holds the site's folder and nothing beside it.
  local top
  top="$(tar -tzf "$entry/site.tar.gz" | cut -d/ -f1 | sort -u)"
  [[ "$top" == "${folder##*/}" ]] || dmp_die "the site archive of $id holds more than ${folder##*/}"

  dmp_step "Restoring $domain from $id"
  tar -xzf "$entry/site.tar.gz" -C "$WEB_DIR" --same-owner -p || dmp_die "could not unpack the site folder"
  tar -xzf "$entry/config.tar.gz" -C / --same-owner -p || { rm -rf -- "$folder"; dmp_die "could not unpack the vhost and certificate"; }
  for f in $(dmp_trash_get "$manifest" ENABLED); do
    a2ensite -q "$f" >/dev/null || dmp_warn "a2ensite $f failed"
  done
  # Before the hosts line, which follows where the site runs.
  [[ -z "$nginx_enabled" ]] || ln -sfn "$NGINX_SITES_AVAILABLE/$nginx_enabled" "$NGINX_SITES_ENABLED/$nginx_enabled"
  local -a names=()
  read -r -a names <<< "$(dmp_trash_get "$manifest" NAMES)"
  for f in "${names[@]}"; do dmp_require_local_name "$f"; done
  (( ${#names[@]} > 0 )) && dmp_hosts_add "$domain" "${names[@]}"
  if [[ "$(dmp_trash_get "$manifest" PANEL_MADE)" == 1 ]]; then
    dmp_site_register "$domain" "$folder"
  fi

  if ! dmp_apache_configtest || ! dmp_nginx_php_write; then
    for f in $(dmp_trash_get "$manifest" VHOSTS); do
      a2dissite -q "$f" >/dev/null 2>&1 || true
      rm -f -- "$APACHE_SITES_AVAILABLE/$f"
    done
    if [[ -n "$nginx" ]]; then
      rm -f -- "$NGINX_SITES_ENABLED/$nginx" "$NGINX_SITES_AVAILABLE/$nginx"
      dmp_nginx_php_write >/dev/null 2>&1 || true
    fi
    rm -rf -- "$cert" "$folder"
    rm -f -- "$(dmp_site_registry_entry "$domain")"
    dmp_hosts_rewrite "$domain"
    dmp_die "Apache or nginx refused the restored site; nothing was restored"
  fi
  systemctl reload apache2 || dmp_die "apache reload failed"
  [[ -z "$nginx" ]] || dmp_nginx_reload_if_active

  if [[ -f "$entry/db.sql.gz" ]]; then
    local out="$BACKUP_DIR/sites/restore-$id.sql.gz"
    install -d -m 0700 -o "$PANEL_USER" -g "$PANEL_GROUP" "$BACKUP_DIR/sites"
    install -m 0600 -o "$PANEL_USER" -g "$PANEL_GROUP" "$entry/db.sql.gz" "$out"
    printf 'DUMP=%s\n' "$out"
  fi
  dmp_ok "restored $domain; the trash entry stays until the database is back"
}
