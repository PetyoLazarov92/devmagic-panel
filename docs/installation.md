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
     machine with mod_php keeps it until you switch on the Server and PHP tab), MySQL
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

## Windows (WSL 2)

The panel runs on Windows 10 22H2 and Windows 11 inside Ubuntu under WSL 2,
exactly as on Ubuntu: Apache, PHP, MySQL, the root scripts and your sites all
live in a Linux distro of their own, and Windows browsers reach them through
WSL's localhost forwarding. The Windows setup does all of it from one window.

### Before you start

- **Virtualization.** WSL 2 runs a small virtual machine, which needs the
  processor's virtualization turned on in the computer's firmware. Most new
  computers have it on; check in Task Manager, Performance, CPU:
  "Virtualization: Enabled". When it says Disabled, restart the computer, open
  its BIOS/UEFI setup (the key shows at power-on, often F2, F10, Del or Esc),
  turn on "Intel Virtualization Technology" (VT-x) or "SVM Mode" on AMD, save
  and start Windows. The setup checks this first, before its window opens and
  before it changes anything. When it is off, the setup offers to turn WSL on
  (when that is off too) and restart Windows straight into its BIOS/UEFI setup,
  with one UAC prompt, so one restart does both; after you turn virtualization
  on there and sign in again, the setup starts by itself and goes on. A
  computer that cannot restart into its firmware setup (an older BIOS) gets the
  steps and a normal restart instead. Close the setup instead, and nothing
  changes.
- **WSL.** Nothing to do: when WSL is off, the setup turns it on with
  `wsl --install --no-distribution` (Windows asks with UAC; it turns on the
  "Windows Subsystem for Linux" and "Virtual Machine Platform" features, so you
  never tick them yourself) and Windows needs one restart. The setup offers it,
  and after you sign in again it starts by itself and goes on from where it
  stopped. It asks for your passwords again then: they are never kept.
- About 10 GB free on the drive of your user folder, and a Windows user that
  is an administrator, or the password of one for the UAC questions.

### The setup

Download `devmagic-panel-setup-<version>.exe` from the release on GitHub
(Assets) and run it. It runs as you, not as admin, and:

1. checks Windows, virtualization and WSL, and what is in place already;
2. asks where the panel should run: the `devmagic-panel` distro when it is
   there, a new distro of its own (Ubuntu 24.04, `devmagic-panel` or a name you
   pick), or one of your WSL 2 distros running Ubuntu or Debian. In one of
   yours it turns systemd on (the distro restarts), stops WSL rewriting its
   `/etc/hosts`, keeps Apache on `127.0.0.1` and keeps the distro running; its
   sites and files stay. A repair goes to the distro of the install there;
3. asks for your Linux account (a user name and its password) when the distro
   has none, and for the panel password, or keeps the current one on a repair;
4. for a new distro, imports Ubuntu 24.04 (its download is checked against
   Canonical's SHA-256); makes your Linux user, when the distro has none, as
   Ubuntu's own first start would; and installs the panel in it as on Ubuntu, with a sudo
   rule for the length of the install that it removes again;
5. on Windows: puts its helper in `C:\Program Files\devmagic-panel`, adds a
   logon task that keeps the distro running with no window, trusts the
   panel's local CA for your user (Windows asks you to confirm), and adds
   the panel's names to Windows' hosts file (UAC);
6. checks `https://local.devmagic` answers.

Every step shows under Details in the setup's window, and every run is logged
in `%LOCALAPPDATA%\devmagic-panel\logs`. Run the setup again any time: it
skips what is in place, so it also repairs. Passwords never stay on disk: the
setup hands them over in a file only you can read, deleted as soon as it is
read, and never on a command line.

Updates come from the panel's Updates page, as on Ubuntu; the setup is only
for the first install and repairs. A release that does not change the Windows
part updates the panel only, and Apps and features follows its version by
itself. A release that changes the Windows part too (the helper, the setup,
its shortcuts or uninstall steps) says so on the Updates page, and its Update
runs that release's Windows setup, which installs both in one go: the helper
downloads it from GitHub, checks it against the `.sha256` published with it,
and runs it without a window (Windows may ask with UAC; the panel restarts for
about a minute, and the page reloads once it answers). Machine checks also
show "Windows part" with Update the Windows part whenever Windows has another
release's part than the panel, for example after switching releases. Each
release carries its setup for that, built by the release workflow.

When a new release is out, Windows shows a notification from devmagic-panel
once for it (the panel looks every six hours); it opens the Updates page. You
can turn these off in Windows' Settings, System, Notifications, devmagic-panel.

The setup can also put a shortcut to the panel on the desktop and in Start
("Open devmagic-panel"; WSL adds its own Start entry for the distro, which
opens a terminal there).

### When Windows warns about the setup

The setup is not signed yet, so Windows does not know its publisher. When you
run a copy your browser downloaded, Microsoft Defender SmartScreen may show
"Windows protected your PC" with only Don't run. Click **More info**, check that
the app is `devmagic-panel-setup-<version>.exe` and the publisher reads
Unknown publisher, then click **Run anyway**. Your browser may first ask
whether to keep the download, as it does for programs few people have
downloaded yet: keep it.

To be sure the file is the one the release built, compare its checksum with
`devmagic-panel-setup-<version>.exe.sha256` from the same release, in
PowerShell in your Downloads folder:

```powershell
(Get-FileHash .\devmagic-panel-setup-<version>.exe -Algorithm SHA256).Hash
```

The two must match (the `.sha256` file holds it in lower case). Some computers
give no Run anyway: Windows 11 with Smart App Control on, and computers whose
company allows only approved apps. There the setup cannot run until it is
signed; install by hand instead (below), or ask your administrator.

Updates do not go through this: the panel updates itself from its Updates page,
and Update the Windows part downloads the setup with the helper, checks it
against the release's `.sha256` and runs it, with no SmartScreen question.

### Uninstall

Apps and features, devmagic-panel, Uninstall. It takes the Windows side back
(hosts lines, nginx's relays, the logon task, the CA, the helper) and asks
what to do with the distro, which holds every site and database: keep it (the
default), remove it after exporting a copy to `%LOCALAPPDATA%\devmagic-panel`
(`wsl --import` brings it back), or remove it with no copy. A distro of your
own always stays.

Aura's Machine checks have a WSL on Windows group under WSL 2: whether WSL keeps
`/etc/hosts`, Apache is on `127.0.0.1`, lingering is on, the sites are on the
distro's own disk and Windows programs can be started. Updating the panel, or
running the installer again, puts the first three right.

Good to know: Windows' `curl.exe` needs `--ssl-no-revoke` for the panel's
certificates, which name no revocation server (browsers do not mind). A
Windows without a page file can run out of memory with WSL running, and then
WSL itself stops: keep "Automatically manage paging file size" on (System
Properties, Advanced, Performance, Virtual memory).

### By hand, without the setup

1. In PowerShell, install Ubuntu, or a distro of its own for the panel
   (`--name` needs a recent WSL: `wsl --update` first):

   ```powershell
   wsl --install Ubuntu-24.04
   wsl --install Ubuntu-24.04 --name devmagic-panel
   ```

   Ubuntu's WSL image runs systemd, which the panel needs. Open the distro once
   to make your Linux user.
2. In the distro, install the panel as on Ubuntu, with the commands in the
   [README](../README.md#-installation). Under WSL 2 the installer also:
   - adds `generateHosts = false` to `[network]` in `/etc/wsl.conf`, keeping
     every other line: WSL otherwise writes `/etc/hosts` anew at every start,
     and the panel's hosts lines would be gone;
   - keeps Apache on `127.0.0.1` (`dmp-root apache-local`, the original
     `ports.conf` kept in `/var/lib/devmagic-panel/apache-local`): WSL forwards
     an Apache on every address to Windows on `::1` only, and one on
     `127.0.0.1` on `127.0.0.1`, where Windows' hosts lines point;
   - keeps the panel running when the last WSL window closes (lingering, no
     question), installs Mailpit with `--yes` too, and adds the CA to no Linux
     browser store unless the distro has a browser of its own;
   - refuses WSL 1, a distro without systemd, and sites on a Windows drive
     (`/mnt/c` is 20 to 350 times slower than the distro's own disk).
3. In Windows, once, as administrator: add the panel's name to
   `C:\Windows\System32\drivers\etc\hosts`, and later each site's names the
   same way, one name per line (Windows reads only the first 9 names of a line):

   ```text
   127.0.0.1 local.devmagic
   ```

4. In Windows, trust the local CA for your user, so Chrome, Edge and Firefox
   accept the panel's certificates (Windows asks you to confirm once):

   ```powershell
   Import-Certificate -FilePath \\wsl.localhost\Ubuntu-24.04\etc\ssl\localcerts\devmagic-panel-ca\ca.pem -CertStoreLocation Cert:\CurrentUser\Root
   ```

5. Keep the distro running: WSL stops it a few minutes after its last window
   or command ends, however busy Apache and the panel are. Add a shortcut to
   your Startup folder (`shell:startup` in the Run dialog) with this target,
   which starts no window:

   ```text
   conhost.exe --headless wsl.exe -d Ubuntu-24.04 --exec sleep infinity
   ```

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
