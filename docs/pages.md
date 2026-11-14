# Other pages

[Docs](README.md) › Other pages

## Command palette

**Ctrl+K** (or **Cmd+K**) anywhere: type to jump to a site or a page, open a
site, wp-admin, VS Code or its branch, and run a quick action. On a site's
page its own actions come first: clear the cache, flush rewrite rules, take a
database snapshot, clear `debug.log`, open a terminal, fetch or pull, reissue
the certificate, and every tab and view of the site ("Database › SQL",
"Database › Backups and tools", "Plugins and themes › Themes"), so any
part of it is a few keys away; another site's are found by typing its name
and the view ("brands sql"). Reload Apache or nginx, restart a service and clear Mail are
there too; restarting MySQL, Apache or nginx and clearing Mail ask first. The
outcome is a toast, with the job one click away. The actions it offers are
the registry's (`palette` on an action in `shared/src/actions.ts`).

## The menu

Three groups, every page visible, with a short hint or a live count on the
right of each item:

- **Work**: Sites (with the count), Aura, Mail (new messages).
- **Server**: Services, WP Cores.
- **System**: Activity, Sanctum, Updates (a newer release), Settings.

At the bottom of the menu, next to Log out, the palette icon opens
[Modes](modes.md). The fold button there, or Ctrl+B, folds the menu to a rail of
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
  day as a background task (Sanctum lists it, and it looks hourly whether a
  day passed, so a restart never skips one), or on **Check now**, through
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
- **Check again** asks WordPress.org now; when it does not answer, the page
  says so and how old the statuses it shows are.
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
(`/settings`). Ctrl+K's **Change the panel password** opens this page.

## Sanctum

The panel's inner workings (`/sanctum`), also from the heart icon in the top
bar, whose card has the short version: a status line, what runs now and the
next task. Four tiles give the short answer: the panel
(version, memory, when it started, and a warning when the run before did not
stop cleanly), what runs now, its background tasks (with any that failed),
and its storage in all. Under them, one list at a time:

- **Running now** (the default): each program the panel has open, with
  its command where it has one (`git status`, `wp plugin list`, `dmp-root
  vhost-write`; only words that look like a command, never a value), since
  when, and what started it: a job (a link to it), a background task, or the
  page whose read it is ("Sites › local.spellbook.example › plugins", from
  the server's route and the site it names, never the address asked, its
  query or body). A job is what you started; these are the programs behind
  it. Reads of one program for one page running at once share a line
  (`wp plugin list ×7`). **Recently finished**, a card of its own, lists the
  last 50 of jobs and background tasks, and page reads that failed or took
  5 seconds or more, with how long each took, whether it failed or was
  stopped by its timeout, and why it failed in a few words from a fixed list
  ("table not there", "not a git repository", "printed nothing"), read from
  its exit code and MySQL's error number, never its output. Alike ones share
  a line (`mysql ×9`, with the range of their times). **Page reads that went
  well** are a table: each program with how many times, its average and its
  slowest. All of it stays in memory until the panel restarts, never
  arguments or output. A program that ran 30 seconds or
  more, or failed for a job or a background task, also goes to the panel's
  log (`journalctl --user -u devmagic-panel`), by name only; a page's read
  that fails is often meant to (a sign-in check), so it is not logged.
- **Background tasks** (`?view=tasks`): the work the panel does on its own,
  how often, what each last did and when it runs next, with **Run now**,
  which like the timer removes only what is past its time and says so when
  nothing was:
  remove expired install drafts (every 10 minutes); trim Run history, remove
  old downloaded dumps, Files tab deletes and MySQL settings backups, drop
  expired kept databases (hourly); check plugins and themes for known
  vulnerabilities (looks hourly, checks once a day while the check is on in
  Aura; Run now checks at once); remove old automatic snapshots (daily);
  pack older panel versions (daily); remove deleted sites for good and check
  for a new release (every 6 hours). Under them, **Watching all the time**:
  the .htaccess files of the sites on nginx, with how many folders on how
  many sites and when it last noticed a change. The tasks in your crontab
  (a site's WP-Cron and the like) run from cron: Services, Cron lists them.
  Click a task for its last runs: when, what it did or why it failed, and how
  long it took. The newest 20 per task are kept in the panel's database.
- **Storage** (`?view=storage`): what the panel keeps, each with its size and how
  long it stays (point at a name for what it is): database snapshots, clean
  copies, backups for Undo, deleted sites, downloaded dumps, the Files tab's
  deletes, MySQL settings backups, panel versions, Mailpit and tools, Run
  history and logs, and kept databases. **Clean up now** removes all of that
  kind now, after a confirmation that says what goes (and, for kept
  databases, lists them): the snapshots the panel took before a change (yours
  stay), downloaded dumps (except one a job or a draft uses), the Files tab's
  deletes with their Undo, MySQL settings backups, every finished run, or
  every kept database (except one of a site a job works on). It is the
  `storage.clean` action, so Run history has it. The other kinds open where
  you manage them: clean copies on a site's Database tab, deleted sites in
  Removed sites, panel versions on Updates (three are kept: the running one
  unpacked, the others packed with gzip at its best, about a seventh of the
  room; switching back to one unpacks it first), caught mail in
  Mail; backups for Undo stay for `dmp-restore`. Snapshots the panel takes before a change
  (`before-import` and the like) keep the newest 3 per site and every one
  from the last 30 days; the ones you take stay until you delete them.

When the panel does not answer (it restarts after an update, or Apache
reloads), the heart icon says **Reconnecting...** until it is back. A page
that reads asks once more after a second; a change that lost its answer
says it is not known whether it ran, and Activity shows what did.

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

- The panel's version and commit, its services (the panel, Mailpit, Apache,
  MySQL, nginx, cron and PHP-FPM of each version that has it) and
  `config.env`.
- The install logs, and the panel service's startup log (starts, stops,
  warnings and errors, without the request lines).
- Every file the installer put on the machine, and what the panel makes as it
  runs in three groups: its data (run history, uploads, the Files tab's
  deletes and staged files, snapshots and Undo copies, caches, tools and
  logs), the system files dmp-root wrote (PHP's pools and settings per
  version, Apache's and nginx's confs, the sites on nginx, MySQL's settings
  and the state in `/var/lib/devmagic-panel`, only the ones there), and other
  things it made (its block in your crontab, the MySQL accounts it signs in
  with by name only, and how many sites have its two mu-plugins). Folders
  start closed. Open one and the panel reads what it holds: names and sizes,
  never contents, at most 200 entries, and only the folders those lists
  name.

- **Modes**: each mode's paths with their rule, progress and when they
  started counting, with Reset per path, Complete (fills a path, to try the
  real unlock and its dialog), Unlock and Seal (a sealed mode leaves the Modes
  page, and the panel goes back to Classic if it was in use), Reset all paths,
  and what the panel counts. An unlock from here shows the unlock dialog, as
  any other. The only place the rules are shown.

A switch on that page turns it off again. It is remembered per browser.
