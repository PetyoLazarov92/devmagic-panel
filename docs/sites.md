# Sites

[Docs](README.md) › Sites

The **Sites** page lists every local site on this machine, the ones you made by
hand included, and each site has a page of its own with its sections.

## The Sites page

- Every site with its health, certificate, WordPress core, git branch,
  database, multisite, logs and how it was installed: by the panel and from
  what, restored, or by hand. A filter picks sites by how they came here.
- A badge for the server that answers each site: Apache in grey, nginx +
  Apache or nginx in blue.
- Unfinished installs are listed at the top, to continue or discard (see
  [New site](new-site.md#install-drafts)).
- A site under a path of another site shows on its own, next to its parent
  (see [Sites under a path](#sites-under-a-path)).
- **Removed**: removed sites, and sites a reinstall or a restore replaced,
  kept 14 days to restore, as a filter of their own (`/sites?show=removed`).
  They never mix with live sites: one line under the list says how many there
  are, or how many match what you typed (see [Removed sites](pages.md#removed-sites)).

## A site's page

Breadcrumbs over the name show where you are (Sites, the site, its section),
and the header keeps **wp-admin** and **Open site** in view, with VS Code,
Network Admin, the folder path and Remove site in its menu.

A site's sections run down the side of its page on a wide screen, and become
tabs on a narrower one. Each has its own address (`?tab=database`,
`?tab=logs&log=apache`), so a reload or a link opens the same one. They come in
a fixed order, in three groups:

1. **Overview**, **Logs** and **Files**
2. WordPress, its data and its speed: **Network** (on a multisite),
   **Plugins and themes**, **Database**, **Performance**, **Cron**, **Config**
3. The server: **Server and PHP** (just **Server** without WordPress), **Domains and SSL**

A section a site lacks leaves the others where they are. In the side menu
every section and its badge are always in view; as tabs, those that do not
fit the width go under **More**, with their badges added up there. A
section's own views (the Database's Overview, Tables, SQL and Backups and
tools; Plugins and Themes; Browse and Uploads from production) are listed
under it in the side menu, which stays in view as you scroll, and as small
tabs on a narrower screen. Cards side by side come in pairs of a kind and are
as tall as each other; a card that does most (Git, Import a database) takes
the whole row. A badge counts only
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
- **Tidy up** on each repo: it fetches from origin with prune (branches
  deleted there go from the list here), then lists the local branches whose
  branch on origin was deleted, all ticked but the current one, each saying
  whether it is in origin's default branch (a squash merge often is not), and
  offers `git gc`, with the size of the repo's objects before and after. A
  deleted branch is kept 14 days under `refs/devmagic-panel/deleted`, so Undo
  in the toast puts it back; the next Tidy up after that lets it go. History
  is never rewritten. When the history itself holds big files, gc frees little:
  the dialog says so.
- Quick actions, and the core with a summary of the plugins and themes (how
  many, how many on, updates, and what the last missing check found), each a
  link to its view. It reads what was found; it never starts a check.
- **Files**: where the site lives, with **Open in Files** and a Files link for
  each folder, next to VS Code.

### Logs

- The debug constants sit above `debug.log`, each on its own: `WP_DEBUG`,
  `WP_DEBUG_LOG`, `WP_DEBUG_DISPLAY`, `SCRIPT_DEBUG`, `SAVEQUERIES`.
- `debug.log`, with Clear, and the web server's error log (Apache, or nginx
  for a site on nginx).

### Files

The site's folder and its files, read as you. See [Files](files.md).

### Network

A network's sites, with archived, spam, hidden and deleted ones marked and
filtered. A super admin can be made administrator on every site of the network;
Undo on the job takes it back.

### Plugins

The **Plugins and themes** tab has two views, kept in the address like the
Database tab's: **Plugins** and **Themes**. Both have **Compact** and
**Details**: Details adds what each one says it does, who made it and its
links.

**Themes** lists the site's themes, read only: which one is on, the parent a
child theme takes its templates from, the version and an update WordPress
already found, what its `style.css` says of it and who made it, and where
each folder is, with **Open folder** to it on the Files tab. A theme in a repo of its own under `wp-content/repos` is listed
too, marked **In its repo**. The theme is switched in wp-admin.

**Plugins**: each plugin on or off with one switch: search, filters, the updates WordPress
already found, what each plugin needs and what needs it, and the plugins turned
off at install and the local helpers marked. Undo is in the toast.
**Details** adds what each plugin says it does and who made it, read from its
header, with links: the author's name to their site, **Plugin site** to the
plugin's own, and **WordPress.org** when WordPress's own update check found it
there (nothing is asked for it). Only http(s) links are shown. It starts at
**Compact** each time. With the vulnerability check on (see
[Aura](pages.md#aura)), a plugin or theme with a known vulnerability at its
version has a **Vulnerable** badge, with the fixed version and a link to the
advisory. A long list shows its first rows,
with **Show more** and **Show all**. **Open folder** goes to the plugin's
folder on the Files tab, or **Open file** for a plugin that is one file.

**Updates**: a plugin or theme with an update WordPress already found has
**Update to** its new version on its row, and a bar above the list has
**Update all**, with **Snapshot the database first** ticked. They are
updated from WordPress.org with WP-CLI, as you, one at a time: one that
fails is noted, put back as it was, and the rest go on. Each folder is
copied into the Files tab's file trash first, so **Undo** on the job (or the
Files tab) puts the version from before back, and a plugin whose files do
not match WordPress.org's checksums after is put back too. One in a git
repo is updated, and the job says to commit it there. Must-use plugins,
drop-ins, one-file plugins, links and themes kept in a repo are left to
you. The Overview's "3 updates" opens the list on them.

**Missing plugins**, one row under the search and filters (and **missing
themes**, one row in the Themes view): plugins the
database names that the site's files lack, after a database import or a pull.
The row is always there and keeps its height, so the list under it never
moves: it says it is checking, then that no plugin is missing, or how many
are, and **Review** opens it. The check reads every site of a network with one
database query (in chunks of 200 sites) and runs on the server: changing tab
or page does not stop it, and coming back shows how far it got. Its result is
kept for half an hour, with when it was checked and **Check again**; a job
that changes the site makes the next visit check anew. Active
ones (on any site of a network, or network-wide) and ones production had
installed, read from WordPress's own update check, which also gives
production's version and the plugin's WordPress.org slug. Ones on WordPress.org
install from there, at production's version when it is known (else, or when
that version is gone, the latest), one at a time: one that fails is noted and
the rest go on. Each is checked against WordPress.org's checksums, kept out of
git locally, and not activated: the database already says which are active.
Undo removes what was installed.

The Themes view's row lists **missing themes**: the theme each site uses, and the
parent a child theme needs, when the files lack it. A theme in a repo under
`wp-content/repos` counts as there. Themes install from WordPress.org like
plugins, without a checksum check (WordPress.org has none for themes).

A premium or custom plugin or theme, which WordPress.org does not have, can
be copied from the site's own server. The row shows that server (its SSH host
and WordPress folder) with **Change** and **Forget**, and asks for both when none is saved
yet. It is the same server Refresh from production on the Database tab uses,
saved once for the site, with no password. **See what the server has** reads
its lists of plugins and themes, and **Copy from the server** copies the
ticked ones over SSH:

- Only reads on the server: WP-CLI says where the plugins folder is, and
  `tar` streams one folder to this machine. Nothing is written there, and a
  password the server asks for is used for that run only, unless you saved
  it for the server.
- What arrives is checked before it is unpacked: every entry inside the one
  folder asked for, no hard links, nothing under a link. Links are dropped.
- A folder that exists is never written over, the copy is kept out of git
  locally, and nothing is activated.
- A plugin is at most 500 MB and a run 3 GB. mu-plugins, drop-ins and core
  are never copied.
- A copied paid plugin keeps production's licence, so it may ask for a key or
  switch its updates off on a local address.

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
    (conditions, handlers, environment variables). A network whose sites
    live under paths gets WordPress's rules for any depth, so a site at
    `/learn/potions/` reaches its core files as one at `/learn/` does. The translated ones go
    into the site's nginx file; untick one to leave it out. A rule that is
    not translated needs a tick, or pick nginx + Apache to keep it working.
    The full screen button next to the title gives the list the whole
    window. The panel looks for `.htaccess` files in up to 5,000 folders,
    reading only the top two levels of `wp-content/cache` and
    `wp-content/uploads` and none of the year folders of uploads, and one
    nginx file takes up to 500 rules. When a site goes over either, the
    dialog says which, and where the read stopped.

  A job writes the new server's config and the hosts line, checks the site
  answers (asking again for a few seconds while the web server takes in the
  reload), then the old config goes; Undo moves it back. The dialog says why
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
