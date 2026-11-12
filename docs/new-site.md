# New site

[Docs](README.md) › New site

The new site wizard starts three ways: **from a project** (its repos and,
usually, a database dump), **a fresh WordPress**, or **an empty site**.

From a project, the steps are **Code**, then, when Claude Code reads the repo
for you, **Claude reads the project**, then
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
  while you scroll, and a filter never hides them. Under the lists, **Repos of
  this site** has each picked repo with its branch and folder. The main repo
  is the project itself: it names the install, Claude reads its docs, and the
  panel remembers your answers under it; **Make main** moves that role to
  another repo, and every repo stays where it is in the list and in its
  folder. The list starts on
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
- **A theme in a folder of its repo** (tooling on top, the theme in
  `wandworks/`): the wizard says so and places the repo in
  `wp-content/repos`. Local mode makes each repo there one more themes
  folder for WordPress, so the theme is found under its own name, the one
  production's database has. Nothing is copied or linked and the database is
  not changed, so a refresh from production keeps working. It needs Local
  mode on. A theme whose `style.css` the build makes is still recognized.
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
one step, **Claude reads the project**. It shows once Claude Code is installed
and signed in (`claude auth login`); with a claude.ai sign-in it gets an
animated border, as only that sign-in reaches the Asana, Google Drive and
Google Docs connectors. **Settings**, **Use Claude Code in new installs** sets
it: always on (switch it off for one install), off (switch it on for one), or
never. Without Claude Code nothing about it shows and you go on by hand.

The step runs as one job, in two parts:

1. **What the repo says**: Claude Code reads only the repo's docs and build
   files (README, `docs/`, `composer.json`, local dev configs; never
   `wp-config.php` or `.env`), copied into a folder of their own, and fills a
   fixed form: the Asana and Google links and what the docs say about dumps,
   plus versions, build and the production address. Each answer names the
   file it came from, and shows as soon as it is in.
2. **The links and the dumps**: it opens each link the docs name, read-only,
   marks it ok, no access or not found, collects facts for the install, and
   lists the database dumps in Google Drive by name, size and date only.
   Docs without links skip this part.

They stay two runs of Claude Code on purpose: the one that reads the repo's
text has no connectors, and only its checked form reaches the one that opens
your links. **Go on without Claude**, next to Continue while Claude Code reads
or after it failed, leaves the step at any time, and **Skip
the links and pick a dump myself** leaves only the second part; **Check the
links** runs it after all. When the links cannot be checked, the repo's
answer stays and you go on to pick the dump yourself.

Leave the page and the job keeps going, shows in the jobs list, and the wizard
picks up its answers when you come back. Both answers are kept on the draft,
so coming back, or checking the links again, never pays twice for the same
repo or the same links.

One model, effort and spending cap cover the step: under the switch on the
Code step for this install (**Runs with ...**), and under **Settings** for
every install (Sonnet, medium effort, $1.00), with **Check connectors**. The
effort is for reading the repo; links are always checked at low effort. The
cap is for both parts together: the links get what reading left, and when
reading used it all, the job says so and **Check the links again** gives them
the whole cap. Runs have only read-only tools. Your local setup wins over the
docs (local.* names, wpcore, the cores you have, Apache), and the differences
are listed.

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
  `~/.ssh/config` (an alias, or `user@host`, with the port after it when it
  is not 22: `alex@www.spellbook.example:2222`). **Export now with WP-CLI** runs
  `wp db export` in the WordPress folder you give on the server (it only
  reads; the server needs WP-CLI, as `wp` or under the name you give in **WP-CLI
  has another name on the server?**: a program name or path like `wp-cli` or
  `~/bin/wp`, saved with Refresh from production) and streams it into a gzip here;
  **A dump file there** copies a `.sql`, `.sql.gz` or `.zip` with sftp. A host
  not in your `known_hosts` is refused with how to add it, never trusted on
  the fly. The panel signs in with your key, and checks how the server signs
  you in as soon as you type the host (one connection that runs nothing):
  with your key, it says so and asks for nothing. Only for a server that
  would ask for a password does **Password on the server** show under the
  host; a server that takes keys only and refuses yours, or one it cannot
  reach, is said there too. The password is kept out of the browser's and
  password managers' saved passwords, and it is used for that run's connections only (reading the
  tables, the export or the copy), never logged or shown. **Save for** the
  host keeps it in the panel's `secrets.json` (readable by you only): an
  empty field then uses it, a new one replaces it, **Forget password** removes
  it, and it is never shown back. How a server signs you in is checked once
  you stop typing the host or press **Check connection**, and kept for an
  hour; a site's saved server is not checked when you open a view. Nothing is written on the server, and no key is
  added to it. A wrong password is tried once. Paths take letters, digits and `. _ - /`
  only, as ssh hands the command to the server's shell.
  The export is compressed on the way, writes no file on the server and
  leaves its database password there (WP-CLI reads `wp-config.php` and runs
  mysqldump there). On a host whose PHP turns `exec` and similar functions
  off, where WP-CLI stops without a word, it runs once more as
  `php -d disable_functions= <wp>`, for that one run only, and the job says
  so. A dump without mysqldump's last line was cut off on the way and is
  thrown away, never imported.
  **Choose tables** lists the server's tables, biggest first, with their size,
  to leave the rows of some on the server: known logs (Action Scheduler,
  Wordfence, Redirection, WP Activity Log, Simple History, Stream, WP Mail
  Logging) are ticked for you, and personal data (WooCommerce orders and
  customers, Gravity Forms and WPForms entries) too with a cleaned copy. A
  table left out still comes, empty, so nothing misses it. The choice is
  remembered per server and folder. Only whole tables: personal data in
  users, comments or options still comes, and the clean step below takes
  care of it.
  **The copy**, **Cleaned** turns that clean step on.
- **This machine**: another site's database exported now (a second copy to
  test another branch, with tables to leave the rows of, as over SSH), one of
  a site's snapshots, or the dump a deleted site's archive holds; the deleted
  site stays restorable as it was.
- **No database**: a fresh WordPress on the repo's code, with the admin from
  the WordPress step.

The **Found in the dump** card shows what it holds, and **Pick another dump**
takes a different one.

**The copy** is the same choice a site's Import a database has: **As it is**
(an exact copy, the default) or **Cleaned**, which lists what goes from this
dump and runs the clean-up on the new database after the import, with SQL and no
WordPress code: every user but one goes, with WooCommerce orders and customer
data, product reviews, form entries, logs and payment, mail and API keys. The
one user kept is the WordPress step's admin: the dump's own administrator as
it is, or a new one with your password, the author of every post. Mail and
production-only plugins go off as on every install from a dump.

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
- **Missing plugins**: plugins the dump has that no repo brings (a project
  whose repo is only its theme, say). Active ones on WordPress.org install
  from there after the import, at production's version when the dump's update
  check has it; others you can turn off or leave (WordPress turns a missing
  active plugin off on its own). Ones production had installed but not active
  are listed apart, to install if you want them. A folder name WordPress.org
  could not have (capitals, a dot, a space) counts as not on WordPress.org.
  When the dump was exported from a server over SSH, the ones WordPress.org
  does not have (paid and custom plugins) can be copied from that server:
  the step asks it for its list of plugins, and **Copy from the server** is
  picked for an active one it has. The copy runs after the import, reading
  only (see [Sites](sites.md#plugins)). A server that asks for a password
  gets the one you gave for the dump, during the same visit only,
  and when WordPress.org gives no answer the step says so, with **Ask again**. One that fails is noted and
  the rest install; see [Sites](sites.md#plugins) for how.
- **Missing themes**: the themes the dump's sites use (each site of a
  network, and the parent a child theme takes its templates from) that no
  repo brings. One on WordPress.org installs from there, at production's
  version when the dump has it; a paid or custom one can be copied from the
  server the dump was exported from, the same way as a plugin. Nothing is
  activated: the database already says which theme is on.
- **Uploads**: missing images load from the production domain you give.
  When the dump was exported from a server over SSH, **Also copy the uploads**
  brings the files themselves from that server after the import: off unless
  you tick it, for the last 3 or 12 months or all of them. It reads only on
  the server (`du` for the size, `rsync` for the files, needed on both
  sides), only adds here, stops when all of them would not fit on this disk,
  and leaves PHP files, `.htaccess`, SQL dumps, links and the cache, log and
  backup folders of plugins on the server.
- **Build**: a checklist per repo lists every `composer.json` and
  `package.json` and ticks only the ones whose output the repo does not hold
  (`vendor/` or a build folder git ignores; never a wordpress.org plugin), with
  their build, prod or production script. Watchers are never offered. A
  script that runs a gulp task its gulpfile does not define (`gulp build` with
  no `build` task) is never picked: the row says so and you pick another, and
  a build that still fails that way says which task is missing. Builds
  run in their repo's folder with a Node from nvm, picked in this order: the
  one you choose on the build's row, the repo's `.nvmrc` or `.node-version`,
  what its `package.json` says (volta, `engines`, or a package that stops on
  newer Nodes: node-sass 7 runs on Node 16 at most), then nvm's default or the
  Node the panel runs on. The row shows the Node and why. A build that fails
  because of its Node, when nothing named that Node, runs once more on the one
  nvm has that fits (an older one for a package that could not compile, a
  newer one for a package that asks for it), and the output says so. A Node
  nvm lacks is yours to add: the output gives the `nvm install` command. The
  Node you choose is remembered with the repo's other answers.
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
