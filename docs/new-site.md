# New site

[Docs](README.md) › New site

The new site wizard starts three ways: **from a project** (its repos and,
usually, a database dump), **a fresh WordPress**, or **an empty site**.

From a project, the steps are **Code**, then, when Claude Code reads the repo
for you, **Claude reads the repo** and **Claude checks the links**, then
**Database**, **Domains**, **WordPress** and **Review**. Every step after Code
shows a short plan of the site at the top: each repo with its folder, and the
dump once it is in.

## Code

The repos of the site, the main one first. Each has its branch (the default
one first), where it goes in the site and the folder it is cloned into.

- **Your repos**: once the GitHub CLI (`gh auth login`) or the GitLab CLI
  (`glab auth login`, `--hostname gitlab.wandworks.test` for your own GitLab) is
  signed in, the repos of your GitHub organizations and GitLab groups are
  listed. Tick as many as the site needs: the first is the main repo, and
  **Make main** changes it. The ones you picked stay at the top of the list
  while you scroll, and a filter never hides them. The list starts on
  WordPress sites and offers themes, plugins and other repos once the site has
  its main repo. **Which to scan** picks the organizations and groups; a
  GitLab group is scanned with its subgroups. Without the CLIs the last list
  still shows and installs, as cloning uses git and your SSH key.
- **Paste a URL**: any SSH or HTTPS git URL, from any host.
- **Install to** and **Folder name**: a folder of the site (Site root,
  wp-content, Themes, Plugins, Must-use plugins, or any other folder) and the
  folder the repo is cloned into there; leave the name empty to clone into the
  folder itself. The wizard starts from what the repo holds: a whole site at
  the root, wp-content as `wp-content`, a theme or plugin in its folder named
  after the repo. The full path shows under the fields.
- **More than one repo**: up to 10, each in its own folder. Two repos never go
  to one path and only one can be the site root. A repo inside another one's
  folder is cloned after it and listed in that repo's local
  `.git/info/exclude`, so it never shows in its `git status`.
- **Core and uploads in a repo** are fine: a warning says it is unusual. A repo
  that holds WordPress core runs on it, with no shared core and no download.
  With a shared core, a repo cannot go into `wp-admin` or `wp-includes`: those
  are links to the core every site uses, and nothing is ever cloned through a
  link.
- **Trust**: code from a repo runs on this computer, its PHP when the site
  loads and its composer and npm builds as you. Repos of the organizations and
  groups you scan, and repos your signed-in CLI lists, may run. A repo from
  any other owner asks you once to trust that owner; trusted owners are listed
  under **Settings**, to take back, and the install refuses a repo you did not
  trust.
- **Filled from your last install**: the panel remembers its answers per main
  repo (the other repos and their folders, the core, the plugins turned off,
  where missing uploads load from), in its own database, never in the repo.
  **Settings**, **Remembered for new installs** lists them to edit or forget,
  and Review has a switch to not remember an install.

**Where everything goes**, beside the step, draws the site as a folder tree
with each repo at its path and branch.

## Claude Code, optional

The **Let Claude read the repo and its links** switch on the Code step adds
two steps. It shows once Claude Code is installed and signed in
(`claude auth login`); with a claude.ai sign-in it gets an animated border,
as only that sign-in reaches the Asana, Google Drive and Google Docs
connectors. **Settings**, **Use Claude Code in new installs** sets it: always
on (switch it off for one install), off (switch it on for one), or never.
Without Claude Code nothing about it shows and you go on by hand.

1. **Claude reads the repo**: Claude Code reads only the repo's docs and build
   files (README, `docs/`, `composer.json`, local dev configs; never
   `wp-config.php` or `.env`), copied into a folder of their own, and fills a
   fixed form: the Asana and Google links and what the docs say about dumps,
   plus versions, build and the production address. Each answer names the
   file it came from. **Skip** goes straight to the Database step.
2. **Claude checks the links**: it opens each link read-only, marks it ok, no
   access or not found, collects facts for the install, and lists the database
   dumps in Google Drive by name, size and date only.

Both run as jobs: leave the page and they keep going, show in the jobs list,
and the wizard picks up their answer when you come back. A card beside them
sets the model, effort and spending cap for the next run; the defaults per
step live under **Settings** (Read the repo: Sonnet, medium effort; Links and
dump: Sonnet, low effort; $0.50 per run), with **Check connectors**. Runs have
only read-only tools. Your local setup wins over the docs (local.* names,
wpcore, the cores you have, Apache), and the differences are listed.

**Describe the site to Claude**, under the main repo when the AI assistant is
on, fills the wizard from your words instead; see [AI assistant](ai-assistant.md).

## Database

Where the dump comes from. Every way ends the same: a file in the panel's
uploads, readable only by you, that must start like SQL, a gzip or a zip, and
is read for its facts (tables, prefix, addresses, network, admins). A zip has
only its first `.sql` unpacked, flat, after its unpacked size is checked
against the free space.

- **Found by Claude**: the dumps the links led to; rclone downloads one, or
  **Open in Google Drive** to download it in the browser.
- **Upload**: `.sql`, `.sql.gz` or `.zip`, up to 20 GB.
- **Downloads folder**: a dump you downloaded in the browser in the last three
  days; your file stays where it is.
- **Cloud drive**: any rclone remote (`rclone config`): Google Drive,
  Dropbox, OneDrive, Box, S3 and S3-like storage, Backblaze B2, SFTP, WebDAV
  and Nextcloud, FTP and more. Pick the remote and browse its folders (only
  folders and dumps are listed), or paste a link to a Google Drive file. rclone
  keeps its own sign-ins; the panel never reads them.
- **Public URL**: any `https://` address that serves the file, signed links
  included. Only https, never an address on this computer or a private
  network (checked on the address actually connected to), at most five
  redirects, each checked again, the free space and the 20 GB limit checked
  before and while it downloads. The part after `?` is never kept in run
  history or shown. A link that needs a sign-in does not work: download it in
  the browser and use the Downloads folder.
- **A server over SSH**: with your own SSH key through your agent and your
  `~/.ssh/config` (an alias, or `user@host`). **Export now with WP-CLI** runs
  `wp db export` in the WordPress folder you give on the server (it only
  reads; the server needs WP-CLI as `wp`) and streams it into a gzip here;
  **A dump file there** copies a `.sql`, `.sql.gz` or `.zip` with sftp. Never a
  password, and a host not in your `known_hosts` is refused with how to add
  it, never trusted on the fly. Paths take letters, digits and `. _ - /`
  only, as ssh hands the command to the server's shell.
- **This machine**: another site's database exported now (a second copy to
  test another branch), one of a site's snapshots, or the dump a deleted
  site's archive holds; the deleted site stays restorable as it was.
- **No database**: a fresh WordPress on the repo's code, with the admin from
  the WordPress step.

The **Found in the dump** card shows what it holds, and **Pick another dump**
takes a different one.

## Domains and WordPress

- **Domains**: one certificate, vhost and hosts line cover every domain of the
  site. The addresses the dump uses (production, staging, another local copy,
  with a port or not) are replaced, in URLs only.
- **A network**: its sites are listed by name, with a choice of its type here,
  subdirectory or subdomain in WordPress's words. It starts as the dump has it,
  sets `SUBDOMAIN_INSTALL` to match, is remembered per repo, and the install
  moves the sites whose address changes after the replace. A network is never
  installed under a path, and one served through a domain mapping plugin keeps
  its domains.
- **Plugins**: production-only plugins are deactivated (a search finds one in a
  long list), and the local helpers any repo has (as a plugin folder or in
  `composer.json`) are turned on.
- **Uploads**: missing images load from the production domain you give.
- **Build**: a checklist per repo lists every `composer.json` and
  `package.json` and ticks only the ones whose output the repo does not hold
  (`vendor/` or a build folder git ignores; never a wordpress.org plugin), with
  their build, prod or production script. Watchers are never offered. Builds
  run in their repo's folder with the Node the repo's `.nvmrc` or
  `.node-version` asks for, from nvm, else nvm's default or the Node the panel
  runs on.
- **Core**: the newest core you have is picked unless you choose another, or
  the repo's own when it holds core.
- **Web server**: once nginx runs next to Apache, Apache, nginx in front of
  Apache, or nginx with the PHP-FPM version it would run on.
- **Admins**: a dump's admins are listed (a network's super admins; the scan
  reads up to 16 GB of SQL for them), and one-click login signs you in as the
  first. An admin for this copy (admin / admin, superadmin on a network) is
  made only when you switch it on, or when the dump has none.

## While it installs

- Each step shows its output and progress (each clone, the import, the
  replace). The header lists running installs, so you can leave and come back;
  at most two run at once, and free disk space is checked first.
- A failed install can be retried from its step or undone.
- A failed step the site works without (the build, the local helpers, BE
  Media, `.htaccess`, flushing caches, the admin account) can be skipped: the
  install goes on, and the site's page keeps what is left to do, each with a
  **Done** button once you did it yourself.
- Go back a step and the steps you reached stay open until you change an
  answer; put it back and they open again.
- The site's Git card lists every repo the install cloned, in any folder.

## Install drafts

The wizard saves its answers (never a password) as you go, from the moment you
continue from Start. Each draft has its own address
(`/sites/new/<draft>/<step>`), so the browser's Back and Forward move between
its steps and a link opens it again. Unfinished installs are listed on the
Sites page, to continue or discard, for 24 hours after the last change; while
an install runs its draft stays, and once the site is in place the draft and
its dump go. A draft from before 1.28 opens in the new steps, with its repo's
old layout read as a folder.

Reinstalling over a site that is there archives the current one first, after
you confirm; see [Undo and backups](undo-and-backups.md).

## Repo lists

- Your own account on each host is listed too, ticked for you once per host,
  the first time that host's CLI is signed in. **Shared with you** lists the
  repos you were added to outside those: GitHub repos you collaborate on,
  GitLab projects outside your groups.
- Repos show what each holds (WordPress site, theme, plugin) and whether this
  machine has it installed.
- The list is kept in the panel's database and shows at once. Opening it
  checks for new pushes when the last check is over an hour old (usually one
  page of GitHub's REST API), and once a week, or with **Check now**, every
  repo is listed again so deleted and renamed ones go. A repo is looked into
  again only after a push (on GitLab, after any activity; checks read 70
  minutes back, as GitLab moves that time about once an hour).
- The panel only runs `gh` and `glab`; it never reads their tokens.
- Installed sites need none of this: their Git card reads the site's own
  `.git` and the repos inside it, whatever the host. A host whose name does
  not say what it runs (`git.wandworks.test`, or an SSH alias like
  `gitlab-work`) is found once a week with `ssh -G` and the same SSH hello
  `git fetch` makes, so its links and merge requests are right without a
  setting.

The panel stores no token for any of this: Claude Code, `gh`, `glab` and
rclone keep their own sign-ins, and the panel runs them as you without reading
them. The Machine checks in Aura show whether each is set up and signed in.
