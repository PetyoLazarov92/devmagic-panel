# Sites

[Docs](README.md) › Sites

The **Sites** page lists every local site on this machine, the ones you made by
hand included, and each site has a page of its own with tabs.

## The Sites page

- Every site with its health, certificate, WordPress core, git branch,
  database, multisite, logs and how it was installed: by the panel and from
  what, restored, or by hand. A filter picks sites by how they came here.
- Unfinished installs are listed at the top, to continue or discard (see
  [New site](new-site.md#install-drafts)).
- A site under a path of another site shows on its own, next to its parent
  (see [Sites under a path](#sites-under-a-path)).
- **Removed**: removed sites, and sites a reinstall or a restore replaced,
  kept 14 days to restore, as a filter of their own (`/sites?show=removed`).
  They never mix with live sites: one line under the list says how many there
  are, or how many match what you typed (see [Removed sites](pages.md#removed-sites)).

## A site's page

Each tab has its own address (`?tab=database`, `?tab=logs&log=apache`), so a
reload or a link opens the same one. The tabs come in a fixed order, in three
groups:

1. **Overview** and **Logs**
2. WordPress, its data and its speed: **Network** (on a multisite),
   **Plugins**, **Database**, **Performance**, **Cron**, **Config**
3. The server: **Server and PHP** (just **Server** without WordPress), **Domains and SSL**

A tab a site lacks leaves the others where they are. A tab's badge counts only
what needs a look: errors in `debug.log`, late WP-Cron events, local constants
to set, names the certificate or hosts file leaves out.

### Overview

- A tile for each other tab (debug mode, the network, the database, WP-Cron,
  PHP, domains and the certificate) that opens it.
- **Git**, one section per repo: the site's own, `wp-content`, each theme,
  plugin and must-use plugin folder with a `.git` of its own, and mounted
  folders. Each shows its branch, with pull, fetch, switch (search by any
  letters of the name) and its open pull or merge requests (through the GitHub
  CLI when you are signed in to it).
- Quick actions and the core.

### Logs

- The debug constants sit above `debug.log`, each on its own: `WP_DEBUG`,
  `WP_DEBUG_LOG`, `WP_DEBUG_DISPLAY`, `SCRIPT_DEBUG`, `SAVEQUERIES`.
- `debug.log`, with Clear, and the web server's error log (Apache, or nginx
  for a site on nginx).

### Network

A network's sites, with archived, spam, hidden and deleted ones marked and
filtered. A super admin can be made administrator on every site of the network;
Undo on the job takes it back.

### Plugins

Each plugin on or off with one switch: search, filters, the updates WordPress
already found, what each plugin needs and what needs it, and the plugins turned
off at install and the local helpers marked. Undo is in the toast.

### Database

Overview (what needs a look, read from WordPress's tables), Tables, SQL,
and backups and tools, in that order: see
[Databases](databases.md). Top queries are on the Performance tab.

### Cron

A WordPress site's WP-Cron events with Run now and Delete (Undo puts one back),
its intervals, **Check WP-Cron**, its cron tasks, and the switch that runs its
WP-Cron from cron instead of page loads.

### Server and PHP

How the site is served, in one tab (named Server for a site without
WordPress). The Overview's Server and PHP tile shows both, like
"Apache · PHP 8.3".

- **Web server**: the server the site runs on, and **Change** to pick
  another, as the site runs in production:
  - **Apache**: Apache answers and reads every `.htaccess`.
  - **nginx + Apache**: nginx answers with the site's certificate and passes
    requests to its Apache vhost over HTTPS, so Apache still reads every
    `.htaccess` and runs its PHP, as hosts that put nginx in front of Apache
    do. By default nginx serves images, CSS, JS and fonts that exist itself;
    folders with an `.htaccess` of their own (a logs folder with
    `Require all denied`) still go to Apache, and the dialog lists the rules
    of the root `.htaccess` about those files, which then do not run. Untick
    it to send every request through Apache.
  - **nginx**: nginx with PHP-FPM. nginx reads no `.htaccess`, so the dialog
    lists every rule of the site's `.htaccess` files and what it becomes:
    covered (WordPress's own rules, http to https, no folder listings),
    translated (redirects, rewrites, denied files and folders, security
    headers, error pages), not needed here (page caches, compression,
    production host names), PHP settings for the PHP tab, or not translated
    (conditions, handlers, environment variables). The translated ones go
    into the site's nginx file; untick one to leave it out. A rule that is
    not translated needs a tick, or pick nginx + Apache to keep it working.

  A job writes the new server's config and the hosts line, checks the site
  answers, then the old config goes; Undo moves it back. The dialog says why
  a site cannot run on a server when it cannot. A site under a path runs on
  its domain's server and links to it. The command palette (Ctrl+K) has Move
  to nginx, Put nginx in front of Apache and Move to Apache for every site
  that can move as it is.
- **.htaccess rules**, for a site on nginx: each rule of its `.htaccess` files
  and whether the nginx file has it, **Check again**, and **Copy nginx rules**
  (the translated ones, for a host's own nginx settings). When an `.htaccess`
  changed since its rules were applied, a notice opens **Review and apply**:
  the same list with ticks, and the job writes the rules after dmp-root checks
  each one and `nginx -t` passes, with Undo. A file that changed again after
  you opened the review is refused, so you review it again. Aura has an issue
  while rules wait.

  The panel watches the `.htaccess` files of sites on nginx while it runs (the
  kernel's change notifications, a few seconds after a burst of writes) and
  compares checksums when it reads a site, for changes made while it was not
  running. A change that gives nginx other rules, or new rules nginx does
  nothing with, shows a notice on any page with **Review**, which opens the
  review on the site; a change that leaves nginx's rules as they are (a
  caching plugin saving its settings, WordPress's own rules) stays quiet.
  **Not now** puts a change off: Aura and the notices stay quiet until a file
  changes again. Nothing is applied without the review, as on a host that
  runs nginx only, where an `.htaccess` change does nothing until it is added
  to the host's nginx rules. dmp-root takes rules of fixed kinds only and writes the
  nginx itself, so nothing from an `.htaccess` reaches nginx as it is.

  On Aura, a site with nginx in front of Apache gets
  an issue when its `.htaccess` has rules about files nginx serves (Send
  everything through Apache) or a folder got an `.htaccess` of its own (Write
  its nginx rules again).
- The site's own PHP version and settings, through its own PHP-FPM pool,
  checked against what its `composer.json`, plugins and themes ask for.
  WP-CLI the panel runs for it follows the same version.
- After a switch the panel opens the home page and wp-admin and reads the
  site's logs for new PHP fatal errors; Undo on the job puts it back.
- A compatibility check of its themes and plugins against another PHP version
  before you switch: PHPCompatibilityWP, fetched once with Composer into the
  panel's data folder. It is a hint and never blocks the switch.
- PHP info from the PHP that serves the site.

### Performance

Why a page is slow, in one place:

- **Profiles**: Xdebug's profiler for the site. **Turn on profiling** adds the
  `profile` mode to the PHP version the site runs (trigger only, so a page is
  profiled only when it asks), and Xdebug then writes to the panel's folder,
  `$STATE_DIR/profiles/<version>`, instead of Apache's private `/tmp`.
  **Open and profile** opens a page of the site with `XDEBUG_PROFILE=1`; its
  profile shows the time by plugin and theme (PHP's own functions count with
  the code that calls them most) and the slowest functions with their calls and
  callers. **Download** gives the file for KCachegrind or an IDE. Profiles are
  deleted after 3 days.
- **Top queries**: every query of the site's database, the most time in all
  first (see [Databases](databases.md#top-queries)).

### Domains and SSL

- The site's domains, certificate and hosts lines.

### Quick actions

- One-click wp-admin login (Network Admin too).
- Clear caches and flush rewrite rules.
- Open in VS Code in a new window, or open a terminal at the site's folder (the
  desktop's default terminal, when the panel runs in your desktop session).
- Switch the shared WordPress core.
- Local mode with blocked hosts, and where missing uploads load from.
- Fix health issues in one click.
- Archive and remove the site, kept 14 days under Removed (any site in the usual layout; see
  [Undo and backups](undo-and-backups.md)).

## Sites under a path

A WordPress install a vhost serves under a path (an `Alias`, like Spellbook
Learn at `local.spellbook.example/learn`) is a site of its own. It has its own
folder, database, git, debug settings, logs, Local mode and snapshots; its
vhost, certificate and hosts line stay with the parent. The new site wizard
installs one too: its own folder, and an `Alias` in the parent's vhost.
