# Installation and uninstall

[Docs](README.md) › Installation and uninstall

The commands to install are in the [README](../README.md#-installation). This
page has the details.

## Where the package comes from

The panel installs from its releases: a package with the built panel, its
runtime dependencies, the root scripts and the installer, about 11 MB, built
and checked by GitHub for every version tag. Nothing is built on your machine.

`get.sh` finds the newest release (or the one you give with `--version
v0.7.0`), gets `devmagic-panel-<version>.tar.gz` and its checksum, checks it,
and runs that release's `install.sh`. It tries public HTTPS, the GitHub CLI and
git over SSH, the same ways as the command you started it with. Cloned from
`pkg/latest`, it installs the package next to it with no download. A fork or a
moved repository works with `--repo owner/name`.

Run from a git checkout, the installer builds the commit you have checked out
into a release in a temporary folder, the way GitHub does (`npm run package`),
and installs that: `v0.6.0` at a release tag, `v0.6.0-dev.1a2b3c4` between
releases. Uncommitted changes are not in it, so commit them first. The checkout
is never used by the running panel, so it can change, switch branches or
rebuild freely.

## Installer options

```bash
./install.sh                 # interactive install
./install.sh --dry-run       # print what would change, change nothing
./install.sh --yes           # install what the panel needs, skip the rest
./install.sh --skip-optional # do not offer recommended or optional components
./install.sh --uninstall     # remove the panel; add --dry-run to see what first
```

`--from-panel` is for the panel's Updates page, not for you: it updates an
installed panel with the sudo password on stdin (kept only in the installer's
memory, never in a file, a log or a command line), answers every question with
its default, and runs as one transaction. It keeps the root scripts,
`config.env` and the sudoers rule, swaps the new root scripts in whole, backs up
certs, vhosts and hosts, and once the panel restarts checks it answers with the
new version. When a step fails, everything is put back (the old root scripts,
`config.env`, sudoers rule and backup, and the release before, restarted), and
`~/.local/share/devmagic-panel/update-status.json` says what happened.

## What the installer does

1. Reports what the panel needs, found or missing, before it changes anything,
   and installs what is missing:
   - **Required**, after one question (`--yes` installs them): Apache with PHP
     and the WordPress modules (on a new machine through PHP-FPM, with the
     panel's handler sending every site's PHP to it and Apache on mpm_event; a
     machine with mod_php keeps it until you switch on the PHP tab), MySQL
     (MariaDB on Debian; one already there stays), OpenSSL, `libnss3-tools`,
     curl, git, unzip, WP-CLI and Node.js 22.13+. Without Node, it offers the
     official Node.js 22 build from nodejs.org, checked against its checksums,
     in `~/.local/share/devmagic-panel/node` for the panel only, so switching
     nvm versions never breaks the panel. No to a required part stops the
     install and prints the apt command.
   - **Recommended**, asked with yes as the default: Composer, Imagick, Mailpit
     (the panel's own copy, as on the Services page) and, where mod_php runs,
     PHP-FPM so a site can have its own PHP.
   - **Optional**, asked with no as the default: Xdebug, phpMyAdmin and nginx.
     nginx is installed in an apt-get of its own once Apache holds port 80 (so
     the package leaves it stopped), then set up next to Apache (step 10). An
     nginx already installed is offered the setup only.
   - **For installs from an organization**, one question, no by default: the
     GitHub CLI, rclone and Claude Code. Signing in to them stays yours; the
     installer prints how. The GitLab CLI, needed only for GitLab groups, is
     reported with where to get it and never installed in that group.
   - It warns about PHP older than 8.1, and with `--yes` about an nginx that is
     installed but not set up. `--yes` and `--skip-optional` skip all but the
     required parts.
2. Writes `/etc/devmagic-panel/config.env` with the detected paths.
3. Puts the release in `~/.local/share/devmagic-panel/releases/<version>`: as
   it is, or built from the checkout.
4. Installs the root scripts (from that release) to
   `/usr/local/lib/devmagic-panel` and a sudoers rule that allows only
   `dmp-root` and `wpcore` without a password.
5. **Backs up** `/etc/ssl/localcerts`, the Apache vhosts, nginx's sites when
   nginx is installed, `/etc/hosts` and the system CA folder to
   `~/devmagic-panel-backups/` (readable only by you; it holds private keys).
6. Enables the Apache modules it needs (`ssl`, `rewrite`, `headers`, `proxy`,
   `proxy_http`, `proxy_wstunnel`).
7. Creates a new local CA and trusts it in the system, Chrome, Edge and Firefox
   (Chrome and Edge share one store).
8. Offers to reissue the certs of existing sites from the new CA, covering
   every name in each vhost. The old devmagic `LocalhostCA` stays trusted until
   you remove it from Aura's Machine checks.
9. Sets up `https://local.devmagic` and asks for a panel password and your
   MySQL admin account. When no account you have signs in (on a new MySQL or
   MariaDB, root signs in only through sudo), it can make one for the panel,
   `devmagic_panel@localhost`, with `sudo mysql` and a generated password kept
   only in the panel's secrets file. It also makes `devmagic_panel_ro`, the
   read-only account the SQL runner uses. Then it points
   `~/.local/share/devmagic-panel/current` at the release and starts a systemd
   user service that runs whatever `current` points at. The release before
   stays for switching back (the newest three stay), and a v0.5 install's clone
   in `~/.local/share/devmagic-panel/app` goes. It offers to keep the service
   running after you log out (`loginctl enable-linger`), so a running install
   or import is not cut off.
10. Sets nginx up next to Apache when you said yes to it (`dmp-root
    nginx-setup`): Apache's `ports.conf` moves from every address to
    `127.0.0.1` (the original is kept in `/var/lib/devmagic-panel/nginx`),
    Debian's default nginx site goes off, the panel's settings go in
    `/etc/nginx/conf.d/devmagic-panel.conf`, and nginx answers on `127.0.0.2`.
    Once nginx is set up, every later run writes those settings again.
11. Installs Mailpit when you said yes to it. On a home folder encrypted with
    eCryptfs, which unlocks only when you log in, systemd cannot start your
    user services at boot or login, so it also writes
    `~/.config/autostart/devmagic-panel.desktop`: your desktop then starts the
    panel and Mailpit once you log in. Aura's Machine checks look for it and
    add it in one click.
12. Writes the list of everything it put on the machine to
    `/var/lib/devmagic-panel/installed-files` (root-owned, readable by all):
    each path, what it is, and whether an uninstall removes it, asks, or keeps
    it.

Run it again any time, as `~/.local/share/devmagic-panel/current/install.sh`;
it skips what is already done. Restart your browsers after the first install so
they load the new CA.

Every run is logged to `~/.local/state/devmagic-panel/logs/install-<date>.log`
(the newest 20 stay). Passwords never reach the log: sudo asks on the terminal
itself, and the panel's own questions run outside it.

## Uninstall

```bash
~/.local/share/devmagic-panel/current/install.sh --uninstall --dry-run   # see what goes and what stays
~/.local/share/devmagic-panel/current/install.sh --uninstall
```

`./install.sh --uninstall` in a checkout does the same. It works from the
installer's list of what it put on the machine (or the usual list for installs
older than v0.5.0).

It stops the panel and Mailpit, and turns nginx off when the panel set it up
next to Apache (every site on nginx back to Apache first, then Apache back on
every address, nginx stopped and left installed). It removes the panel's own
site (`local.devmagic`: vhost, certificate, hosts line), the releases and
`current` (and a v0.5 clone in `app`), the Node.js it installed for the panel,
the systemd unit, the login entry on an encrypted home, the panel's block in
your crontab (your own lines stay), the root scripts, the sudoers rule and
`config.env`. Before removing anything it asks about the rest:

| Asked | Default |
| --- | --- |
| The backups in `~/devmagic-panel-backups` | keep |
| `/var/lib/devmagic-panel`: archived sites you can still restore, and the registry | keep |
| The panel's data: settings, saved password, MySQL account, run history, uploads, Mailpit | remove |
| The install logs | remove |
| Lingering, when the installer turned it on | keep |
| Local mode and the login helper in your sites (without Local mode a site can email real people) | keep |
| The panel's local CA and its trust in the system and your browsers | remove when no site certificate is signed with it; keep when one is |

For the CA it checks every certificate in `/etc/ssl/localcerts` and lists the
sites signed with the panel's CA: removing it would break https for them until
their certificates are reissued, so then it stays unless you say otherwise, and
the uninstaller prints how to remove it by hand later. Certificates from
another CA, like devmagic's `LocalhostCA`, and that CA itself, are never
touched.

Neither are your sites, their databases and certificates, the wpcore cores and
`/etc/wpcore.conf`, the packages it installed (WP-CLI, Apache, PHP, MySQL and
the rest), a MySQL account it made for the panel, and a `wpcore` command of
your own. A checkout you installed from stays too. `--yes` takes the defaults
without asking.
