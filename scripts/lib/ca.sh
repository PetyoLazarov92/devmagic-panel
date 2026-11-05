# shellcheck shell=bash
# Local certificate authority. Based on devmagic includes/mkcertissuer.sh,
# changed so the key has no shared passphrase (it is root-only instead) and
# creation never overwrites an existing CA.

DMP_CA_KEY_NAME="ca.key"
DMP_CA_CERT_NAME="ca.pem"
DMP_SYSTEM_CA_NAME="devmagic-panel-ca.crt"
DMP_LEGACY_CA_NAME="LocalhostCA.crt"

dmp_ca_key() { printf '%s/%s' "$CA_DIR" "$DMP_CA_KEY_NAME"; }
dmp_ca_cert() { printf '%s/%s' "$CA_DIR" "$DMP_CA_CERT_NAME"; }

dmp_ca_exists() { [[ -f "$(dmp_ca_key)" && -f "$(dmp_ca_cert)" ]]; }

dmp_ca_create() {
  if dmp_ca_exists; then
    dmp_ok "CA already exists: $(dmp_ca_cert)"
    return 0
  fi
  dmp_step "Creating local CA in $CA_DIR"
  install -d -m 0755 "$CA_DIR"

  local tmp_key tmp_cert host
  host="$(hostname -s 2>/dev/null || echo localhost)"
  tmp_key="$(mktemp "$CA_DIR/.ca-key.XXXXXX")"
  tmp_cert="$(mktemp "$CA_DIR/.ca-cert.XXXXXX")"
  chmod 0600 "$tmp_key"

  openssl genrsa -out "$tmp_key" 3072 2>/dev/null || dmp_die "could not generate the CA key"
  openssl req -x509 -new -key "$tmp_key" -sha256 -days 3650 -out "$tmp_cert" \
    -subj "/O=devmagic-panel/CN=devmagic-panel Local CA ($host)" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" || dmp_die "could not create the CA certificate"

  chmod 0644 "$tmp_cert"
  mv "$tmp_key" "$(dmp_ca_key)"
  mv "$tmp_cert" "$(dmp_ca_cert)"
  dmp_ok "CA created: $(dmp_ca_cert)"
}

dmp_ca_trust() {
  dmp_ca_exists || dmp_die "no CA yet, run: dmp-root ca-create"
  dmp_step "Adding the CA to the system trust store"
  install -d -m 0755 "$SYSTEM_CA_DIR"
  install -m 0644 "$(dmp_ca_cert)" "$SYSTEM_CA_DIR/$DMP_SYSTEM_CA_NAME"
  update-ca-certificates >/dev/null || dmp_die "update-ca-certificates failed"
  dmp_ok "CA trusted by the system"
}

# Removes the old devmagic LocalhostCA from the system store. Its files in
# the old cert-issuer folder stay, and the backup keeps a copy.
dmp_ca_untrust_legacy() {
  local legacy="$SYSTEM_CA_DIR/$DMP_LEGACY_CA_NAME"
  if [[ ! -f "$legacy" ]]; then
    dmp_ok "legacy LocalhostCA is not in the system store"
    return 0
  fi
  dmp_step "Removing the legacy LocalhostCA from the system trust store"
  rm -f "$legacy"
  update-ca-certificates --fresh >/dev/null || dmp_die "update-ca-certificates failed"
  dmp_ok "legacy LocalhostCA removed from the system store"
}
