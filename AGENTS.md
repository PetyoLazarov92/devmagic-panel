# devmagic-panel

Browser control panel for local WordPress development on Ubuntu/Debian. A
Fastify server on `127.0.0.1` (behind Apache at `https://local.devmagic`)
serves a React UI and runs a fixed list of actions: certificates from a local
CA, Apache vhosts, `/etc/hosts`, WordPress installs. Root work goes through
one validated script, `dmp-root`. It manages this machine only.

## Commands

```bash
npm run typecheck     # tsc for shared, server, web and all tests, must pass
npm test              # Vitest with a fake executor, must pass
npm run test:scripts  # bats for dmp-root and install.sh, against temp trees and stubs
npm run lint:scripts  # shellcheck, must pass
npm run build         # shared, server (dist/), web (web/dist/)
npm run package       # pack the build into dist/devmagic-panel-<name>.tar.gz, as a release ships it
npm run dev:server    # API on 127.0.0.1:4710 (needs /etc/devmagic-panel/config.env or DEVMAGIC_PANEL_CONFIG)
npm run dev:web       # Vite on 127.0.0.1:5173, proxies /api to the server
npm run mockup        # the UI alone on sample data from web/src/mock/, no server
npm run build:demo    # the mockup as the public demo in dist-demo/, with its .htaccess
npm run demo:serve    # serve dist-demo/ with the same headers, on 127.0.0.1:4180
npm run screenshots   # assets/screenshots/ from the mockup, light and dark, through the system's Chrome
npm run ui:inventory  # every control the mockup's screens show into web/test/ui-inventory.json; -- --check lists what a change lost
./install.sh --dry-run  # print every system change the installer would make
./install.sh --uninstall --dry-run  # print what an uninstall removes, asks about and keeps
```

Node 22.13+ (see `.nvmrc`). `npm install` sets `core.hooksPath` to
`.githooks/`; the pre-commit hook runs the checks the staged files can affect:
typecheck and Vitest for TypeScript, bats and shellcheck for the scripts,
everything for `package.json`, the lockfile, `.nvmrc`, `scripts/php*` and any
file it does not know, nothing for docs only. `DMP_PRECOMMIT=all git commit`
runs everything; the test workflow always does. bats runs in parallel where
GNU parallel is installed. Skip with `git commit --no-verify`.

## Non-negotiables

1. **No shell, ever.** The server runs programs through the `Executor` in
   `server/src/exec.ts` with argument arrays. Never `exec`, `spawn` with
   `shell: true`, or a string built from input.
2. **Root only through `dmp-root`.** `scripts/bin/dmp-root` is installed
   root-owned in `/usr/local/lib/devmagic-panel/bin` and is the only command
   (with `wpcore`) in the sudoers rule. It validates every argument and takes
   every path from `/etc/devmagic-panel/config.env`, never from the caller or
   the environment. A new root operation is a new `dmp-root` subcommand with
   validation and a bats test. apt goes through it only for packages named
   `php<version>-<name>` from the sources apt already has (`php-install`,
   `php-package`, `php-upgrade`, `php-remove`, never a purge); adding an apt
   source (the ondrej/php PPA) is always left to a person with a password.
   New root scripts are only put in place by a release's `install.sh`, with
   the user's sudo password: in a terminal, or from the Updates page
   (`panel.installRelease` runs `install.sh --from-panel` in its own user
   unit, the password on its stdin through a FIFO). Never a passwordless way
   to replace `dmp-root` or anything the sudoers rule allows; that needs
   signed releases first.
3. **Only local names.** Domains and aliases must be `local.*`, `www.local.*`,
   `*.test` or `*.localhost` (`isLocalName` in `shared/src/actions.ts`, mirrored
   by `dmp_is_local_name` in `scripts/lib/validate.sh`). This keeps the
   passwordless rule from minting trusted certs for real domains. Change both
   together, with tests on both sides.
4. **Every change is a registry action.** `shared/src/actions.ts` defines id,
   title, description and zod input; `server/src/actions.ts` has the handler.
   The API route, the UI and the later AI tools all come from that entry.
   Input that fails the schema never reaches a command.
5. **The system is the source of truth.** Sites, aliases and certs are read
   from vhosts, `/etc/hosts` and the cert folder. Extra metadata only goes in
   `sites.json` or the panel's database (how each site was installed, install
   drafts, repo presets). Nothing hardcodes paths that `config.env` holds.
6. **Tests never touch the real system.** Server tests use `fakeExec` and
   `tempTree` (`server/test/helpers.ts`). bats tests point `DMP_CONFIG` at a
   temp tree and stub Apache and system commands. `install.sh` is tested with
   `--dry-run` and a `sudo` stub that fails if called.
7. **Secrets stay local.** The panel password is a scrypt hash and the MySQL
   admin account, the SQL runner's read-only account (`devmagic_panel_ro`,
   SELECT and SHOW VIEW only), the optional Anthropic API key and the SSH
   passwords you chose to save for a server live in
   `~/.config/devmagic-panel/secrets.json` (0600). The key and the passwords
   never go back to the browser (only whether one is saved), and the
   assistant's settings and saved passwords are never registry actions.
   Updates need no token: the panel reads its releases through public HTTPS,
   the GitHub CLI or git (`server/src/release-source.ts`), and gh and git keep
   their own sign-in, which the panel never reads. Site repos are listed the
   same way (`server/src/repo-hosts/`): GitHub through gh, GitLab (gitlab.com
   and your own hosts) through `glab api --hostname` only; the panel never
   reads glab's config, keyring or token either, and never sets one.
   A plugin's or theme's details (`server/src/wporg-details.ts`, the
   dialog wp-admin calls "View version details") are asked of WordPress.org
   by slug only, when you open them, and read into plain blocks on the
   server, so none of its HTML reaches the browser.
   The vulnerability check (`server/src/vulnerabilities.ts`, off until
   switched on in Aura) sends WPVulnerability only slugs WordPress's own update
   check found on WordPress.org, never a version, a site name or a custom
   plugin's name; versions are compared here.
   When no MySQL account you have signs in, `setup` can make the panel's own,
   `devmagic_panel@localhost`, with `sudo mysql` on the terminal (sudo asks
   for your password; never through the sudoers rule) and a generated
   password (`server/src/mysql-admin.ts`).
   Passwords go to MySQL through `MYSQL_PWD` or stdin, and to WP-CLI through
   stdin (`--prompt`), never argv. Run history stores any input field called
   `password`, and a row's values and keys (`rowKey`, `rowKeys`, `rowValues`,
   `rowWas`) and SQL that writes (`sql`), as `(hidden)`, and an http(s)
   `url` or `link` without its query (signed links carry tokens there). Never log them or send them to an AI.
   A slow query's sample (`server/src/mysql-slow.ts`) holds real values: it
   goes to the browser only, shown on request, never stored or sent to an AI.
   The panel password changes in the panel (the current one first) and resets
   on the login page with the computer password: `sudo -k -S -v` on stdin,
   offered only where sudo asks this account for a password, behind a global
   lock (`GlobalLock`, 5 failures, an hour); both are plain routes, never
   registry actions, and answer a wrong password with 403, not 401.
   The sudo password for an update is never saved: the panel drops it once it
   reaches install.sh, or once the download before it fails, and install.sh keeps it in a shell variable only (never
   exported, a file or argv) until it ends, then runs `sudo -K`.
8. **Localhost only.** The server binds `127.0.0.1`, refuses unknown `Host`
   headers (421) and cross-origin unsafe requests (403). Keep both checks.
9. **No em dashes anywhere**: UI copy, docs, comments, commit messages. Use a
   comma, a colon, or two sentences.
10. **Bump the version on every change**, once per session: `package.json`,
    the README badge and `CHANGELOG.md`. The README is the short tour and
    `docs/` holds the detail: a README feature line stays under 25 words, and
    the detail goes to the docs page and the CHANGELOG.
11. **No new runtime dependencies without a reason.** Run history uses
    `node:sqlite` on purpose. The SQL runner's editor is CodeMirror 6, in the
    web app only and loaded with the SQL view: a code editor with
    suggestions is not worth writing by hand. The Files tab's editor is the
    same CodeMirror with its language packages, loaded with the editor.
    Prefer what Fastify, zod and
    React already give.
12. **Respect the existing setup.** The panel lives next to sites made by hand
    or by devmagic:
    - **A site is a domain, or a domain and a path**: a WordPress install a
      vhost serves under an `Alias` is its own site (`path: '/learn'`), and
      every WordPress-level action takes that optional `path`; Apache-level
      ones (cert, hosts, vhost, removal) stay with the domain. Its folder is
      `WEB_DIR/<mountFolder(domain, path)>`, and a panel vhost lists it with
      `vhost-write --mount`: pass the existing mounts (`mountArgs`) whenever
      the panel rewrites a vhost, or they are lost.
    - **Vhosts are left as is** unless their first line is the panel's marker
      (`dmp_vhost_require_managed`). For other sites the panel only reissues
      the cert and manages the hosts line, unless you take one over
      (`site.takeOver`, `dmp-root vhost-adopt` after a `--check` preview): its
      files are kept root-owned with checksums in `$STATE_DIR/taken-over`,
      only its names, folder and paths reach the panel's vhost, and
      `vhost-release` (`site.giveBack`) puts them back. A folder with another
      name right in `WEB_DIR` is used only when its registry entry and its
      takeover record both name it (`dmp_site_folder`).
    - **Hosts entries live in one marked block** (`# BEGIN devmagic-panel` ...
      `# END devmagic-panel`), one line per site keyed by its primary domain.
      Lines outside the block are never changed, but for one case: taking
      over a site (`vhost-adopt`, or `hosts-adopt` for a site taken over
      earlier, as a step of its move to nginx) moves the lines that name only
      that site into its takeover record, and `vhost-release` puts them back
      where they were.
    - **A PHP of its own goes through PHP-FPM**: a site with a version or
      settings of its own gets the pool `dmp-<folder>` in
      `/etc/php/<version>/fpm/pool.d` (written by `dmp-root php-pool-write`,
      the record of which site runs what) and one block in Apache's
      `devmagic-panel-php.conf`; only for a folder right in `WEB_DIR`. Other
      sites run on mod_php, or once `dmp-root php-switch-fpm` turned it off,
      on the default version (`$STATE_DIR/php-default`) through a handler at
      the end of that conf, phpMyAdmin through its own pool; a new install
      without mod_php starts that way. Settings per version go in the panel's own
      `99-devmagic-panel.ini`; php.ini is only replaced by the packaged one
      when you move its changes into the panel's settings.
    - **nginx runs next to Apache, never in its place**: `dmp-root
      nginx-setup` moves Apache's `ports.conf` from every address to
      `APACHE_ADDRESS` (127.0.0.1, the original kept in `$STATE_DIR/nginx`),
      turns Debian's default nginx site off and writes
      `conf.d/devmagic-panel.conf` (the panel's marker, the record that nginx
      is set up), so nginx answers on `NGINX_ADDRESS` (127.0.0.2), both on
      ports 80 and 443; `nginx-teardown` puts it all back, once no site runs
      on nginx. A site goes to the server its hosts line points at:
      `hosts-add` reads the address from the system (an
      enabled `nginx-site-write` file of the panel's for the domain means
      `NGINX_ADDRESS`), never from the caller. A site on nginx has
      `sites-available/<domain>.conf` with the marker, a `# kind:` line and a
      `# mount: /path=folder` line per site under its paths (served with
      `alias`, each through its own upstream), and its PHP through the upstream `dmp-php-<domain>` in
      `conf.d/devmagic-panel-php.conf` (its pool or the default version's
      FPM), written with Apache's PHP conf. `site.setServer` moves a site;
      every rewrite of a site's config goes through `siteWriteArgs`, so it
      lands on the server that has the site, with its `# rule:` and
      `# htaccess: /folder <sha256>` lines (`ruleArgs`): rules the panel
      translated from the site's .htaccess files (`sites/htaccess-rules.ts`)
      into a few fixed kinds that dmp-root checks field by field and writes
      itself, never nginx text, and applied only after you review them
      (`sites/htaccess-watch.ts` notices changes and says so, never applies;
      Not now is kept in the panel's database). A
      site can also have nginx in
      front of its Apache vhost (`site.setServer` with `nginx-apache`,
      `nginx-site-write --upstream apache`): a file with `# mode: apache`,
      `# static:` and `# apache-path:` lines (folders with an .htaccess of
      their own, checked by dmp-root), proxied to `APACHE_ADDRESS:443` with the
      site's name, so Apache reads .htaccess and runs its PHP; `vhost-write`
      keeps that file's names in step and `vhost-remove` refuses while it is
      there, and the panel's `devmagic-panel-remoteip.conf` trusts
      X-Forwarded-For from `NGINX_ADDRESS` only. The panel, phpMyAdmin and vhosts
      made by hand stay on Apache; nginx configs made by hand are only read,
      and one that listens on port 80 or 443 off nginx's address makes the
      setup refuse with its name.
    - **wpcore is shared**: one `/etc/wpcore.conf` and its cores folder for the
      CLI and the panel. Never a second config or cores folder.
    - **The old devmagic CLI is left alone**: no warning, and never edits to
      its files.
    - **The panel adds two files to a site, both mu-plugins**, both listed in
      the repo's local `.git/info/exclude` (never `.gitignore`) through
      `installMuPlugin` and both inert on a non-local address: the login
      helper `devmagic-panel-login.php` (only one-time tokens the panel stores
      for 60 seconds) and Local mode `devmagic-panel-local.php` (mail to
      Mailpit, noindex, a Local label, blocked hosts, logins from this computer
      only, `FS_METHOD` direct when
      wp-config.php has none, missing uploads from production for vhosts
      made by hand, each repo in `wp-content/repos` with a theme in a folder
      of its own as one more themes folder (`themeFolders`, read from the
      disk, so the theme keeps the name the database has and no link or
      database change is needed), and on a network a My Sites menu that
      scrolls and has a filter). Local mode is on for new
      sites and offered as an Aura fix for existing ones, never added
      silently. The panel never writes a file of its own into a repo: the
      wizard's answers per repo live in the panel's own database, and a
      committed `.devmagic.json` is ignored. `.htaccess` is written
      only when the site has none (installs, or the Aura fix), with
      WordPress's own rules, and kept out of git locally; an existing or
      tracked one is never changed. The local helper plugins (Query Monitor
      and the like) are only turned on when the repo already has them and
      you tick them; the panel never downloads one into a site. BE Media
      from Production, when the repo has it and you pick it, gets its
      `BE_MEDIA_FROM_PRODUCTION_URL` in wp-config.php (never over one
      already there). Plugins the site's database has (active, or installed
      on production by WordPress's update check) that its files lack may be
      installed from WordPress.org only, by slug, when you tick them
      (`site.installPlugins`, the wizard's Missing plugins): one at a time,
      a failure noted and the rest installed, `--skip-plugins
      --skip-themes`, checked with `wp plugin verify-checksums` and kept out
      of git locally (`sites/install-plugins.ts`); never a zip, URL or path,
      never activated by the panel. Themes the site's sites use that the
      files lack install the same way (`installThemes`, no checksums to
      check). The ones WordPress.org does not have
      (paid and custom ones) may be copied from the site's own server over
      SSH when you tick them (`site.copyFromServer`,
      `sites/server-files.ts`): what arrives is checked before it is
      unpacked (nothing outside its one folder, no hard links, links
      dropped), never written over a folder that exists, and kept out of git
      locally; never mu-plugins, drop-ins or core. Plugins and themes with an
      update WordPress already found are updated only when you ask
      (`site.updatePlugins`, `sites/update-plugins.ts`): `wp plugin update`
      and `wp theme update` as you, one at a time, each folder copied into
      the file trash first for Undo and put back when the update fails or a
      plugin's checksums do not match; only real folders in
      `wp-content/plugins` and `wp-content/themes`, never a link, a
      one-file plugin, mu-plugins or drop-ins. No other file goes into a
      site.
    - **Repos go where you place them**: each repo of an install has a folder
      of the site and a folder name (`dir`, `folder` in `site.create`),
      cloned as you, never through a link (a shared core's `wp-admin` is one)
      or into a folder that holds files; a repo inside another is listed in
      that one's local `.git/info/exclude`. Core or uploads in a repo get a
      warning, not a refusal. A repo runs only when it is from your
      organizations or groups, your CLI listed it, or you trusted its owner
      (`server/src/repo-trust.ts`). A dump from a URL comes through
      `fetch-dump.ts` only: https, public addresses checked on connect, no
      shell, and every dump's type is read from its first bytes. A dump over
      SSH (`sites/more-dumps.ts`) uses your own ssh config with BatchMode and
      StrictHostKeyChecking, sftp for a file and only `wp db export` for an
      export, with a path of plain characters; WP-CLI's command there is `wp`
      or the plain program name or path you give (`wpCliCommand`). Copying
      plugins and themes from the server only reads there too: `wp plugin
      path`, `wp theme path` and their lists, and `tar` of one folder with a
      plain name to stdout. Uploads come only when you ask
      (`site.copyUploads`, `sites/server-uploads.ts`, off by default, never as
      part of a database refresh):
      `du` reads their size and `rsync` brings them, only adding here
      (`--ignore-existing`, never a delete), without PHP files, links or
      plugins' cache and backup folders. A server that asks for a
      password gets the one you give for that run (`sites/ssh-password.ts`),
      handed out once, or else the one you saved for that host
      (`ssh-saved.ts`, in secrets.json, saved only when you press Save and
      shown back never): either reaches ssh through its askpass helper and a
      FIFO only you can open, never argv, the environment, a log, run
      history or an AI, and one prompt is allowed. How a server signs you in
      is asked when you type a host or press Check connection, and kept an
      hour, never on opening a view; Test password signs in once with the
      typed or saved password and runs only `true`. Nothing is written on the server, no
      key is added there, and the host key is still checked.
    - **Removed sites go to the trash first**, made by the panel or not:
      `dmp-root trash-site` archives the folder (`WEB_DIR/<domain>`), the
      vhosts (`<domain>-ssl.conf` or `<domain>.conf`), the certificate and the
      exported database into the root-owned `$STATE_DIR/trash/<domain>-<stamp>`
      with checksums, and `trash-remove` removes the site only once that
      archive checks out. Sites in another layout are left to a person.
      A reinstall (`site.create` with `replaceExisting`) and a restore over a
      site that exists again (`trash.restore` with `replaceCurrent`) archive
      the current site the same way first (`sites/archive.ts`, its reason in
      the archive), and Undo puts it back. Archived copies are purged after
      14 days. Snapshots the panel takes itself before a change
      (`<stamp>-before-*.sql.gz`) keep the newest 3 per site and the last 30
      days (`panel-storage.ts`); yours, clean copies and dmp-restore's backups
      are never removed on a timer. The panel's timed work runs through
      `Chores` (`chores.ts`) so the Sanctum page lists it, each run kept in
      `chore_runs` (the newest 20 per task), and the programs it runs are
      listed by name, command word and what started them only (`running.ts`:
      a job, a task, or a page's route as the server defines it with the
      local site it names; a failure's reason only from a fixed list or
      MySQL's error number; the last 50 worth a look in memory, quick page
      reads only counted, slow or failed ones in the panel's log), never
      their arguments or output. Panel versions it does not run are kept
      packed (`packOlderReleases` in `update.ts`) and unpacked before a
      switch. The database is dropped last; a database user
      is dropped only when it is the per-site user the panel made, never a
      shared account like `root`. Hosts lines outside the panel's block stay.
      Panel-made folders are listed in the root-owned registry
      `$STATE_DIR/sites/<domain>` (path and device:inode), so nothing of the
      panel's sits in the folder.
    - **The Files tab works as you, inside the site's folder**
      (`server/src/sites/files.ts`, `file-changes.ts`, `file-transfer.ts`,
      `file-find.ts`): no root and no `dmp-root` command. A path is checked
      as written and again after links are followed; a link that leaves the
      folder is shown and never followed or written through, except reading
      a shared core. Nothing is written over: a taken name is refused, and a
      save of a file that changed on disk asks first. Nothing is saved until
      you press Save. Delete moves the entry to the panel's own file trash
      (`<dataDir>/file-trash`, outside the site, 14 days, 1 GB at most) with
      Undo. An archive is read before it is unpacked (nothing outside its
      new folder, links left out, 1 GB at most). Permissions come from a
      fixed list (`FILE_MODES`: never one that lets everyone write, never a
      typed number, a folder only `FOLDER_MODES`, not recursive). Find and
      git only read (`grep`, `git status`, `git diff`), and a saved PHP file
      is checked with `php -n -l`, which never runs it. File contents, a
      diff included, go to the browser only: every `file.*` action is in
      `ASSISTANT_EXCLUDED_ACTIONS`, and run history stores what was saved as
      `(hidden)`. Uploads from production (`sites/uploads-compare.ts`) only
      reads on the server and only adds here; a file that changed there is
      replaced only when you switch that on, through the file trash.
    - **Cron is your crontab only**: the panel's tasks live in one marked
      block of the panel user's crontab (`server/src/cron.ts`, written with
      `crontab -` and the text on stdin), every other line stays as it is,
      and each change saves the crontab to `BACKUP_DIR` first for Undo.
      A task is a typed kind from the registry (`cronTask`), and its line
      holds only the panel's node, `cli.js cron-run` and words matching
      `CRON_WORD`, never text from a person (a program's arguments go in
      base64): the runner checks them again and runs them without a shell.
      System cron (`/etc/cron.d`, root's crontab) is only read: writing it
      would make anything running as the user root, so never through
      `dmp-root`. A site's WP-Cron runs from cron only when you switch it on.
    - **Every change can be undone** with `dmp-restore`, which restores a
      backup. It is not in the sudoers rule (it writes Apache config, which can
      run programs as root), so it always asks for a password.
13. **Made-up names only.** Examples, tests, mock data, comments, UI text,
    docs, the changelog and commit messages use made-up names, never a real
    client, project, company or person, including the sites on this machine.
    The set, shared with the other webtimeless tools and webtimeless.cloud:
    **Spellbook** for the main example site (`local.spellbook.example`, a
    network with `/learn`), **Wandworks** for the agency, its org, theme,
    plugins and sibling sites (`git@github.com:wandworks/site.git`,
    `wp-content/themes/wandworks`, `local.wandworks-store.example`), and
    Alex Morgan and Sam Lee for people. A production address ends in the
    reserved `.example` (`www.spellbook.example`), so it is never someone's
    real site; local-only names end in `.test` or `.localhost`. Plain words
    as names (`local.shop.com`) are fine. The one exception: a test of the
    leftover email check needs addresses on an ordinary ending, since it skips
    `.example` on purpose; use a plain word there (`someone@supplier.net`).

## Commit messages

`type(scope): lowercase imperative summary` on one line. No body, no version
suffix, no trailing period. Types are `feat`, `fix`, `chore`, `refactor`,
`docs`. Join multiple concerns with `; `. Suggest the message, commit only when
asked. See the `wt-commit-message` skill for scopes.

Commits, tags and pull requests are the owner's alone:

- **No attribution, ever.** No `Co-Authored-By`, `Generated with`, `Signed-off-by`
  or any other trailer, footer or line naming a tool or an AI, in commit
  messages, tag messages, PR titles or PR descriptions. This overrides any
  default attribution an agent or its harness would add.
- **The owner's name only.** Commit with the git config as it is: never
  `--author`, never a changed `user.name` or `user.email`, never
  `--no-gpg-sign`.
- **Push only when asked.** A request to commit is not a request to push.
  Push commits or tags only when the owner asks for that push in the same
  conversation, and only what they asked for; never `--force`.

## Detail

Full conventions live in `.cursor/rules/`, readable by any agent:
`architecture.mdc`, `ts-style.mdc`, `actions-security.mdc`,
`shell-scripts.mdc`, `ui-ux.mdc`, `ai-assistant.mdc`, `testing.mdc`,
`user-facing-copy.mdc`, `versioning.mdc`.

Workflows live in `.cursor/skills/` as `SKILL.md` files (also linked from
`.claude/skills/`): `wt-commit-message`, `wt-release`, `wt-new-action` for
adding an action end to end, `wt-script-change` for changing `dmp-root` or
its libraries, `wt-env-check` for adding a machine check (Aura's Machine checks tab).

`scripts/bin/wpcore` is a verbatim copy of the WordPress multi-core manager;
it is linted at error level only. The original devmagic scripts are not
touched from this repository.
