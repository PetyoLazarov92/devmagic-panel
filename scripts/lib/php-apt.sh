# shellcheck shell=bash
# PHP versions and their module packages from apt: only packages named
# php<version>-<name>, only from the sources apt already has (adding the PPA
# is left to a person, with a password), never a purge: /etc/php/<version>
# stays, so its settings come back with a reinstall.

# What a version gets: FPM, the command line, and the modules WordPress needs or uses.
DMP_PHP_BASE_PACKAGES=(fpm cli mysql xml mbstring curl zip gd intl bcmath imagick)
# The packages a version cannot do without: never removed one by one.
DMP_PHP_CORE_PACKAGES=(common cli fpm mysql xml)

dmp_apt() {
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -y -q \
    -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

# True when apt can install a package from the sources it has.
dmp_apt_candidate() {
  local candidate
  candidate="$(apt-cache policy "$1" 2>/dev/null | sed -n 's/^ *Candidate: *//p' | head -n 1)"
  [[ -n "$candidate" && "$candidate" != "(none)" ]]
}

# The php<version>-* packages installed, one per line.
dmp_php_installed_packages() {
  dpkg-query -W -f='${binary:Package} ${db:Status-Abbrev}\n' "php$1-*" "libapache2-mod-php$1" 2>/dev/null \
    | awk '$2 ~ /^ii/ { sub(/:.*/, "", $1); print $1 }'
  return 0
}

# The version `php` on the command line is, from where its alternative points (/usr/bin/php8.3).
dmp_php_cli_version() {
  local cli
  cli="$(readlink -f "$(command -v php 2>/dev/null || true)" 2>/dev/null || true)"
  [[ "$cli" =~ /php([0-9]\.[0-9])$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

# Points php (and phar, phar.phar) on the command line at a version's binaries.
dmp_php_cli_set() {
  local version="$1" name bin
  for name in php phar phar.phar; do
    bin="$(command -v "$name$version" 2>/dev/null || true)"
    [[ -n "$bin" ]] || continue
    update-alternatives --set "$name" "$bin" >/dev/null || dmp_die "update-alternatives could not point $name at $bin"
  done
}

# php-cli <version>: php on the command line (WP-CLI and Composer run on it) becomes that version.
dmp_php_cli() {
  local version="$1"
  dmp_php_version_arg "$version"
  dmp_php_require_installed "$version"
  if ! dmp_php_has_sapi "$version" cli || ! command -v "php$version" >/dev/null; then
    dmp_die "PHP $version has no command line: apt install php$version-cli"
  fi
  dmp_php_cli_set "$version"
  dmp_ok "php on the command line is PHP $version"
}

# The packages a simulated apt-get run (apt-get -s on stdin) would bring in
# that belong to another PHP version or are mod_php, one line: new installs
# only, since an update of a package already installed (php8.3-imagick from
# the PPA) brings in nothing.
dmp_php_apt_new_other() {
  awk '$1 == "Inst" && $3 !~ /^\[/ { print $2 }' \
    | grep -E '^(php[0-9]\.[0-9]+(-|$)|libapache2-mod-php)' | grep -vE "^$1(-|$)" | paste -sd' ' - || true
}

# Runs apt-get -s first (nothing changes) and stops when the real run would
# bring in another PHP or mod_php, or take out more than PHP packages. Packages
# without a version (php, libapache2-mod-php, php-xdebug) follow the newest PHP
# the apt sources have, so an update of php-common can pull a whole other
# version in. The advice names the ones that can go: never php-common, which
# every php<version>-common needs, nor one another package needs (phpMyAdmin
# needs php-mysql and php-xml).
# Usage: dmp_php_apt_check <version> install|remove <apt-get arguments...>
dmp_php_apt_check() {
  local version="$1" how="$2" out extra auto still pkg gone own="php${1//./\\.}"
  local -a pulled=() removable=() kept=()
  shift 2
  out="$(DEBIAN_FRONTEND=noninteractive apt-get -s -q "$@" 2>&1)" || { printf '%s\n' "$out" >&2; dmp_die "apt-get refuses this: see above"; }
  if [[ "$how" == install ]]; then
    extra="$(dmp_php_apt_new_other "$own" <<<"$out")"
    [[ -z "$extra" ]] && return 0
    printf 'apt would also install %s.\n' "$extra" >&2
    mapfile -t pulled < <(awk '$1 == "Inst" && $3 ~ /^\[/ { print $2 }' <<<"$out" \
      | grep -E '^(php|libapache2-mod-php|php-[a-z0-9.+-]+)$' | grep -vx 'php-common' || true)
    # One at a time, each tried with the ones before it and the install itself:
    # a package goes only when apt then takes out nothing else.
    for pkg in "${pulled[@]}"; do
      gone="$(DEBIAN_FRONTEND=noninteractive apt-get -s -q "$@" "${removable[@]/%/-}" "$pkg-" 2>/dev/null \
        | awk '$1 == "Remv" { print $2 }' | grep -vxF -e "$pkg" "${removable[@]/#/-e}" | paste -sd' ' - || true)"
      if [[ -z "$gone" ]]; then removable+=("$pkg"); else kept+=("$pkg"); fi
    done
    (( ${#pulled[@]} == 0 )) || printf 'They come with an update of %s: packages without a version follow the newest PHP your apt sources have.\n' "${pulled[*]}" >&2
    (( ${#kept[@]} == 0 )) || printf 'Keep %s, which other packages need.\n' "${kept[*]}" >&2
    if (( ${#removable[@]} )); then
      still="$(DEBIAN_FRONTEND=noninteractive apt-get -s -q "$@" "${removable[@]/%/-}" 2>/dev/null | dmp_php_apt_new_other "$own")"
      auto="$(apt-mark showauto 2>/dev/null | grep -E '^(php[0-9]\.[0-9]+(-|$)|libapache2-mod-php[0-9])' | grep -vE "^$own-" | paste -sd' ' - || true)"
      printf 'On a terminal, keep the PHP packages you have and remove the ones nothing else needs, then try again:\n' >&2
      [[ -z "$auto" ]] || printf '  sudo apt-mark manual %s\n' "$auto" >&2
      printf '  sudo apt-get remove %s\n' "${removable[*]}" >&2
      [[ -z "$still" ]] || printf 'Even then apt would install %s: check what apt lists for this on a terminal.\n' "$still" >&2
    fi
    dmp_die "not installing: it would bring in another PHP version or mod_php"
  fi
  extra="$(awk '$1 == "Remv" { print $2 }' <<<"$out" | grep -vE "^($own(-|$)|libapache2-mod-$own$|php(-[a-z0-9.+-]+)?$)" | paste -sd' ' - || true)"
  [[ -z "$extra" ]] || dmp_die "not removing: apt would also take out $extra"
}

# What stops a version from going: mod_php runs it, it is the command line's php, or a site's pool runs it.
dmp_php_in_use() {
  local version="$1" cli sites
  if [[ "$(dmp_php_apache_version || true)" == "$version" ]]; then
    printf 'Apache runs PHP %s as mod_php' "$version"
    return 0
  fi
  if [[ "$(dmp_php_default || true)" == "$version" ]]; then
    printf 'every site without a PHP of its own runs on PHP %s through PHP-FPM' "$version"
    return 0
  fi
  cli="$(readlink -f "$(command -v php 2>/dev/null || true)" 2>/dev/null || true)"
  if [[ "$cli" == */php"$version" ]]; then
    printf 'php on the command line is PHP %s' "$version"
    return 0
  fi
  sites="$(dmp_pools | awk -v v="$version" '$1 == v { print $2 }' | paste -sd, -)"
  if [[ -n "$sites" ]]; then
    printf 'these sites run on it: %s' "${sites//,/, }"
    return 0
  fi
  return 1
}

# php-install <version>: a version with FPM, the command line and the common modules.
dmp_php_install() {
  local version="$1" name cli
  local -a pkgs=() skipped=()
  dmp_php_version_arg "$version"
  dmp_apt_candidate "php$version-fpm" || dmp_die "PHP $version is not in your apt sources: add the PPA from the PHP tab first"
  for name in "${DMP_PHP_BASE_PACKAGES[@]}"; do
    if dmp_apt_candidate "php$version-$name"; then pkgs+=("php$version-$name"); else skipped+=("php$version-$name"); fi
  done
  dmp_php_apt_check "$version" install install "${pkgs[@]}"
  cli="$(dmp_php_cli_version || true)"
  dmp_step "Installing ${pkgs[*]}"
  dmp_apt install "${pkgs[@]}" || dmp_die "apt-get could not install PHP $version"
  # apt points php at the newest version it has; the command line stays where it was.
  if [[ -n "$cli" && "$(dmp_php_cli_version || true)" != "$cli" ]]; then
    dmp_php_cli_set "$cli"
    dmp_ok "php on the command line stays PHP $cli"
  fi
  (( ${#skipped[@]} == 0 )) || dmp_warn "not in your apt sources, left out: ${skipped[*]}"
  dmp_php_conf_write || dmp_warn "Apache's configtest failed after installing PHP $version"
  dmp_ok "PHP $version installed with ${pkgs[*]}"
}

# php-package <version> <name> <install|remove>: one php<version>-<name> package.
dmp_php_package() {
  local version="$1" name="$2" how="$3" pkg
  dmp_php_version_arg "$version"
  [[ "$name" =~ ^[a-z0-9][a-z0-9.+-]{1,30}$ ]] || dmp_usage_error "not a PHP package name: $name"
  dmp_in_list "$how" install remove || dmp_usage_error "php-package takes install or remove, not: $how"
  pkg="php$version-$name"
  dmp_php_require_installed "$version"
  if [[ "$how" == install ]]; then
    dmp_apt_candidate "$pkg" || dmp_die "$pkg is not in your apt sources"
    dmp_php_apt_check "$version" install install "$pkg"
    dmp_apt install "$pkg" || dmp_die "apt-get could not install $pkg"
  else
    ! dmp_in_list "$name" "${DMP_PHP_CORE_PACKAGES[@]}" || dmp_usage_error "PHP $version cannot do without $pkg; remove the whole version instead"
    dmp_php_apt_check "$version" remove remove "$pkg"
    dmp_apt remove "$pkg" || dmp_die "apt-get could not remove $pkg"
  fi
  dmp_php_apply "$version"
  dmp_ok "$pkg ${how}ed"
}

# php-upgrade <version>: the newest build apt has of every php<version> package installed.
dmp_php_upgrade() {
  local version="$1"
  local -a pkgs
  dmp_php_version_arg "$version"
  mapfile -t pkgs < <(dmp_php_installed_packages "$version")
  (( ${#pkgs[@]} > 0 )) || dmp_die "no package of PHP $version is installed"
  dmp_php_apt_check "$version" install install --only-upgrade "${pkgs[@]}"
  dmp_step "Updating ${pkgs[*]}"
  dmp_apt install --only-upgrade "${pkgs[@]}" || dmp_die "apt-get could not update PHP $version"
  dmp_php_apply "$version"
  dmp_ok "PHP $version is on the newest build apt has"
}

# php-remove <version>: every php<version> package goes, /etc/php/<version> stays.
# Refused while Apache, the command line or a site's pool uses it.
dmp_php_remove() {
  local version="$1" why
  local -a pkgs auto
  dmp_php_version_arg "$version"
  if why="$(dmp_php_in_use "$version")"; then
    dmp_die "PHP $version stays: $why"
  fi
  mapfile -t pkgs < <(dmp_php_installed_packages "$version")
  (( ${#pkgs[@]} > 0 )) || dmp_die "no package of PHP $version is installed"
  dmp_php_apt_check "$version" remove remove "${pkgs[@]}"
  # The other versions' packages apt counts as pulled in by a php-* package that goes
  # with this version (php-imagick and the like) would be left for autoremove.
  mapfile -t auto < <(apt-mark showauto 2>/dev/null | grep -E '^php[0-9]\.[0-9]+-' | grep -vE "^php${version//./\\.}-" || true)
  (( ${#auto[@]} == 0 )) || apt-mark manual "${auto[@]}" >/dev/null || dmp_warn "apt-mark could not keep ${auto[*]}"
  dmp_step "Removing ${pkgs[*]}"
  dmp_apt remove "${pkgs[@]}" || dmp_die "apt-get could not remove PHP $version"
  dmp_php_conf_write || dmp_warn "Apache's configtest failed after removing PHP $version"
  dmp_ok "PHP $version removed; its settings stay in $PHP_CONF_DIR/$version for a reinstall"
}
