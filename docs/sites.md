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
3. The server: **PHP**, **Domains and SSL**

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

### PHP

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

- **Web server**: the server the site runs on, and **Move to nginx** or
  **Move to Apache**. A job writes the other server's config and the hosts
  line, checks the site answers, then the old config goes; Undo moves it back.
  The `.htaccess` rules nginx would leave out are listed to tick first, and the
  card says why a site stays on Apache when it must.
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

A WordPress install a vhost serves under a path (an `Alias`, like Northwind
Learn at `local.northwind.com/learn`) is a site of its own. It has its own
folder, database, git, debug settings, logs, Local mode and snapshots; its
vhost, certificate and hosts line stay with the parent. The new site wizard
installs one too: its own folder, and an `Alias` in the parent's vhost.
