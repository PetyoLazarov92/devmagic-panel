# Other pages

[Docs](README.md) › Other pages

## Aura

The health of your sites and this machine, every problem in one list, with
one-click fixes and **Fix all**:

- Certificates missing names, expiring, or from the old CA.
- Missing or leftover hosts lines, and names served on port 80 or 443 only.
- Insecure or outdated WordPress (from WordPress.org).
- Local mode off, Mailpit down.
- Nearly empty uploads with nothing loading them from production.
- A `wp-content` WordPress cannot write to.
- On nginx: a hosts line pointing at the other server, `.htaccess` rules nginx
  ignores, and nginx rules of another kind after a site became a network.

## WordPress

The shared wpcore cores with their WordPress.org status and the sites on each:

- Add a release (one with known security issues only after a typed
  confirmation, for testing).
- Switch sites to a safe core.
- Remove cores no site uses.

## Mail

The mail your local sites sent, caught by Mailpit: all sites or one, HTML
shown in a sandbox, and delete a site's mail. Installs Mailpit in one click
when it is missing.

## Environment

Checks the panel's own installation (files, root scripts, build), Apache,
nginx once it is installed (set up, running, `nginx -t`, each server on its own
address, configs made by hand that take Apache's ports), certificates, hosts
entries, MySQL (with the read-only account the SQL runner uses, and whether
its memory for InnoDB data fits the sites: a buffer pool far smaller than
them gets the setting and the file to put it in), PHP, tools and access. Each check is marked required, recommended or optional, most have a
one-click fix, and groups that all pass start closed.

Its **Settings** tab (`/environment/settings`) holds the panel password, the
AI assistant and the Claude Code defaults for installs from an organization.

## Run history

Every action the panel ran, with its result, in numbered pages. An install
that went on without a step shows a warning and how many it skipped, as on the
Jobs page. Runs are kept 90 days (at most 2000). Row values and SQL that writes
are never kept, like passwords.

## Archive

Copies of sites from the last 14 days, by site and date: removed, or replaced
by a reinstall or a restore, each with its folder, vhost, certificate and
database. **Restore** one (over the current site, after it is archived too), or
delete it for good. See [Undo and backups](undo-and-backups.md).

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
