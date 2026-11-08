# Services

[Docs](README.md) › Services

The **Services** page has six tabs, each with its own address.

## Overview (`/services`)

A card per service (Apache, PHP, nginx, MySQL, Mailpit, Cron) with its state,
its facts, its buttons and a link to its tab:

- Apache reload and restart, after a configtest.
- MySQL restart.
- Mailpit installed or started in one click: a pinned release, checksum
  checked, as a user service.

## PHP (`/services/php`)

PHP on this machine first, with a tile per installed version, then everything
of the version picked (`/services/php/<version>`), one section under the
other:

- **Versions**: every installed PHP version with its release and any newer
  build apt offers (**Update** in one click); versions apt can install
  (**Install**, with PHP-FPM, the command line and the common modules; the
  one-time command for the ondrej/php PPA when apt has no other version); and
  **Remove** for one nothing uses.
- **Packages**: module packages from apt per version.
- **Parts and modules**: the parts installed (mod_php, PHP-FPM, command line),
  its modules, and Xdebug (any mix of debug, develop, profile, trace,
  gcstats and coverage) switched per version. With `profile`, `trace` or
  `gcstats`, Xdebug writes to `$STATE_DIR/profiles/<version>`, where a
  site's Performance tab lists its profiles; traces and GC stats are deleted
  after the same 3 days.
- **Sites**: every site's code checked against the version, with a table of
  what each has.
- **Settings**: the panel's own settings per version for the web and the
  command line (memory, uploads, time limits, errors, OPcache and more), in
  its own `99-devmagic-panel.ini`; `php.ini` is never edited. What each
  `php.ini` changes from the packaged one, with a job that moves those changes
  into the panel's settings.
- **Info**: PHP info and Xdebug info for the web and the command line, asked
  from PHP itself, with password-like settings hidden.
- **PHP-FPM**: a check of what changes for sites on PHP-FPM, and **Make PHP-FPM
  match Apache** for a version whose FPM differs from its mod_php.
- **How sites run**: the switch that turns mod_php off and runs every site on
  one version through PHP-FPM (Apache on mpm_event, phpMyAdmin in a pool of its
  own, every site checked afterwards; Undo turns mod_php back on), and the way
  back.

## MySQL (`/services/mysql`)

Every database and user, processes, and importing a dump: see
[Databases](databases.md#services--mysql).

## Apache (`/services/apache`)

- Apache at a glance: state and uptime, version, worker model, PHP, ports.
- Every module in `mods-available` with a switch. The panel's own, the core
  ones, `php*` and `mpm_*` stay as they are, and a change whose configtest
  fails is taken back.
- Every vhost file, with whether it is enabled and whose it is.
- A configtest and Apache's own error log.

## nginx (`/services/nginx`)

nginx runs next to Apache, both on ports 80 and 443, each on its own loopback
address (Apache on `127.0.0.1`, nginx on `127.0.0.2`), so a site goes to the
server its hosts line points at, with nothing proxied.

- The command to install it, and **Set up nginx**: Apache restarts on its
  address, Debian's default nginx site goes off, and every site is checked
  afterwards; Undo turns nginx off.
- **Write settings again**, **Turn nginx off**, `nginx -t` and **Reload**.
- Every config in `sites-available`, with whether it is enabled, whose it is
  and whether it takes Apache's ports, and nginx's own error log.
- Once nginx is set up, a **Sites** card shows how many sites run on Apache,
  nginx + Apache and nginx, sets the web server the new site wizard picks,
  and moves every site to one of them in one job: each site checked as it
  moves, the ones that stay listed with why, and Undo moves them all back.

## Cron (`/services/cron`)

- The panel's tasks in your crontab: a site's WP-Cron, a WP-CLI command, a PHP
  file in a site, a local URL, or a program with arguments, run without a
  shell. Each has a schedule in words with its next runs, a time limit, a
  switch, **Run now** and a history of runs with their output.
- The lines you wrote yourself, read only.
- System cron and the systemd timers, read only.
