# New site

[Docs](README.md) › New site

The new site wizard starts four ways: **from a git repo and a database dump**,
**a fresh WordPress**, **an empty site**, or **from an organization or group**.

## From a repo and a dump

- **The repo**: paste a repo URL and pick one of its real branches (the
  default one first). The wizard fills itself from your last install of that
  repo: the panel remembers its answers, and nothing is written into the repo.
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
  long list), and the local helpers the repo has (as a plugin folder or in
  `composer.json`) are turned on.
- **Uploads**: missing images load from the production domain you give.
- **Build**: a checklist lists every `composer.json` and `package.json` in the
  repo and ticks only the ones whose output the repo does not hold (`vendor/`
  or a build folder git ignores; never a wordpress.org plugin), with their
  build, prod or production script. Watchers are never offered. Builds run
  with the Node the repo's `.nvmrc` or `.node-version` asks for, from nvm,
  else nvm's default or the Node the panel runs on (the panel's service has no
  nvm in its PATH).
- **Core**: the newest core you have is picked unless you choose another.
- **Web server**: once nginx runs next to Apache, Apache, nginx in front of
  Apache, or nginx with the PHP-FPM version it would run on.
- **Admins**: a dump's admins are listed (a network's super admins; the scan
  reads up to 16 GB of SQL for them), and one-click login signs you in as the
  first. An admin for this copy (admin / admin, superadmin on a network) is
  made only when you switch it on, or when the dump has none.

## While it installs

- Each step shows its output and progress (clone, import, replace). The header
  lists running installs, so you can leave and come back; at most two run at
  once, and free disk space is checked first.
- A failed install can be retried from its step or undone.
- A failed step the site works without (the build, the local helpers, BE
  Media, `.htaccess`, flushing caches, the admin account) can be skipped: the
  install goes on, and the site's page keeps what is left to do, each with a
  **Done** button once you did it yourself.
- Go back a step and the steps you reached stay open until you change an
  answer; put it back and they open again.

## Install drafts

The wizard saves its answers (never a password) as you go, from the moment you
continue from Start. Each draft has its own address
(`/sites/new/<draft>/<step>`), so the browser's Back and Forward move between
its steps and a link opens it again. Unfinished installs are listed on the
Sites page, to continue or discard, for 24 hours after the last change; while
an install runs its draft stays, and once the site is in place the draft and
its dump go.

Reinstalling over a site that is there archives the current one first, after
you confirm; see [Undo and backups](undo-and-backups.md).

## From an organization or group

Optional. This start opens once Claude Code is installed and signed in
(`claude auth login`); until then the card says what is missing. Sign in with
your claude.ai account, with Asana, Google Drive and Google Docs connected
there, and the card gets an animated border: that sign-in is what reaches the
linked tasks and files.

1. **Organization or group**: the GitHub CLI (`gh auth login`, its own browser
   sign-in) lists the GitHub organizations you belong to, and the GitLab CLI
   (`glab auth login`, `--hostname gitlab.wandworks.test` for your own GitLab) the
   GitLab groups you can clone from, on gitlab.com and on the hosts you add
   under **Your own GitLab hosts**; tick the ones to scan.
   - A GitLab group is scanned with its subgroups, so only the top group you
     belong to is offered, and a project shows with its path in the group
     (`clients/site`).
   - Your own account on each host is listed too, ticked for you once per host,
     the first time that host's CLI is signed in. **Shared with you** lists the
     repos you were added to outside those: GitHub repos you collaborate on,
     GitLab projects outside your groups.
   - Repos show what each holds (WordPress site, theme, plugin) and whether this
     machine has it installed, archived or as an unfinished install.
   - The list is kept in the panel's database and shows at once. Opening the
     page checks for new pushes when the last check is over an hour old
     (usually one page of GitHub's REST API), and once a week, or with
     **Rescan all**, every repo is listed again so deleted and renamed ones go.
     A repo is looked into again only after a push (on GitLab, after any
     activity; checks read 70 minutes back, as GitLab moves that time about
     once an hour).
   - The panel only runs `gh` and `glab`; it never reads their tokens. Without
     the CLI the last list still shows and installs, as cloning uses git, or
     you paste a repo URL from any git host.
   - Installed sites need none of this: their Git card reads the site's own
     `.git` and the repos inside it, whatever the host. A host whose name does
     not say what it runs (`git.wandworks.test`, or an SSH alias like `gitlab-work`)
     is found once a week with `ssh -G` and the same SSH hello `git fetch`
     makes, so its links and merge requests are right without a setting.
2. **Read the repo**: Claude Code reads only the repo's docs and build files
   (README, `docs/`, `composer.json`, local dev configs; never `wp-config.php`
   or `.env`), copied into a folder of their own, and fills a fixed form,
   mostly to find where the database dumps are: the Asana and Google links and
   what the docs say about dumps, plus versions, build and the production
   address. Each answer names the file it came from. Then it says that the
   next step checks your access to those links.
3. **Links and dump**: Claude Code opens each link read-only and marks it ok,
   no access or not found, collects facts for the install, and lists the
   database dumps in Google Drive by name, size and date only. Pick one:
   rclone downloads it (with a free space check), or you download it in the
   browser and pick it from your Downloads folder, or upload it.
4. **The usual steps follow, filled in.** The dump is the source of truth, as
   in an install from a git repo and a dump: the domains, the network and its
   sites come from it, and its **Found in the dump** card shows what it holds.
   The docs' production address is only offered for missing images when the
   dump is already a local copy. Your local setup wins over the docs (local.*
   names, wpcore, the cores you have, Apache), the differences are listed, and
   what nothing answered stays empty for you. The site shows "From an
   organization" on the Sites page.

Steps 2 and 3 run as jobs: leave the page and they keep going, show in the jobs
list, and the wizard picks up their answer when you come back. A card beside
them sets the model, effort and spending cap for the next Claude Code step of
that install. The defaults per step live under **Settings**
(Read the repo: Sonnet, medium effort; Links and dump: Sonnet, low effort;
$0.50 per run), with **Check connectors** to see that Asana and Google are
reachable. Runs have only read-only tools.

The panel stores no token for any of this: Claude Code, `gh` and rclone keep
their own sign-ins, and the panel runs them as you without reading them. The
Machine checks in Aura show whether each is set up and signed in.
