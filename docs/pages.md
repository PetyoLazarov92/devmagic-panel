# Other pages

[Docs](README.md) › Other pages

## Command palette

**Ctrl+K** (or **Cmd+K**) anywhere: type to jump to a site or a page, open a
site, wp-admin, VS Code or its branch, and run a quick action. On a site's
page its own actions come first: clear the cache, flush rewrite rules, take a
database snapshot, clear `debug.log`, open a terminal, fetch or pull, reissue
the certificate. Reload Apache or nginx, restart a service and clear Mail are
there too; restarting MySQL, Apache or nginx and clearing Mail ask first. The
outcome is a toast, with the job one click away. The actions it offers are
the registry's (`palette` on an action in `shared/src/actions.ts`).

## The menu

Three groups, every page visible, with a short hint or a live count on the
right of each item:

- **Work**: Sites (with the count), Aura, Mail (new messages).
- **Server**: Services, WP Cores.
- **System**: Activity, Updates (a newer release), Settings.

The fold button at the bottom of the menu, or Ctrl+B, folds it to a rail of
icons for a wider page; each icon names its page when you point at it, and a
dot marks news. The panel remembers which you chose. On a phone the menu is a
drawer behind the button at the top left, with the theme switch.

Pages that moved keep working at their old address: `/environment` opens
Aura's Machine checks, `/environment/settings` Settings, `/jobs` and `/runs`
Activity, and `/trash` the Sites page's Removed filter.

## Aura

Everything that needs fixing, on two tabs.

**Problems** (`/aura`): the health of your sites and this machine, every
problem in one list, with one-click fixes and **Fix all**:

- Certificates missing names, expiring, or from the old CA.
- Missing or leftover hosts lines, and names served on port 80 or 443 only.
- Insecure or outdated WordPress (from WordPress.org).
- Local mode off, Mailpit down.
- Nearly empty uploads with nothing loading them from production.
- A `wp-content` WordPress cannot write to.
- On nginx: a hosts line pointing at the other server, `.htaccess` rules nginx
  ignores, and nginx rules of another kind after a site became a network.
- Known vulnerabilities in the sites' plugins and themes, once you switch the
  check on in the **Known vulnerabilities** card under the list. It runs once a
  day in the background (or on **Check now**) through
  [WPVulnerability](https://www.wpvulnerability.com/), free and without a key.
  Only the slugs WordPress's own update check found on WordPress.org are
  asked about, never a version: the answer lists every known vulnerability with
  its version range, and the panel compares the installed version here. A high
  or critical one fails, the others warn, each with the fixed version and its
  advisory. Answers are kept a day per slug. When a fixed version exists and
  the plugin or theme is a folder the panel updates (not one file, must-use or
  a theme kept in a repo), the line has **Update**: it says first what happens
  (the newest version from WordPress.org, a database snapshot first, the old
  folder kept for Undo) and then starts the same job as the Plugins tab, with
  **Show progress** in the toast. **Fix all** and the login briefing leave
  these out, so updates are never started in bulk.

**Machine checks** (`/aura/machine`): every check of this machine, passing or
not. The panel's own installation (files, root scripts, build), Apache,
nginx once it is installed (set up, running, `nginx -t`, each server on its own
address, configs made by hand that take Apache's ports), certificates, hosts
entries, MySQL (with the read-only account the SQL runner uses, and whether
its memory for InnoDB data fits the sites: a buffer pool far smaller than
them gets a fix that sets it, as the MySQL page's Settings do), PHP, tools and
access. Each check is marked required, recommended or optional, most have a
one-click fix, and groups that all pass start closed.

## WP Cores

The shared wpcore cores with their WordPress.org status and the sites on each:

- Add a release (one with known security issues only after a typed
  confirmation, for testing).
- Switch sites to a safe core.
- Remove cores no site uses.

## Mail

The mail your local sites sent, caught by Mailpit: all sites or one, HTML
shown in a sandbox, and delete a site's mail. Installs Mailpit in one click
when it is missing.

## Settings

The panel password, the AI assistant, Claude Code for installs (whether new
installs use it, and the model, effort and cap of its one step), the constants new
sites get, what the wizard remembers per repo (**Remembered for new
installs**, to edit or forget), and the repo owners you trusted, to take back
(`/settings`).

## Activity

What the panel did, on two tabs.

- **Jobs** (`/activity`): installs, imports, restores and other long actions
  since the panel last started, running ones first. A job's own page is
  `/jobs/<id>`.
- **Run history** (`/activity/runs`): every action the panel ran, with its
  result, in numbered pages. An install that went on without a step shows a
  warning and how many it skipped. Runs are kept 90 days (at most 2000). Row
  values and SQL that writes are never kept, like passwords.

## Removed sites

Removed sites are a filter of the Sites page (`/sites?show=removed`), never
mixed into the list of live ones: while some are kept, one line under the list
says how many, with **Show them**. Each is a copy from the last 14 days, by
site and date: removed, or replaced by a reinstall or a restore, with its
folder, vhost, certificate and database. **Restore** one (over the current
site, after it is archived too), or delete it for good. See
[Undo and backups](undo-and-backups.md).

## Long tool pages

The Overview of a site's Database tab and the MySQL page start with what
needs a look, when anything does: one link per card that found something
(table problems, autoload over its limit, expired transients, leftovers of
plugins that are gone, rows to clean up; databases no site uses, users left
behind), worst first, which scrolls to the card and rings it for two
seconds, so you see which card you landed on. The count of rows to clean up
is the card's own: what its Delete button takes as it opens.

## Developer options

Tap the version at the bottom of the menu seven times, like a phone's build
number. A **Developer** page joins the menu with:

- The panel's version and commit, its services and `config.env`.
- The install logs, and the panel service's startup log (starts, stops,
  warnings and errors, without the request lines).
- Every file the installer put on the machine and the files the panel makes as
  it runs, as folders that start closed. Open one and the panel reads what it
  holds: names and sizes, never contents, at most 200 entries, and only the
  folders those two lists name.

A switch on that page turns it off again. It is remembered per browser.
