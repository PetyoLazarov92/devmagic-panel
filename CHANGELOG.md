# Changelog

### v1.7.0 (2026-11-06)
* **Sites:** a site moves to nginx, and back to Apache, from the Web server card on its Domains and SSL tab. The panel writes the site's nginx file (WordPress's rules for a single site or its kind of network, the uploads redirect, the same certificate and folder), runs its PHP through PHP-FPM (its own pool, or the default version's), points its hosts line at nginx (`127.0.0.2`), checks the site answers there, and only then removes the Apache vhost. Back to Apache goes the other way round, and Undo on the job moves it back. Its folder, database and certificate never move
* **Sites:** nginx reads no `.htaccess`, so the move lists any rules beyond WordPress's (a cache plugin's section, redirects of your own) and asks you to tick that they do nothing there. A site made by hand, one with sites under paths, or one with a hosts line outside the panel's block stays on Apache, and the card says why
* **Sites:** a site on nginx has an nginx badge in the list, its errors under nginx errors on the Logs tab, and Aura flags a hosts line pointing at the other server, `.htaccess` rules nginx ignores, and nginx rules of another kind after the site became a network (with Write its nginx rules again). New aliases, the uploads redirect and certificate reissues write and reload nginx for it
* **Services:** Turn nginx off waits until every site is back on Apache, and names the ones that are not
* **Panel:** the trash archives and restores a site on nginx with its nginx file, certificates know nginx uses them, a PHP version or pool change follows on nginx, and the Environment page checks the hosts lines of sites on nginx. Uninstall moves every site on nginx back to Apache first. This changes the root scripts, so the update finishes with its installer, which asks for your password

### v1.6.0 (2026-11-06)
* **Services:** nginx runs next to Apache, both on ports 80 and 443, each on its own loopback address: Apache on `127.0.0.1`, nginx on `127.0.0.2`. A site then goes to the server its hosts line points at, with nothing proxied from one to the other. The new nginx tab (`/services/nginx`) shows how to install nginx, sets it up in one job (Apache restarts on its address, Debian's default nginx site goes off, every site is checked afterwards, Undo turns nginx off), writes its settings again, turns it off, and shows nginx -t, Reload, every config in sites-available and nginx's error log. Every site, the panel and phpMyAdmin stay on Apache for now
* **Services:** the Overview has an nginx card with its state, where each server answers, and Restart once nginx is set up
* **Panel:** the Environment page checks nginx once it is installed: set up, running, nginx -t, each server on its own address, and configs made by hand that listen on port 80 or 443 on every address, which keep nginx from starting next to Apache. Backups and `dmp-restore` cover nginx's sites, and `config.env` gets the nginx folders and both addresses
* **Installer:** offers nginx as optional and sets it up next to Apache, writes its settings again on later runs, and on uninstall puts Apache back on every address and stops nginx. This changes the root scripts, so the update finishes with its installer, which asks for your password

### v1.5.1 (2026-11-06)
* **Fix:** your own account is now ticked once per host, the first time that host's CLI is signed in. Before, ticking your GitHub account counted for every host, so signing in to the GitLab CLI later never ticked your GitLab account. Settings from before are read as GitHub done, so your GitLab account is ticked once glab signs in; an account you untick stays unticked
* **Sites:** Organizations and groups to scan says what each host still needs before it lists anything (`sudo apt install glab`, `glab auth login`, `gh auth login`), with Check again, and the organization step says so in one line while no GitLab CLI is signed in. Cloning needs only your SSH key; the CLIs only list repos. The root scripts do not change: the Updates page installs this release as usual

### v1.5.0 (2026-11-06)
* **Sites:** repos inside a site's folder show on its Git card, each in a section of its own after the site's: wp-content, and each theme, plugin and must-use plugin folder with a `.git` of its own (`Theme: acme`, `Plugin: acme-blocks`). Each has its branch picker, ahead and behind, uncommitted changes, Pull, Fetch, Switch and its pull or merge requests, and the one the site was installed from is marked. Before, a site whose theme or plugin was its repo, as the panel installs one with the Theme or Plugin layout, showed no Git card at all
* **Sites:** the Sites list shows a site's own branch, or its first theme or plugin repo's when it has none, with how many more repos it has. A folder reached through a symlink is left out, and a site shows at most 20 repos
* **Sites:** the new site wizard, the organization list's "installed as" and the GitLab host checks count these repos too. The root scripts do not change: the Updates page installs this release as usual

### v1.4.0 (2026-11-06)
* **Sites:** installed sites on your own GitLab whose name does not say so (`git.acme.test`), on Gitea or Forgejo, or cloned through an SSH alias (`git@gitlab-work:acme/site.git`) get the right branch, commit and repository links and their merge requests with no setting. The panel resolves aliases with `ssh -G` and asks each unknown host once a week with the same SSH hello `git fetch` makes; no token, and no new host key is accepted for you
* **Sites:** From an organization or group ticks your own account on each signed-in host the first time, so its repos list without a visit to Organizations and groups to scan. A list you saved stays as you left it
* **Sites:** a Shared with you entry per host lists the repos you were added to outside your organizations, groups and account: GitHub repos you collaborate on, GitLab projects outside your groups. Two repos of one name from different owners stay apart
* **Panel:** the Environment page's GitLab checks also cover the hosts found this way. The root scripts do not change: the Updates page installs this release as usual

### v1.3.0 (2026-11-06)
* **Sites:** a site's tabs come in a fixed order, in three groups with a line between them: Overview and Logs; WordPress and its data (Network, Plugins, Database, Cron, Config); the server (PHP, Domains and SSL). A tab a site lacks leaves the rest in place, and links like `?tab=database` open the same tab as before
* **Sites:** a tab's badge counts only what needs a look, colored by how bad it is: errors in debug.log, late WP-Cron events and failed cron tasks, local constants wp-config.php does not have yet, names the certificate or the hosts file leaves out. Config and Domains and SSL no longer show how many constants or names they list
* **Sites:** Overview starts with a tile for each other tab (debug mode and errors, the network, the database, WP-Cron, PHP, domains and the certificate) that opens it, then Git, quick actions and the WordPress core, then Local mode, uploads and the site's folders. Open in VS Code and Copy folder path are no longer in quick actions: they are in the header and its menu
* **Sites:** debug mode moved to the Logs tab, above debug.log: where errors go now, Log only and Off, and each constant behind Each constant. Local constants are on the Config tab only, and a network's sites have a Network tab of their own. An update installs this release from the panel as usual

### v1.2.0 (2026-11-06)
* **Sites:** the new site wizard installs from GitLab groups next to GitHub organizations, on gitlab.com and on your own GitLab, listed through the GitLab CLI (`glab`, 1.36 or newer) with its own sign-in, which the panel never reads. A group is scanned with its subgroups, only projects you can clone are listed, and two projects of one name in different subgroups stay apart. Add your own GitLab hosts under Organizations and groups to scan
* **Sites:** a pasted repo URL in a GitLab subgroup (`git@gitlab.com:acme/web/site.git`) keeps its whole path, and the manual repo start says it takes any git host
* **Sites:** the Git card shows open GitLab merge requests (`!12`) beside their branches, as it does pull requests on GitHub
* **Sites:** branch, commit and repository links know your own GitLab hosts, Gitea and Forgejo (Codeberg among them), and keep an HTTPS port; "Open on" names the host
* **Panel:** the Environment page checks the GitLab CLI and SSH on each GitLab host you use, found from the settings, the groups you scan and your sites' remotes, as optional warnings at most; nothing about GitLab shows when you use none
* **Installer:** reports the GitLab CLI as optional, with `sudo apt install glab` where apt has it and GitLab's install page elsewhere, and never installs it with the organization tools. The root scripts do not change: the Updates page installs this release as usual

### v1.1.4 (2026-11-06)
* **Panel:** the Updates page no longer shows "Installed" for an install with your password once a later update or a switch replaced that release. Before, after updating from v1.1.2 to v1.1.3 from the panel, it still said "Installed v1.1.2, replacing v1.0.5". A failed install still shows until a later install puts another release in. An update installs this release from the panel as usual

### v1.1.3 (2026-11-06)
* **Panel:** a job that restarts Apache, like making a PHP version the default, no longer stops at "Failed to fetch" while it goes on. The panel sits behind Apache, so the restart cuts it off for a moment; the job's view now keeps asking, after 1, 2, 4 and 8 seconds and then every 10, and shows how the job ended without a refresh. After two minutes without an answer it says the job goes on and to refresh. An update installs this release from the panel as usual

### v1.1.2 (2026-11-06)
* **Panel:** making another PHP version the default for every site works again when phpMyAdmin runs on the one before. The version before now reloads and lets phpMyAdmin's socket go before the new one starts; before, the new PHP-FPM would not start ("Another FPM instance seems to already listen") and every site without a PHP of its own answered 503. The same goes for a site's own pool moved to another version, and for going back to mod_php
* **Panel:** when the new version's PHP-FPM still does not start, the sites and phpMyAdmin go back to the version they ran on, and the message names its `journalctl` command. This changes the root scripts, so the update finishes with its installer, which asks for your password

### v1.1.1 (2026-11-06)
* **Panel:** after an install from the Updates page, the page now reloads as soon as the new version answers, so the version under your name changes with it. Before, when the new panel answered before the page saw the old one stop, the page kept waiting up to five minutes and still showed the old version until you refreshed it. The page that waits is the one from before the update, so this works from the next update on: after installing this one, refresh once if the old version still shows

### v1.1.0 (2026-11-06)
* **Panel:** a Cron tab on the Services page manages the tasks cron runs for you: a site's WP-Cron, a WP-CLI command (`action-scheduler run`, `cron event run <hook>`, `transient delete`, `cache flush`, or a command of the site's own), a PHP file in a site, a local URL, or a program with its arguments. Each has a schedule with presets, shown in words with its next runs, a time limit, an on and off switch, Run now, and a history of its runs with their output. The panel writes only its own marked block of your crontab; lines you wrote yourself are shown and never changed. Every change saves your crontab first, and Undo in the notice puts the panel's block back. System cron (`/etc/crontab`, `/etc/cron.d`, the daily and weekly folders) and the systemd timers are shown read only
* **Panel:** tasks run through the panel's runner, never a shell: cron calls `cli.js cron-run` with the task's checked arguments, it runs one at a time per task, stops one that takes too long, and keeps the last 100 runs and failed ones for 14 days. The Services overview has a Cron card
* **Sites:** each WordPress site has a Cron tab with its WP-Cron events (late ones marked, a search, WordPress's own apart from the plugins'), Run now and Delete for one event with Undo, its intervals, Check WP-Cron (`wp cron test`), and its cron tasks. The switch Run WP-Cron from cron instead of page loads adds a task every 5 minutes and sets `DISABLE_WP_CRON`; it is off for every site until you turn it on. On a network you pick the site whose events you see
* **Sites:** removing a site takes its cron tasks out of your crontab first, and restoring it from the Archive puts them back. Aura warns about a site with `DISABLE_WP_CRON` and no task that runs its WP-Cron, with the fix
* **Installer:** uninstalling takes the panel's block out of your crontab; your own lines stay. The root scripts do not change: the Updates page installs this release as usual

### v1.0.5 (2026-11-06)
* **Panel:** when installing a PHP version stops because apt would also bring in another version or mod_php, the advice now names only the packages without a version that can safely go: never `php-common`, which every PHP version needs, nor one another package needs, like `php-mysql` for phpMyAdmin. It now also names `php` and `libapache2-mod-php`, the two that pull mod_php in. Before, the advice could remove every installed PHP version and phpMyAdmin with it. The panel checks the removals together with the install, and says when removing them would still not be enough
* **Panel:** an update of a package already installed for another PHP version, such as the PPA's build of `php8.3-imagick`, no longer stops a PHP install; only a version or mod_php that is not there yet does. This changes the root scripts, so the update finishes with its installer, which asks for your password

### v1.0.4 (2026-11-06)
* **Installer:** when `apt-get update` fails, it says which package source on the machine failed, the file it is in and why (a missing signing key, no packages for this release, unreachable), instead of stopping on apt's own error. When the missing key is on the machine already, it shows the `signed-by=` that points the source at it, and for every source the command that turns it off for now. apt runs in English for this, whatever the system language. Only `install.sh` changes: the Updates page installs this release as usual

### v1.0.3 (2026-11-05)
* **Panel:** a tab the browser restores right after you log in, before the panel's service has started, now shows "Waiting for the panel to start" and opens the panel by itself once it answers. It tries again after 1, 2, 4 and 8 seconds, then every 10, and at once when you press Try now, show the tab again or the network comes back. Before, the tab stayed blank or showed "Cannot reach the panel" until you refreshed it
* **Panel:** the browser keeps the app's hashed files and checks the page itself on each load, so a restored tab gets the app from its cache while the panel starts. A page whose files did not load says so and loads again once the panel answers, instead of staying blank
* **Installer:** while the panel does not answer, its Apache vhost shows the same waiting page instead of Apache's "Service Unavailable", and asks the panel again on the very next request (`retry=0`). The vhost changes when this release's installer runs, which asks for your password as for any update that changes the root scripts

### v1.0.2 (2026-11-05)
* **Installer:** keeps `UPDATE_REPO` and `UPDATE_GIT_URL` in `config.env` when it runs again, so a panel pointed at a fork keeps updating from it after an update instead of going back to this repository. A value the panel would not accept is dropped with a warning. The Updates page installs this release as usual, and its installer already keeps them during that update
* **Internal:** the pre-commit hook runs only the checks the staged files can affect (none for docs, `DMP_PRECOMMIT=all` for every one), and bats runs its tests in parallel where GNU parallel is installed, about 25 seconds instead of 90; the test workflow still runs everything on every push

### v1.0.1 (2026-11-05)
* **Internal:** the tests never sign the git commits and tags they make in their own repositories, so they pass where the global git config signs every commit and no passphrase is at hand
* **Internal:** dependency updates: `@fastify/static` 10.1.10 with the fixed `glob` and `minimatch` (two medium-severity advisories), fastify 5.12.8, the Anthropic SDK 1.4.0, the MCP SDK 1.32.2 and smaller ones; the workflows run on `actions/checkout` and `actions/setup-node` v7

### v1.0.0 (2026-11-05)
* **Repo:** the first public release. Earlier versions were private and are not published; a panel on an earlier version updates to this one from its Updates page, and nothing changes in its setup
* **Sites:** every WordPress site on this machine at a glance, made by the panel or by hand: health, certificate, WordPress core, git branch, database, logs and how each site came here
* **Sites:** the new site wizard builds a site from a git repo and a database dump, a fresh WordPress, an empty folder or your GitHub organization, multisite and sites under a path of another site included
* **Sites:** SSL from a local CA, trusted in the system, Chrome, Edge and Firefox; Apache vhosts with the panel's marker and one marked block in `/etc/hosts`, while vhosts and hosts lines you made by hand stay as they are
* **Sites:** shared WordPress cores through `wpcore`, Local mode (mail to Mailpit, no indexing, logins from this computer only) and one-click wp-admin login, cache clearing, rewrite rules, debug settings, branches and pull
* **Panel:** databases with snapshots, restore, dump import, search and replace with a preview, and clean copies for the team without users, orders or keys
* **Panel:** PHP versions, modules and settings per version, and a PHP of its own for a site through PHP-FPM; Apache, MySQL and Mailpit on the Services pages
* **Panel:** Aura lists every problem on your sites and this machine with one-click fixes; removed or replaced sites stay in the Archive for 14 days, and system files are backed up before every change
* **Panel:** updates without a token, through public HTTPS, the GitHub CLI or git over SSH; light and dark themes, a phone-friendly layout, localhost only
* **AI:** an optional assistant with a briefing, a chat and an MCP server for Claude Code, where every change comes back as a card you run
* **Installer:** `get.sh` and `install.sh` with a dry run that prints every change, an uninstall that asks before it removes what you might keep, and a rollback when an update fails
