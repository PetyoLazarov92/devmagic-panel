# Changelog

### v1.19.2 (2026-11-07)
* **Databases:** the Tables list shows its first 21 tables, with Show 21 more and Show all under it; Find a table and the prefix filters still search every table, and say how many match
* An update installs this release from the panel as usual

### v1.19.1 (2026-11-07)
* **Databases:** Show all in the WordPress view is remembered per site (and site of a network) in this browser, so another site's cards open short instead of taking the last site's choice
* An update installs this release from the panel as usual

### v1.19.0 (2026-11-07)
* **Databases:** the WordPress view's long lists show their first 7 rows with Show all, remembered per list, so What plugins keep, Table health, Post meta by key and the rest stay short
* **Databases:** What a clean-up would find comes in four groups (posts, comments, caches and logs, what was left behind), with Keep for revisions right under its row, the repeated post meta search in its place, the kinds with nothing to clean on one line, and one Delete the ticked that runs as one job with one Undo
* **Databases:** a count in What a clean-up would find and Transients opens those rows in Tables, by the clean-up's own condition, with a chip saying what they are; an option, a meta key or a post type opens its table filtered on it
* **MySQL:** a Settings card shows the buffer pool, packet size, redo log, connections, temp tables, disk writes and the slow query log, with what an import holds raised and suggestions; a change applies at once and is kept for MySQL's next start in the panel's own file, with Undo
* **Environment:** MySQL memory for site data has a fix that sets the buffer pool, the same way
* This release changes the root scripts, so the Updates page asks for your sudo password to install it, as for any release that does

### v1.18.0 (2026-11-07)
* **Databases:** the WordPress view shows what it read last time at once, with when, and reads the parts that scan whole tables again only on Check again or after a job changed the site. Leaving the view stops its reads in MySQL too, and two asks for the same read share one
* **Databases:** a clean-up deletes in batches of 5,000 rows, each its own short transaction, with the rows done so far and Stop, which ends it after the batch it is on: Retry carries on and Undo puts back what it removed. It checks the disk has room for its copy first. Transients still go in one statement, a value with its timeout
* **Databases:** Table health checks the site's WordPress tables against how WordPress makes them: a lost primary key or AUTO_INCREMENT, a missing index, MyISAM or utf8, each with a fix that saves the table whole first. A key fix waits while duplicate or zero IDs are there; latin1 is only flagged. Tables with room to give back get Optimize
* **Databases:** What a clean-up would find adds oEmbed caches, Akismet's history, Action Scheduler's finished actions with their logs, expired WooCommerce sessions, saved login sessions, repeated post meta (looked for on request) and keeping the newest revisions of each post
* **Databases:** What plugins keep lists the tables that are not WordPress's own with the plugin each likely belongs to and whether it is on, off or gone, the options a plugin that is off still loads on every page (Turn off autoload, saved first), and posts of types nothing registers any more. What grows shows the tables that grew most, from a note of their sizes once a day
* **Panel:** a job keeps its place when you leave its page: open the page again and it is back in its card, and a toast says when a job you are not looking at ends. The panel no longer updates or restarts while any job runs, and a run a restart cut off says so in Run history
* **Environment:** MySQL memory for site data warns when InnoDB's buffer pool is far smaller than the sites' data, with the setting and the file to put it in
* An update installs this release from the panel as usual

### v1.17.0 (2026-11-07)
* **Databases:** the WordPress view shows in a moment on a big database: autoload, transients and users come first, and the clean-up counts and Post meta by key fill in their own cards as they are read, with a minute each instead of 15 seconds. Read again keeps the cards until the new counts arrive
* **Databases:** Post meta by key lists the custom fields that fill postmeta. Above 300,000 rows it counts them by rows first, as a size needs every value read, and **Count sizes** reads the sizes with up to a minute
* **Databases:** Turn off on a big autoloaded option works again. It said the site was busy with a job, because the action counted its own hold on the site as one
* **Databases:** the network site picker names a site by its path and prefix on one line, like `/outlet/ · wp_2_`
* **Panel:** pages and cards that load show the shape of what is coming, with what is being read, instead of a blank box: the WordPress and Tables views, a table's structure and rows, Services, the site's PHP, cron and compatibility tabs, Jobs, logs and the row editor
* **Sites:** the WP-Cron tile on the Overview keeps its place while WP-CLI reads it, and the Debug tile while debug.log is read, so the tiles no longer move
* **Panel:** a long choice in any dropdown is cut with an ellipsis when it is closed; the open list shows it in full
* **Panel:** a job shows inside the card whose button started it, under a line, on every page: the WordPress view, the SQL runner and Backups and tools no longer put it in a box of its own between cards, so the cards around it stay where they are
* **Databases:** Changes you can undo is the last card of the WordPress view at full width, as it already was under the tables, a table's rows and the SQL runner, and shows only while something can be undone
* **Panel:** a card on a narrow window no longer grows past its column when it holds a long name, like a clean copy's file name on Backups and tools or the cards of Services, PHP on a phone
* **Panel:** every page follows one layout for its kind (lists, a site or a job, status pages, tools, settings, data), with the same header, the same bar on a tab, the same notices and empty states, and **Check again** as the one button that reads a page again (it was Refresh on Mail and Read again on the WordPress view and MySQL processes)
* **Panel:** Run history, the Archive, WordPress cores, Mail, Aura, Environment, Developer options, Updates, Services, a job and a run show the shape of what is coming while they load instead of a line of text, and so do the PHP settings, phpinfo and the clean-up preview inside their cards
* **Databases:** Backups and tools has Check again for its snapshots, copies and kept databases, and the WordPress view says when it was read in the same bar
* **Sites:** the Config tab's cards say they apply to this site, and Mail and WordPress cores list a domain once when a site under a path shares it
* An update installs this release from the panel as usual

### v1.16.4 (2026-11-07)
* **Databases:** the tables list remembers Sort by name or size, after opening a table and going back, after a reload and in every browser you sign in from, kept with the panel's other view choices
* An update installs this release from the panel as usual

### v1.16.3 (2026-11-07)
* **Databases:** a serialized object with protected or private properties can be typed in Add a row, Duplicate or Change a row: type `\0*\0name` or `\0Class\0name` and **Turn \0 into NUL bytes** puts the NUL bytes PHP writes there in place of the typed backslash and zero, counts the lengths again, and is offered only when the value then reads
* **Databases:** Add a row flags a value that starts like a serialized array or object and does not read, as Change a row already did
* An update installs this release from the panel as usual

### v1.16.2 (2026-11-07)
* **Databases:** Change a row and Add a copy edit a value with NUL bytes or Windows line breaks in an editor that shows them as `\0` and `\r` and keeps them as they are. The plain text box hid NUL bytes and turned every `\r\n` into `\n` once you typed, which changed the value and broke a serialized one
* **Databases:** when a protected or private property of a serialized object loses a NUL byte around its name, the row editor names it and no longer offers Count the lengths again, which would have made it a new public property without a word
* An update installs this release from the panel as usual

### v1.16.1 (2026-11-07)
* **Databases:** a PHP serialized object's protected and private properties show by name with a protected or private tag, instead of the NUL bytes PHP keeps around them drawn as boxes, and the Text view writes those bytes and other control characters as `\0` and `\x1F`. Copy gives the real bytes, and so does text you select by hand: a browser drops NUL bytes from a selection, which broke the lengths of a pasted serialized value
* An update installs this release from the panel as usual

### v1.16.0 (2026-11-07)
* **Updates:** a release that changes the root scripts installs in one step: type your sudo password and click Install, and one job downloads it, checks it, unpacks it and runs its installer, with the progress on the Updates page. If the download fails, the job lets go of the password. Only download is still there for a terminal install
* **Updates:** a release downloaded from the panel shows as downloaded on the Updates page at once, after going back or a reload, without Check again, and a job from the Updates page has Back to Updates
* **Panel:** the browser and password managers (Chrome, Bitwarden, 1Password, LastPass, Dashlane) no longer offer to save the sudo password, the computer password for a reset, the Anthropic API key or the passwords of a new site and a WordPress user. Only the panel login is still offered, so a manager can fill it
* An update installs this release from the panel as usual

### v1.15.2 (2026-11-07)
* **Databases:** a click outside no longer closes Change a row, Add a copy or Add a row, and once you have typed something Escape keeps it open too and says that Cancel discards it
* **Panel:** no dialog closes any more when you select text in a field and let go of the mouse outside it

### v1.15.1 (2026-11-07)
* **Docs:** the README is a short tour again, a line per feature and a sentence per page, and the detail lives in `docs/`: installation and uninstall, your existing setup, sites, new sites, databases, services, the other pages, the AI assistant, undo and backups, updates, safety and troubleshooting, each linked from the README

### v1.15.0 (2026-11-07)
* **Databases:** Export over a database's tables downloads it as a .sql.gz, whole (with its views, routines and events) or the tables you tick, and a table's menu exports that table. mysqldump streams it straight to the browser, nothing is left on disk, and it has no CREATE DATABASE or USE, so it imports into any database
* **Services:** the MySQL tab has Import a dump: a .sql, .sql.gz or .zip into a new database, or into one no site uses, which is saved to the MySQL backups first (14 days) and emptied; Undo on the job deletes what it made or puts the old one back. The dump's own CREATE DATABASE, DROP DATABASE and USE lines are left out, so a dump made with --databases lands in the database you picked and changes no other
* **Databases:** every import runs mysql with --binary-mode, a site's Import a dump too: a line like `\!` in a dump fails as SQL instead of running as a command of the mysql client

### v1.14.0 (2026-11-07)
* **Sites:** the SQL runner has Can write next to Read only: one statement that changes rows (INSERT, UPDATE, DELETE, REPLACE) or a table, an index or a view (ALTER, CREATE, DROP, RENAME, TRUNCATE). Check and run first shows what it would change: the rows a change of rows changes, tried in a transaction that is rolled back (only on tables that can roll back), the tables saved first with their size and the disk's free room. With the database's name typed, a job saves those tables whole and runs it, a change of rows in one transaction. Undo, on the job and under Changes you can undo, puts the tables back as they were and deletes a table or view it made
* **Databases:** SQL that writes saves the tables it names, and any a foreign key cascades into, so a change to one table never copies the whole database. It refuses another database, accounts and rights, databases, files, routines and a second statement, and MySQL's own and kept databases stay read only
* **Services:** the MySQL tab has Processes: what MySQL runs now, the longest first, with idle connections and MySQL's own a tick away, and Stop for a statement (KILL QUERY), never one of MySQL's own threads
* **Sites:** with two filters or more on a table's rows, pick Match every filter (AND, as before) or Match any filter (OR). The bar over a table's rows has the filters on the left and what changes rows on the right (Delete the ticked rows, Add a row to wp_options with the table's own name), so adding a row no longer reads as adding a filter. Clean-ups you can undo is now Changes you can undo, with SQL that wrote in it too
* **Panel:** run history keeps no SQL that writes: it can hold data, so it is hidden like a password, and the job is named by its kind and tables

### v1.13.0 (2026-11-07)
* **Sites:** the Database tab's WordPress view cleans up: Delete expired transients or all of them, Turn off autoload for a big option (written as the site's WordPress writes it, on and off or yes and no), and tick revisions, auto-drafts, posts and comments in the trash, spam, and meta or terms left behind by something deleted, then Delete the ticked. A post goes with its meta, terms and comments, as WordPress deletes it; a link's terms stay. On a network each site's own tables are cleaned, and the network's transients and user meta with the first site
* **Databases:** a table's menu has Empty and Delete, with its name typed to confirm. Not for MySQL's own databases, the ones kept for a site, or views
* **Databases:** each clean-up is a job that first saves exactly what it removes (mysqldump with the same condition, as INSERT IGNORE, a deleted table with its CREATE TABLE) to `cleanups` in the backups folder, private to you, for 14 days, then removes in one transaction only the rows that copy holds. Undo is on the job and under Clean-ups you can undo, also after a restart: it puts the rows back and leaves a row made again since as it is, and makes a deleted table again only while no table of that name is there
* **Panel:** text buttons on the database screens have an outline, so they line up with the text around them and read as buttons before you hover
* **Sites:** the SQL editor sits in a box you resize by dragging its corner, and keeps that height in this browser; the plain text area that stands in while the editor loads has the same size, so nothing jumps when it takes over. Its focus ring is the panel's usual one, drawn around the whole box rather than cut off at its edges

### v1.12.0 (2026-11-07)
* **Sites:** rows change from the Database tab's Tables: Edit, Duplicate and Delete on a row, Add a row, and tick rows on a page to delete them together. Long values load in full before you edit them, a PHP serialized value whose string lengths no longer add up (or JSON that no longer reads) is flagged, with Count the lengths again, and NULL is a tick of its own
* **Databases:** a change applies only while the row still holds what you saw, so an edit made since is never overwritten. Each change saves the rows as they were to `row-changes` in the backups folder (private to you, 14 days) before the panel answers, and Undo, in the toast or under Changes you can undo, puts them back while they still hold what the change left. MySQL's own databases, the ones kept for a site, views, tables without a primary key, binary and computed columns stay read only, and a site's rows wait while a job works on it
* **Panel:** run history keeps no row values or keys: they are hidden like passwords
* **Sites:** the SQL runner has a code editor (CodeMirror 6, loaded only with the SQL view): MySQL keywords coloured and suggested, the database's own tables as you type and a table's columns after `table.`, Tab to take a suggestion or indent (Escape then Tab leaves it), brackets closed and matched, and Ctrl+Enter to run. Where it cannot load, the plain text area takes its place

### v1.11.0 (2026-11-07)
* **Sites:** the Database tab has an SQL runner: one statement that reads (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, TABLE or VALUES) against the site's database, Ctrl+Enter to run, Explain to see how MySQL would run it, up to 1,000 rows in a grid where a row opens with all its values (PHP serialized and JSON as a tree), CSV of the result, and the last 30 statements kept in this browser
* **Services:** each database under the MySQL tab has the same SQL runner next to its tables
* **Databases:** the runner reads as its own MySQL account, devmagic_panel_ro, which has SELECT and SHOW VIEW only, so MySQL itself refuses a change; it runs inside a read-only transaction, stops at 30 seconds (on the server too) and 4 MB, and a second statement, a client command like `\!` or a `/*!` comment is refused before anything runs. Setup makes the account, and the Environment page offers Make it when it is missing

### v1.10.0 (2026-11-07)
* **Sites:** a WordPress site's Database tab has a WordPress view: autoloaded options against Site Health's 800 KB limit with the biggest by name, transients (and the expired ones still stored), what a clean-up would find (revisions, auto-drafts, trash, spam, meta and terms left behind by something deleted), the postmeta keys that take the most room, and the users with their roles. On a network you pick the site, and its own tables are read. It only reads; a section MySQL stops for taking too long says so and the rest still shows
* **Assistant:** a database overview tool for the chat and MCP gives Claude a site's database in names, sizes and counts (the biggest tables and options by name, transients, clean-up counts, the biggest postmeta keys), never a value from a row, a user or an email

### v1.9.0 (2026-11-06)
* **Sites:** the Database tab opens on Tables: every table with its engine, rows, size and free space, a filter for this site's prefix and other prefixes, and each table's rows a page at a time (25 to 250), sorted by any column, with filters (is, contains, starts with, more or less than, NULL). A row opens with all its values; long ones load in full on request, and PHP serialized values and JSON show as a tree. Structure shows the columns, indexes, CREATE TABLE and what deserves a look (no primary key, MyISAM, an old character set, free space). Snapshots, import, search and replace and the other tools moved to Backups and tools on the same tab
* **Services:** each database on the MySQL tab opens its tables: a site's in the site's Database tab, any other (MySQL's own included) under the MySQL tab
* **Databases:** the browser only reads. Each read runs in a read-only transaction with a time limit (15 seconds, 5 for counting), its SQL on stdin; values go to MySQL as hex literals in the column's collation and names only once MySQL listed them, and a filter's value never reaches a URL. Open in phpMyAdmin goes to the database or table on a site Apache serves, when phpMyAdmin is installed

### v1.8.0 (2026-11-06)
* **Sites:** a site with WordPress installs under its paths (`local.acme.com/learn`) moves to nginx with them: each is served from its own folder with `alias`, its own PHP-FPM upstream (its pool, or the default version's), WordPress's fallback to its own `index.php`, and the same deny rules. A new site under a path of a site on nginx goes into its nginx file. Checked with nginx 1.24's own `nginx -t` and with requests against it
* **Sites:** the new site wizard asks which web server a site of its own gets, once nginx runs next to Apache: Apache, or nginx with the PHP-FPM version it would run on. The install writes the nginx file with WordPress's rules for what the dump is (a single site, or its kind of network). A site under a path runs on its parent's server
* **Services:** the nginx tab has a Sites card: how many sites run on each server, the web server the wizard picks for new sites, and Move every site to nginx or to Apache. That is one job that moves each site that can, one after the other, checks each, lists the ones that stay and why, and Undo moves every site back
* **Panel:** preferences load with their defaults filled in, so a setting a newer panel adds never comes back empty. The root scripts change, so the update finishes with its installer, which asks for your password

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
