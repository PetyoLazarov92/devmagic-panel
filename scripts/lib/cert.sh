# shellcheck shell=bash
# Site certificates signed by the local CA. Based on devmagic
# includes/mkcert.sh: the SAN list now comes from the caller instead of
# being hardcoded, and new files replace old ones only after signing works.

dmp_cert_dir() { printf '%s/%s' "$CERTS_DIR" "$1"; }
dmp_cert_file() { printf '%s/%s/%s.crt' "$CERTS_DIR" "$1" "$1"; }
dmp_cert_key_file() { printf '%s/%s/%s.key' "$CERTS_DIR" "$1" "$1"; }

# Usage: dmp_cert_issue <domain> [alias...]
dmp_cert_issue() {
  local domain="$1"
  shift
  local -a names
  mapfile -t names < <(dmp_unique_aliases "$domain" "$@")
  names=("$domain" "${names[@]}")

  dmp_ca_exists || dmp_die "no CA yet, run: dmp-root ca-create"
  dmp_step "Issuing certificate for $domain (${#names[@]} names)"

  local dir work ext i
  dir="$(dmp_cert_dir "$domain")"
  install -d -m 0755 "$dir"
  work="$(mktemp -d "$dir/.issue.XXXXXX")"
  _cert_fail() { rm -rf "$work"; dmp_die "$1"; }

  ext="$work/san.ext"
  {
    printf 'authorityKeyIdentifier=keyid,issuer\n'
    printf 'basicConstraints=CA:FALSE\n'
    printf 'keyUsage=digitalSignature,keyEncipherment\n'
    printf 'extendedKeyUsage=serverAuth\n'
    printf 'subjectAltName=@alt_names\n\n[alt_names]\n'
    for i in "${!names[@]}"; do
      printf 'DNS.%d = %s\n' "$((i + 1))" "${names[$i]}"
    done
  } > "$ext"

  openssl genrsa -out "$work/site.key" 2048 2>/dev/null || _cert_fail "could not generate the key for $domain"
  openssl req -new -key "$work/site.key" -out "$work/site.csr" \
    -subj "/O=devmagic-panel/CN=$domain" || _cert_fail "could not create the signing request for $domain"
  openssl x509 -req -in "$work/site.csr" -CA "$(dmp_ca_cert)" -CAkey "$(dmp_ca_key)" \
    -CAcreateserial -CAserial "$CA_DIR/ca.srl" -out "$work/site.crt" \
    -days 825 -sha256 -extfile "$ext" 2>/dev/null || _cert_fail "could not sign the certificate for $domain"

  chmod 0600 "$work/site.key"
  chmod 0644 "$work/site.crt"
  mv "$work/site.key" "$(dmp_cert_key_file "$domain")"
  mv "$work/site.crt" "$(dmp_cert_file "$domain")"
  rm -rf "$work"
  dmp_ok "certificate written: $(dmp_cert_file "$domain")"
  printf '   names: %s\n' "${names[*]}"
}

# Removes a site's cert folder, but never while a vhost still uses it.
dmp_cert_remove() {
  local domain="$1" dir file
  dir="$(dmp_cert_dir "$domain")"
  if [[ ! -e "$dir" ]]; then
    dmp_ok "no certificate for $domain"
    return 0
  fi
  [[ -d "$dir" && ! -L "$dir" ]] || dmp_die "$dir is not a plain folder, leaving it as is"
  for file in "$APACHE_SITES_AVAILABLE"/*.conf "$APACHE_SITES_ENABLED"/*.conf; do
    [[ -f "$file" ]] || continue
    if grep -qF "$(dmp_cert_file "$domain")" "$file"; then
      dmp_die "$file still uses this certificate; remove the vhost first"
    fi
  done
  rm -rf -- "$dir"
  dmp_ok "certificate removed for $domain"
}

# Prints every ServerName and ServerAlias in a vhost file, one per line,
# in file order and without duplicates.
dmp_vhost_names() {
  local file="$1"
  awk 'tolower($1) == "servername" || tolower($1) == "serveralias" {
         for (i = 2; i <= NF; i++) if (!seen[$i]++) print $i
       }' "$file"
}

# Reissues the cert of an existing site from the new CA, using every name in
# its vhost (port 80 and 443 blocks), so the cert covers all of them.
dmp_cert_reissue_from_vhost() {
  local domain="$1" file name
  file="$APACHE_SITES_AVAILABLE/$domain-ssl.conf"
  [[ -f "$file" ]] || dmp_die "vhost not found: $file"
  grep -qF "$(dmp_cert_file "$domain")" "$file" \
    || dmp_die "$file does not use $(dmp_cert_file "$domain"), refusing to issue a cert it would not load"

  local -a names=()
  while IFS= read -r name; do
    if dmp_is_local_name "$name"; then
      [[ "$name" != "$domain" ]] && names+=("$name")
    else
      dmp_warn "skipping non-local name in $file: $name"
    fi
  done < <(dmp_vhost_names "$file")

  dmp_cert_issue "$domain" "${names[@]}"
}
