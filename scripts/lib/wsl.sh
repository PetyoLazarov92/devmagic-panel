# shellcheck shell=bash
# Under WSL 2. WSL registers its interop with Windows programs in the kernel's
# binfmt_misc, which every distro of the WSL VM shares. Its own systemd unit
# for binfmt takes that registration out and puts it in again whenever a
# distro starts, and a distro that was already running can be left without
# it: Windows programs then fail with "Exec format error" until that distro
# restarts. wsl-interop puts it back, with the line WSL itself writes.

# The registration WSL writes: MZ (the start of every Windows program) runs
# through WSL's init, which hands it to Windows. P keeps argv[0] as typed.
dmp_wsl_interop_line() { printf ':WSLInterop:M::MZ::%s:P' "$WSL_INIT"; }

dmp_wsl_interop_registered() {
  local entry
  for entry in "$BINFMT_DIR"/WSLInterop*; do
    [[ -e "$entry" ]] && return 0
  done
  return 1
}

# wsl-interop: interop with Windows registered again when it is gone. Under
# WSL only (its init and binfmt_misc's register file are there); run again,
# it changes nothing.
dmp_wsl_interop() {
  [[ -x "$WSL_INIT" && -e "$BINFMT_DIR/register" ]] || dmp_die "this is not WSL: no $WSL_INIT, or no $BINFMT_DIR/register"
  if dmp_wsl_interop_registered; then
    dmp_ok "interop with Windows programs is registered already"
    return 0
  fi
  dmp_step "Registering interop with Windows programs again"
  dmp_wsl_interop_line > "$BINFMT_DIR/register" || dmp_die "could not write $BINFMT_DIR/register"
  if dmp_wsl_interop_registered; then
    dmp_ok "interop with Windows programs is registered again"
  else
    dmp_warn "the kernel did not list it after registering: restart the distro (wsl --terminate <distro> in Windows)"
  fi
}
