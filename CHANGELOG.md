# Changelog

### v1.48.1 (2026-11-14)
* **Command palette:** the list scrolls with the arrow keys, so the one you move to is always in view, with its group's heading at the top
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.48.0 (2026-11-14)
* **Sanctum:** the vulnerability check is a background task: while it is on in Aura it looks hourly whether a day passed since the last round and checks then, so a restart or a closed Aura never skips a day, with its last runs and Run now, which checks at once. **Watching all the time** lists the .htaccess watcher of the sites on nginx, and Background tasks links to the crontab tasks in Services, Cron
* **Developer options:** the services include nginx, cron and PHP-FPM of each version that has it. What the panel makes is in three groups: its data (now with the Files tab's deletes, MySQL settings backups, profiles, tools, caches, snapshots and Undo copies), the system files dmp-root wrote for PHP, Apache, nginx and MySQL with its state, and other things it made: its crontab block, the MySQL accounts it signs in with (names only) and how many sites have its mu-plugins
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.47.1 (2026-11-14)
* **Sanctum:** opens on Running now, with Background tasks second and Storage third. Storage is at `/sanctum?view=storage`
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.47.0 (2026-11-14)
* **Storage:** the panel versions it does not run are kept packed, with gzip at its best: about 12 MB each instead of 86 MB. A daily background task packs them, and switching back to one unpacks it first, in a few seconds. Updates marks them packed, with Unpack it for one whose installer runs in a terminal
* **Sanctum:** a program says its command (`git status`, `wp plugin list`), which page started it ("Sites › local.spellbook.example › plugins"), and why it failed in a few words ("table not there", "not a git repository"), from its exit code and MySQL's error number, never its arguments or output. Alike ones share a line, and the page reads that went well are a table with how many times, the average and the slowest
* **Sites:** the sites list no longer asks MySQL about a site whose database is not there, which made several reads fail every time it refreshed
* **Databases:** each change under Changes you can undo says what it changed, and opens to show the row's key and each column before and after, which is what Undo puts back. Read from the saved copy when you open it, in the browser only
* **Check again:** turns until the answer is in, then says Checked. On Plugins and Themes it asks WordPress.org for updates; on Aura's vulnerability check it asks again about answers older than an hour; on WP Cores it says when WordPress.org did not answer. It now works on a MySQL database's page, reads the MySQL settings and Top queries too, the WordPress database view's time is right after it, the Developer page reads the open log again, and Plugins, Removed sites and Downloads say when a read failed instead of showing an empty list
* **Command palette:** on a site's page Ctrl+K lists every tab and view of the site (Database › SQL, Backups and tools, Themes); another site's are found by its name and the view
* **New site:** Test password, Save and Forget saved password sit on one row under the password field
* **Services:** nginx's configs link to their site's page and open the site, as Apache's vhosts do now too
* **Layout:** the top bar has the page's width, so the search and the buttons on the right line up with the page
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.46.0 (2026-11-13)
* **Sanctum:** click a background task for its last runs: when, what it did or why it failed, and how long it took. The newest 20 per task are kept in the panel's database, so they are there after a restart too
* **Sanctum:** Running now has a card of its own for **Recently finished**: the last 50 programs of jobs and background tasks, and page reads that failed or took 5 seconds or more, with how long each took, how it ended and what started it. Page reads that went well are only counted per program, so a site's page starting several at once never pushes a job's out, and those running at once share one line. All of it stays in memory until the panel restarts, by name only, never arguments or output
* **Log:** a program that runs 30 seconds or more, or fails for a job or a background task, gets a line in the panel's log with its name, what it ran for and how it ended, for finding out later what was slow or failed
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.45.3 (2026-11-13)
* **Sanctum:** **Clean up now** on a storage row removes all of that kind now, after a confirmation that says what goes: the snapshots the panel took before a change (yours stay), downloaded dumps, the Files tab's deletes, MySQL settings backups, every finished run, or every kept database, listed with its site. What a job or a draft still uses stays. Deleted sites open Removed sites, where each can be deleted. The background tasks' **Run now** still removes only what is past its time
* **Sanctum:** a background task that found nothing past its time says so, and Drop expired kept databases says how many are kept and when the oldest goes; a kept database that cannot be dropped now shows the task as failed, with why, instead of passing it by each hour. The Kept databases row says when the oldest goes
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.45.2 (2026-11-13)
* **Updates:** the cards line up as in Settings. With nothing new, the installed releases and how updates arrive are one height, their notes at the bottom, and opening a release's changes grows both. With a release to install, its notes reach down to meet the right column; opened further, only they grow, and the installed releases stay in view as you scroll
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.45.1 (2026-11-13)
* **Dependencies:** hono 4.13.18, which the MCP SDK brings along. Its security fixes are in parts the panel does not use (it serves itself with Fastify and runs its MCP server over stdio), so nothing changes in how it works
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.45.0 (2026-11-13)
* **Sanctum:** a new page (`/sanctum`, and the heart icon in the top bar) shows the panel's inner workings, a short answer in four tiles and then one list at a time: the programs it has running for which job (names only, never their arguments), its background tasks with what each last did, when it runs next and **Run now**, and the space each kind of thing takes (snapshots, clean copies, backups for Undo, deleted sites, downloads, panel versions, Mailpit, Run history) with how long it stays and **Clean up now**; the kinds no task clears say why and link to where you manage them. It also says whether the run before stopped cleanly. The heart icon's card gives the short version: how the panel is (or what failed), what it works on by job or task, and its next task. Each background task is named by what it does (Remove expired install drafts, Check for a new release), one per kind, so Clean up now clears only its own row
* **Backups:** snapshots the panel takes itself before an import, a restore, a search and replace or updates keep the newest 3 per site and every one from the last 30 days; the older ones go once a day. Snapshots you take, clean copies and the backups dmp-restore uses stay until you delete them
* **Connection:** while the panel restarts (after an update) or Apache reloads, a page that reads asks once more after a second instead of saying "Failed to fetch", and the heart icon shows **Reconnecting...** until it is back. A change that lost its answer says it is not known whether it ran, with Activity to check
* **New site:** a repo's badge names the theme or plugin the way WordPress would, from its `style.css` or PHP header, with the version and a child theme's parent ("Plugin: Wandworks Blocks 1.4.0"), at the top of the repo or one folder down. Plugins without a `readme.txt` and block themes without `functions.php` are now found, so **Install to** picks Themes or Plugins by itself. A repo with no header says where it goes, and Review lists what each repo is
* **SSH:** **Test password** under a server's password signs in once with the typed or saved password and runs nothing there, so a wrong password shows before a run needs it. A host not in `known_hosts` yet says to answer yes to its key in a terminal and that the password prompt there can be closed
* **Updates:** reading releases over git works where git is set to `safe.bareRepository=explicit`: the panel's release cache is opened by its path, not found from its folder
* **Look:** Settings and Updates have the width of every other page: Settings pairs its cards, Updates puts the new release and its notes beside the installed releases
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.44.1 (2026-11-13)
* **Aura:** the vulnerability check runs again on the first visit after an update that keeps more in its results, instead of a day after its last round. Results from before v1.44.0 lack what **Update** needs, so Aura showed no Update until the next day; **Check now** did it at once. It asks WPVulnerability nothing new: its answers are still kept a day
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.44.0 (2026-11-13)
* **Aura:** a plugin or theme with a known vulnerability and a fixed version has **Update** on its line. It says first what happens (the newest version from WordPress.org with WP-CLI, a database snapshot first, the old folder kept so Undo puts it back), then starts the same job as the Plugins tab, with **Show progress** in the toast. One-file and must-use plugins and themes kept in a repo keep the hint to update them by hand. **Fix all** and the login briefing leave updates out, so they never start in bulk
* **Plugins:** the details window is wider and keeps one height from the start: the text scrolls and the facts stay in view
* **Look:** every dialog has × in its top right corner to close it. Full screen, where a dialog has it, sits just left of ×, so the two are no longer mistaken for each other
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.43.1 (2026-11-13)
* **Dependencies:** `@hono/node-server` 2.1.8, which the MCP SDK brings for its HTTP transport (security fixes in 2.1.6 and 2.1.7). The panel's MCP server uses the SDK's stdio transport, so the panel never loads it; this clears the alerts
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.43.0 (2026-11-13)
* **Plugins:** **View details** on a plugin or theme with an update opens what wp-admin calls "View version details": the changelog first, the versions this update brings in a box of their own, then the description, installation and FAQ. Beside them, the version, last update, installs and rating, and what it needs next to what the site has: PHP and WordPress below what it needs in red, a WordPress newer than it was tested with in amber. **Update to** sits at the bottom
* **Plugins:** the panel asks WordPress.org by slug only, when you open the details, and keeps the answer six hours. Its HTML is read on the server into plain paragraphs, lists, code and links, so nothing of it runs in the panel
* **Plugins:** the updates bar has its icon and reads like the missing plugins row above it
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.42.1 (2026-11-13)
* **Sites:** the Sites list shows its cards two per row again on a wide screen, as in v1.41.0, with a wide card's facts in two columns so it has no empty half. The server a site runs on (Apache, nginx in front, nginx) is one of those facts instead of a badge. **Grid** and **List** have their icons back
* **New site:** the wizard has the width of the other pages
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.42.0 (2026-11-13)
* **Look:** the top bar runs the whole width, with the search on the left and what changes while you work on the right. Pages run up to 1600px, the Sites list with three site cards per row from about 1440px of content, and Settings, Update and the new site wizard stay narrow enough to read
* **Sites:** the side menu sits in a frame like the cards, each section with its icon and a little taller; the open view under a section is marked in darker text only. The tiles fill their row. Git takes the first row across, its recent commits beside the branch, and the cards below come in pairs of a kind, each pair as tall as each other. The Database's Overview and Backups and tools do the same, Import a database and Search and replace across their row, and a view's note sits on one line with Check again
* **SSH:** a server's password can be saved in the panel for that host, in `secrets.json` (readable by you only). It is never shown back: the field says one is saved, empty uses it, a new one replaces it, and **Forget password** removes it. A run that starts without a typed password uses it, a Retry too. How a server signs you in is asked when you type a host or press **Check connection**, not when you open a view, and the answer is kept for an hour
* **Plugins:** plugins and themes with an update WordPress already found have **Update to** on their row and **Update all** above the list, with **Snapshot the database first** ticked. Each is updated from WordPress.org with WP-CLI, one at a time; its folder is kept in the Files tab's file trash first, so **Undo** puts the version from before back, and one that fails or does not match WordPress.org's checksums is put back at once. The Overview's updates count opens the list on them
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.41.0 (2026-11-12)
* **Sites:** the open section's own views (the Database's Overview, Tables, SQL and Backups and tools; Plugins and Themes; Browse and Uploads from production) are listed under it in the side menu, which stays in view as you scroll, and the breadcrumbs name the view. On a narrower screen they stay small tabs
* **Sites:** the cards of a site's sections lay out by the room next to the side menu, not by the window: one column until there is room for two, so no card is squeezed. The Files card keeps the folder on one line, and Quick actions fits its buttons
* **Sites:** the Git card of a site with several repos shows one at a time, with small tabs to switch. Themes have Compact and Details, as Plugins do
* **Services:** PHP settings fold their groups: Limits and every group with a value set here open, the rest folded with what is inside. Top queries show 10 at a time
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.40.0 (2026-11-12)
* **Look:** every screen is made of one set of parts: cards with the same header, body and footer, notices (the only tinted boxes, one tone each), status badges in the same colour for the same state, fact lists, rows, tiles, links that say when they open a new tab, one spinner and a fixed set of text sizes. Worded third buttons have a light fill, so they read as buttons
* **Sites:** a site's sections run down the side of its page on a wide screen, every badge in view and nothing under More; tabs on a narrower one. Breadcrumbs replace the back link on a site, a job, a run and New site, and a section's own views (Database, Plugins and themes, Files) are small tabs. The header keeps wp-admin and Open site, with VS Code in its menu
* **Services:** each service's card shows how it stands as a badge. The Plugins tab's Reload is Check again, as everywhere else
* **Mockup:** a Parts page (`/mockup/parts`) shows every part with its rule, and `npm run ui:inventory` lists every control the screens show, so a change that loses one is caught
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.39.0 (2026-11-11)
* **Sites:** a site's saved production server (its SSH host and WordPress folder) can be forgotten. **Forget** sits next to **Change** on the Database tab's From production, the Plugins tab's missing row and Uploads from production. All three then ask for a server again, and Undo in the toast saves it back
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.38.1 (2026-11-11)
* **New site:** a build script remembered from an earlier install of the repo, or named in its docs, that runs a gulp task its gulpfile does not define is let go: the build stays off until you pick another script, and that script is greyed out in the list with the task it lacks. v1.38.0 still took it from the remembered answers
* **New site:** such a build stops before `npm install` with why: the repo's build script cannot work as the repo has it, so skip the step and run the script that builds it, or fix the script in the repo. A build of a repo's own root names the repo's folder instead of "/"
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.38.0 (2026-11-11)
* **Plugins:** the check for missing plugins and themes reads every site of a network with one database query instead of WP-CLI twice per site, so a big network takes seconds, not minutes. It runs on the server: changing tab or page no longer stops it, and coming back shows how far it got. The result is kept for half an hour, with when it was checked and **Check again**, and a job that changes the site makes the next visit check anew
* **Plugins:** with **Details**, the author links to their site and the plugin to its own, with a **WordPress.org** link when WordPress's update check found it there. Themes show their description, author and the same links
* **Aura:** a daily check of the sites' plugins and themes for known vulnerabilities, through WPVulnerability, free and without a key. It is off until you switch it on in Aura. Only names WordPress.org lists are asked about and the versions are compared here, so custom plugins and your versions never leave the machine. What it finds shows in Aura by site, and as a **Vulnerable** badge on the Plugins tab with the fixed version and the advisory
* **Git:** **Tidy up** on the Git card fetches from origin with prune, offers to delete the local branches whose branch on origin was deleted (all ticked but the current one, and each says whether it is in the default branch) and packs the repo with `git gc`, saying the size before and after. Deleted branches are kept 14 days, so Undo puts them back. History is never rewritten
* **Sites:** the Overview's WordPress card sums up the plugins and themes: how many, how many on, updates and what the last check found missing, each a link to its view. The Files card links to the Files tab, and each folder in it has a Files link
* **Sites:** every site on the Sites page has a server badge: Apache, nginx + Apache or nginx
* **Web:** the rows a page picker in the database browser shows its whole number. In the Files tab the repo line and the time it was read sit on one line, lined up
* **New site:** a build script that runs a gulp task its gulpfile does not define, like `gulp build` with only deploy tasks, is no longer picked: the build's row says which task is missing and asks you to pick another script. A build that fails that way says so, instead of only gulp's last line, "To list available tasks"
* **Git:** the branch field on the Git card opens its list on a click, also right after a pick, while it still has focus; the arrow opens and closes it
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.37.0 (2026-11-10)
* **Sites:** taking over a site made by hand also takes its line in `/etc/hosts` that you wrote outside the panel's block. That line kept deciding where the site goes, so a site taken over could not move to nginx. It moves into the takeover record with its place in the file, the dialog shows it first, and Give back puts it back where it was. A line that also names another host stays, and the dialog says so
* **nginx:** a site taken over earlier, whose hand-made hosts line is still there, moves to nginx: the move takes that line into the takeover record first, as its own step, instead of refusing. A line the move cannot take is named in the refusal, with what to do
* **Sites:** where a vhost made by hand stops something (moving to nginx, the Domains tab, adding a domain from Aura, removal to the trash, a site under one of its paths), the panel says so with a **Take over...** link that opens the takeover dialog on the site's Overview. The Made by hand card lists what the panel does not do on such a site
* **Sites:** a site taken over that runs on nginx says that Give back waits until it is back on Apache, with the way to Server and PHP; Give back refuses before anything runs instead of failing in dmp-root
* **Web:** a network's card on the Sites page lines up its Multisite badge and the nginx badge, with room between them
* This release changes the root scripts, so the Updates page asks for your sudo password to install it, as for any release that does

### v1.36.1 (2026-11-10)
* **nginx:** moving a site to nginx no longer fails at Check that the site answers with `tlsv1 unrecognized name` while a Retry passes. A reload returns before nginx's workers have the new site, and until then nginx refuses its name; the check now asks again for a few seconds while the web server takes in a reload, as it already did while PHP-FPM starts
* **nginx:** a network whose sites live under paths more than one folder deep, like `/learn/potions/`, works on nginx. nginx answered 404 for such a site's `wp-includes` and `wp-content` files, so jQuery and the theme's scripts never loaded, because WordPress's own rule strips one folder only. The nginx file now takes the site's folders off at any depth. A network already on nginx gets the new rules when you move it to nginx again (Write the nginx site again)
* This release changes the root scripts, so the Updates page asks for your sudo password to install it, as for any release that does

### v1.36.0 (2026-11-10)
* **Web:** the menu folds to a rail of icons for a wider page, with the button at its bottom or Ctrl+B. Each icon names its page when you point at it, a dot marks news, and the panel remembers your choice
* **Web:** on a phone the menu is a drawer behind a button at the top left, with the theme switch, and the bar on top fits the screen. Nothing scrolls sideways any more
* **Web:** a site's tabs that do not fit the width go under **More** at the end of the row, with their badges added up, and the open tab always shows
* **Web:** suggestions from Claude Code wait behind a **suggestions** button in the bar, next to the jobs, instead of a box over the page. A new one says so once
* **Web:** the page behind an open dialog stays still. Any dialog that scrolls, or holds a long list like the .htaccess rules when you move a site to nginx, has the full screen button, and the list then takes the whole window. Full screen lasts while the dialog is open: the next one opens at its usual size
* **Files:** at the site's folder the places worth one click are tiles, each with a fact: how many themes or plugins, how big wp-config.php is, and debug.log in warning colour from 10 MB. The bar below has Upload, New file and New folder, and the search box sits under it
* **Plugins:** **Details** adds what each plugin says it does and who made it. A long list shows its first rows with Show more and Show all
* **Plugins:** Open folder on a theme opens its folder; it went to a folder that does not exist. A theme found in a repo through Local mode has Open folder too, and a plugin that is one file has Open file
* **New site:** **Go on without Claude** is a button next to Continue
* **nginx:** the search for .htaccess files reads only the top of page caches and uploads and none of the year folders of uploads, so large sites reach its limit of 5,000 folders far less often. When a site still goes over it, or over 500 rules, the dialog says which limit, and where the read stopped
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.35.0 (2026-11-10)
* **Files:** every site has a Files tab. It lists the site's folder one level at a time with name, size, date and permissions, folders first, sortable, with a filter for the folder and one-click places: wp-content, themes, plugins, uploads, each repo, wp-config.php and debug.log. `.git` and `node_modules` stay out until you switch on Show hidden. The folder is in the address, so Back and a reload land where you were
* **Files:** a file opens in place of the list: text with line numbers up to 2 MB, png, jpg, gif and webp as pictures, anything else with its facts and Download. A download is always saved as a file, never opened as a page
* **Files:** everything is read as you and stays in the site's folder. A link that leaves it is shown and not followed, except into a shared core's wp-admin and wp-includes, which are read only. The panel's two mu-plugins and files another account owns are marked
* **Files:** Edit opens a text file in an editor with line numbers, colours for PHP, JS, CSS, HTML, JSON and SQL, Ctrl+F and Ctrl+S. Nothing is written until you press Save, and Cancel leaves the file as it is. A save keeps the file's permissions and line endings, and stops when the file changed on disk since you opened it, with Reload from disk and Save anyway
* **Files:** New file, New folder, Rename, Duplicate, Move to and Copy to, from each row's menu or for the rows you tick. Nothing is ever written over, and a link that leaves the site is never changed
* **Files:** Upload, or files dropped on the list, puts up to 200 files of up to 1 GB each in the folder you are in, with progress. A name that is already there is left as it is
* **Files:** Download as zip for a folder or the rows you tick, Compress into a zip next to them, and Extract for zip, tar, tar.gz, tgz, tar.bz2 and tar.xz into a new folder. An archive is checked before it is unpacked: nothing leaves its folder, links are left out, and more than 1 GB is refused
* **Files:** a save of a file between 1 and 2 MB goes through, and after Save and Close the file shows what was saved
* **Files:** Delete moves the entry to the panel's file trash with Undo, and Changes you can undo lists the deletes of the last 14 days with Put back. A delete that would break the site asks first and says why
* **Files:** a WordPress site's Files tab has a second view, Uploads from production. It says what is here, and Compare lists what the site's server has without copying: each month of media, each site of a network, and the folders of plugins, with what is new, what changed and its size. See [Files](docs/files.md#uploads-from-production)
* **Files:** tick what to bring, or use All media, Last 3 months and Nothing. Originals only leaves resized copies on the server, and files over a size can be skipped. Folders with private data (form entries, order files, paid downloads) are off and warn when ticked. Bring only adds here, is refused when it would not fit with 1 GB to spare, and Stop keeps what came so a new run brings the rest
* **Files:** files that changed on production are listed. Bringing them is its own switch, off by default, and each replaced file goes to the file trash first, with Put back for 14 days. Files that are only here are listed and left alone. Nothing is written or deleted on the server
* **Files:** the box above the list also looks below the folder: Names below finds files and folders by name, Text in files finds lines in text files, each a link to the file at that line. Up to 200 results, without .git, node_modules and minified files, and a search keeps its address
* **Files:** in a git repo the bar names the repo and its branch, and each entry says modified, new, added, renamed or conflict, or changes inside for a folder. Changes on a file shows its diff since the last commit. git is only read
* **Files:** when a save finds the file changed on disk, See the difference shows what is on disk next to what you typed. After a save of a PHP file that does not parse, the panel says what PHP said and goes to the line; the save is never held back
* **Files:** Permissions, in a row's menu or for the rows you tick, sets 644, 640, 600, 755 or 750, each named with what it means. There is no number to type, so nothing can be opened to everyone for writing; a folder takes 755 or 750 only and only the folder itself changes; a link is refused
* **Files:** Measure in a folder's Size cell counts what the folder holds, everything below it, when you ask. Press / to go to the box and Escape to empty it and leave search results
* **Files:** the command palette has Files of each site, and each plugin and theme on the Plugins and themes tab has Open folder
* **Web:** a wrapped line of text no longer ends in a word or two on a row of its own, and headings split evenly
* **Web:** a row's menu opens next to its button near the bottom of a list too, instead of being cut off
* **Logs:** a line that names a file of the site, like `functions.php on line 28`, links to that file at that line on the Files tab
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.34.1 (2026-11-10)
* **Web:** the Database tab has nothing about uploads any more. The Uploads setting and **Copy uploads now** under From production are gone, and a refresh from production no longer brings uploads: it copies the database only. Uploads are copied from the new site wizard's **Also copy the uploads**, and the `site.copyUploads` action stays for the Files tab that is planned
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.34.0 (2026-11-10)
* **Sites:** a build picks its Node from the project, not only from `.nvmrc`: after the repo's `.nvmrc` or `.node-version` come `package.json`'s volta and `engines`, and packages known to stop on newer Nodes (node-sass 7 runs on Node 16 at most). A theme with node-sass and no `.nvmrc` now builds on the Node 16 nvm has, no longer on nvm's default
* **Sites:** a build that fails because of its Node, when nothing named that Node, runs once more on the one nvm has that fits: an older one for a package that could not compile itself, a newer one for a package that asks for it. `node_modules` is cleared first and the output says what happened
* **Sites:** the wizard's build rows show the Node each build runs on and why, and let you put it on another one nvm has. Your choice is remembered with the repo's other answers. A Node nvm lacks is still yours to add: the output gives the `nvm install` command
* **Sites:** missing plugins that WordPress.org does not have (paid and custom ones) can be copied from the site's own server over SSH. In the wizard, when the dump was exported from a server, the Missing plugins step asks that server what it has and offers **Copy from the server**; on a site's Plugins tab the same is offered for the server saved for Refresh from production. It only reads there (WP-CLI for the folder and the list, `tar` for one folder), checks what arrives before unpacking it, never writes over a folder that exists and keeps the copy out of git locally. See [Sites](docs/sites.md#plugins)
* **Sites:** missing themes are found too: the theme each site of the dump or database uses, and the parent a child theme needs, when no repo and no folder brings it. The wizard has a Missing themes list and the site's Themes view has a missing row. One on WordPress.org installs from there at production's version; a paid or custom one can be copied from the server like a plugin. Nothing is activated
* **Sites:** Refresh from production ends by naming the plugins and themes the new database uses that the files lack, and points to the Plugins tab's missing row. Nothing is installed or copied on its own
* **Sites:** uploads can be copied from the site's own server over SSH, off unless you ask. The wizard has **Also copy the uploads** when the dump was exported from a server; the Database tab's From production has an Uploads setting (not copied, the last 3 or 12 months, or all) that each refresh follows, and **Copy uploads now**. It reads only there (`du` and `rsync`), only adds here, checks the size against this disk, resumes after a dropped connection, and leaves PHP files, links and plugins' cache, log and backup folders on the server. It needs `rsync` on both sides
* **Web:** the Plugins tab is now **Plugins and themes**, with two views kept in the address, as the Database tab has. The new Themes view lists the site's themes, read only: which one is on, a child theme's parent, versions, updates WordPress found, and where each folder is, with a theme in `wp-content/repos` marked. Missing plugins sit in the Plugins view and missing themes in the Themes view
* **Web:** the missing row names the server it would copy from (SSH host and WordPress folder) with **Change**, and asks for both when none is saved. It is the server Refresh from production uses, saved once for the site
* **Web:** Missing plugins on a site's Plugins tab is one row under the search and filters, there from the start and always the same height: it says it is checking, then that nothing is missing or how many are, and opens on **Review**. The list no longer jumps down when the check ends
* **Fix:** site titles in Cyrillic and other scripts no longer show as question marks in the site list and the Network tab. The titles were read without naming a character set, and the panel's service has no UTF-8 locale
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.33.0 (2026-11-10)
* **Fix:** missing plugins install on a site whose `wp-content/upgrade` folder the web server made (WordPress's own updates do that minutes after an install). You cannot write in that folder, so every plugin ended in "No plugins installed". It is now moved aside for the run, in the same folder, and put back after as it was
* **Sites:** a plugin that was not installed says why (WordPress's own warning, like "Plugin not found." or "Could not create directory."), no longer only "No plugins installed."
* **Sites:** a build that fails because a package with compiled code (node-sass, most often) has no ready build for the Node in use says so, and that the repo needs an older Node in its `.nvmrc`, under the long compiler output
* **Sites:** a repo that keeps its theme in a folder of its own, with the tooling on top, is recognized as a theme. The wizard places it in `wp-content/repos`, and Local mode makes each repo there one more themes folder for WordPress. The theme is found under its own name, the one production's database has, so nothing is copied, linked or changed in the database and a refresh from production keeps working. It needs Local mode on
* **Sites:** a theme whose `style.css` the build makes is recognized as a theme, by its `functions.php`, `index.php` and a file only a theme has
* **Local mode:** its file is version 5. A site with the older one shows it as out of date, and Aura offers to rewrite it
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.32.2 (2026-11-10)
* **Fix:** a dump from MariaDB 10.10 or later imports into MySQL: it no longer stops with `Unknown collation: 'utf8mb3_uca1400_ai_ci'`. Those collations (`utf8mb4_uca1400_ai_ci` and the like) are translated to the `unicode_520_ci` collation of the same character set as the dump streams in, in table definitions and settings only, never in rows. It applies to every import: a new site, Import a database, a snapshot restore and Services, MySQL. A case-sensitive or accent-sensitive one becomes the plain `unicode_520_ci` too
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.32.1 (2026-11-10)
* **Sites:** a server over SSH can be on another port: type it after the host, like `alex@www.spellbook.example:2222`, in the new site wizard, a site's Import a database and Refresh from production. An alias from `~/.ssh/config` keeps the port it names there
* **Sites:** a server that names WP-CLI another way can be exported from: **WP-CLI has another name on the server?**, folded under the folder, takes its command, like `wp-cli` or `~/bin/wp`. Only a program name or path, never spaces or options. It is used for the export and for reading the tables, and saved with Refresh from production
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.32.0 (2026-11-10)
* **Sites:** a server over SSH that asks for a password can be used. The panel checks how the server signs you in as soon as the host is typed, and **Password on the server** shows under the host, in the new site wizard and in a site's Import a database, only when the server would ask for one; with your key signing in it says so and asks for nothing. Reading the tables, the export and the copy of a dump file then sign in with it, and Refresh from production has the same field
* **Sites:** the password is used for that run's connections only and is never saved, logged or shown: it reaches ssh through a helper and a pipe only you can open, and a Retry asks for it again. Nothing is written on the server and no key is added to it. A host that is not in your known_hosts is still refused, and a wrong password is tried once
* **Sites:** when a server refuses your key, the message says where to give its password
* **Databases:** Refresh from production has the administrator a cleaned copy keeps and its password together by the button, in place of the user in the settings form and the password outside it. On a network it says that user is a super admin
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.31.1 (2026-11-10)
* **Fix:** the wizard's Missing plugins are installed again. One plugin folder with a name WordPress.org could not have (capitals, a dot, a space), or more than 100 plugins, made the panel refuse the whole question to WordPress.org, so every plugin stayed on "Asking WordPress.org..." with no Install choice and none was installed. Such a name is now answered as not on WordPress.org, long lists are asked in parts, and the site's Plugins tab asks the same way
* **Sites:** when WordPress.org gives no answer, Missing plugins says so with **Ask again**, and **Leave it** and **Skip** are now **Don't install**
* **Sites:** the Code step lists your repos first, with the repos of this site and their branch and folder below, and says what the main repo is. **Make main** moves only that role: the repos no longer change places
* **Sites:** the folder or dump path of a server over SSH has the whole width of its form, and the form ends with its buttons: Export or Save, and Cancel beside Save, after the tables and the copy are chosen
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.31.0 (2026-11-10)
* **Databases:** one **Import a database** card on a site's Backups and tools in place of Import a dump, Refresh from production and Prepare from production. Production's saved server sits on top with **Refresh now**; below it a dump from any source, with **The copy**: **As it is** (an exact copy) or **Cleaned**. Clean this database stays a card of its own
* **Databases:** an import as it is keeps the site's tables from before for 7 days under Kept databases, as a cleaned one always did, so it can be put back after the job ends too. A database whose name has no room for that, or that cannot be swapped, goes as before
* **Databases:** a cleaned import can replace every mention of the production domains, not only URLs, as an import as it is could
* **Sites:** the new site wizard's Database step has the same **The copy** choice once the dump is in, with what a clean-up removes from that dump, in place of the Clean this copy checkbox
* **Sites:** From a project has one Claude step, **Claude reads the project**, in place of two: one job reads the repo and then checks the links its docs name. The repo's answer shows while the links are still checked, **Go on without Claude** leaves the step and **Skip the links** leaves only its second part
* **Sites:** one model, effort and spending cap for that step in place of two sets, under the switch on the Code step for one install and under Settings for all (Sonnet, medium effort, $1.00). Links are always checked at low effort and get what reading left of the cap. Settings saved per step carry over: the model and effort of reading the repo, and both caps together
* **Sites:** a draft that stopped on either of the two old Claude steps opens on the new one, with its answers kept, and an answer the draft keeps is never paid for twice
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.30.1 (2026-11-09)
* **Fix:** an export over SSH with WP-CLI no longer stops with `unknown variable 'tablespaces='`: WP-CLI turned the panel's switch into one mysqldump and mariadb-dump refuse, on a server or for Refresh from production. Tables whose rows are left out, over SSH or from another site on this machine, had the same fault and come with their structure again
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.30.0 (2026-11-09)
* **Fix:** a dump from a server over SSH works on hosts whose PHP turns `exec` and similar functions off: when WP-CLI stops there without a word, the export runs once more as `php -d disable_functions= <wp>`, for that one run only, and the job says so. Every export uses `--no-tablespaces`, so a host without the PROCESS privilege no longer refuses it
* **Sites:** an export over SSH is compressed on the way, and one without mysqldump's last line (a dropped connection) is thrown away instead of imported
* **Sites:** Choose tables lists a server's tables, biggest first with their size, to leave the rows of some there: known log tables are ticked for you, personal-data tables too for a cleaned copy, a table left out still comes empty, and the choice is remembered per server and folder. Another site's database on this machine takes the same choice
* **Sites:** the wizard's Database step can clean the copy after the import (Production copy, cleaned on the SSH option, or a switch for any dump): one user kept, the WordPress step's admin, and orders, customer data, reviews, form entries, logs and keys removed with SQL here
* **Databases:** Import a dump and Prepare from production take every source the new site wizard has: the Downloads folder, a cloud drive or Drive link, a public URL, a server over SSH with tables left out, or this machine, not only an upload
* **Databases:** Refresh from production on a site's Backups and tools: set up once with the SSH host, the WordPress folder, the tables to leave out and whether to clean, then one button exports production's database, reading only, and imports or cleans it from a side database, with Undo for an import and Put back for a cleaned copy. The settings hold no secret
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.29.2 (2026-11-09)
* **Fix:** a dump from a server over SSH that fails without a word no longer says only "ssh stopped": it gives the exit code, says WP-CLI on the server likely stopped on a PHP error (shared hosts often block mysqldump), and gives the `--debug` command to see why; an export that sends no SQL is caught too
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.29.1 (2026-11-09)
* **Fix:** on the Database step, A server over SSH has What to take and its choice level with the Host field, at the same height
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.29.0 (2026-11-09)
* **Sites:** plugins a dump has that none of the install's repos brings show on the wizard's WordPress step as Missing plugins: active ones on WordPress.org install from there after the import at production's version, others can be turned off or left, and ones production had installed but not active are listed apart. The next install of the repo ticks the same ones
* **Sites:** a site's Plugins tab has a Missing plugins card after a database import or a pull, to install the ones on WordPress.org, with Undo
* **Sites:** each plugin installs on its own: one that fails, like a premium plugin WordPress.org does not have, is noted and the rest go on; success is WP-CLI's exit code, nothing of the site is loaded, every plugin is checked against WordPress.org's checksums and kept out of git locally, and production's version falls back to the latest when it is gone
* **Sites:** the dump scan reads every plugin a dump names: the active ones of every site of a network and network-wide ones, and from WordPress's update check the ones installed but not active, with their version and WordPress.org slug
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.28.1 (2026-11-09)
* **Fix:** the Made by hand and Taken over card on a site's Overview has its icon on the right of its title, like the other cards
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.28.0 (2026-11-09)
* **Sites:** where a repo goes is now a folder of the site and a folder name, in place of the fixed whole site, wp-content, theme or plugin choice; the wizard picks it from what the repo holds, and the install clones each repo there, never through a link out of the site or into a folder that holds files
* **Sites:** a repo that holds WordPress core is used as it is, with no shared core and no download, and core or uploads in a repo get a warning instead of a refusal; with a shared core a repo cannot go into its `wp-admin` or `wp-includes`, which link to the core every site uses
* **Sites:** an install can clone several repos, each into its own folder, the site root first; a repo inside another one's folder is listed in that one's local `.git/info/exclude`, and the Git card finds repos in any folder an install cloned into
* **Sites:** the new site wizard starts three ways: From a project, Fresh WordPress or Empty site. From a project merges the git and dump install with the organization install: its Code step lists your GitHub organizations' and GitLab groups' repos to tick, several at once, or takes any pasted git URL, and keeps what you picked on top of the list and in a Where everything goes plan on every step
* **Sites:** Claude Code is optional in an install: a switch on the Code step adds its steps (it reads the repo, then checks the links), on by default once Claude Code is signed in and hidden without it; Settings sets it to always, off or never
* **Sites:** a Database step of its own takes the dump Claude found, an upload, your Downloads folder, any rclone remote (Google Drive, Dropbox, OneDrive, S3, SFTP, WebDAV and more) or a Google Drive link, a public https:// address, or no dump for a fresh install on the repo's code
* **Sites:** the Database step also takes a dump from a server over SSH, a file there through sftp or a fresh `wp db export` on the server, with your own SSH key and known hosts only; and from this machine: another site's database, a snapshot, or a deleted site's dump (`dmp-root trash-dump`, the archive stays)
* **Security:** a repo outside your organizations and groups runs only once you trust its owner, in the wizard or Settings; the install refuses it otherwise. A dump from a URL reaches only public addresses over https, with at most five redirects, a size limit and free space checked first, and the address's query never kept; every dump must start like SQL, a gzip or a zip, and a zip has only its .sql unpacked, after its size is checked
* **Settings:** Remembered for new installs lists what the wizard remembers per repo, to edit or forget, and Review has a switch to not remember an install's answers
* **Fix:** a removed site no longer leaves its .htaccess Not now, its cron tasks taken out and its WordPress report cache behind for a new site on the same domain: they move with the archive and come back on a restore, and the panel's records of an archive go once the 14-day purge removed it
* **Sites:** a site made by hand can be taken over from its Overview, after a preview of its vhost files, names, folder and every line the panel's vhost would not keep: the panel keeps its files, writes its own vhost, issues the certificate and adds the hosts line, so every feature works on it. It shows Made by hand, managed by the panel since its date, with a Taken over badge and filter on the Sites page, and Give back puts its own vhost back
* **Scripts:** `dmp-root vhost-adopt` and `vhost-release` take a site over and give it back, with its files kept root-owned and checked against their checksums; a site taken over keeps its folder's name, which the trash archives and restores
* **Docs:** New site follows the new steps: Code, Claude Code as an option, Database with every way to bring a dump, and what the wizard remembers per repo; the README's screenshots of the wizard are new
* **Panel:** dialogs come in four widths, from a short question to a table: the web server switch and the .htaccess rules review open wide enough for their options side by side, which stack on a narrow window
* The root scripts change, so the update finishes with its installer, which asks for your password

### v1.27.0 (2026-11-08)
* **Sites:** the panel watches the `.htaccess` files of sites on nginx while it runs and says when one changes: a notice on any page with Review, which opens the review of that site's rules. A change that leaves nginx's rules as they are, like a caching plugin saving its settings, stays quiet. Nothing is applied without the review
* **Sites:** the .htaccess rules card tells a change nginx needs (with how many rules to add or take out) from one it does not, and Not now puts a change off: Aura and the notices stay quiet until a file changes again
* **Mockup:** `?htaccess=change` in the address shows the notice of a change a moment after the page opens
* Nothing changes in the root scripts. An update installs this release from the panel as usual

### v1.26.0 (2026-11-08)
* **Sites:** moving a site to nginx alone translates its `.htaccess` files for nginx: redirects, rewrites, denied files and folders, security headers and error pages go into the site's nginx file. The dialog lists every rule with what it becomes, or why it stays out (WordPress's own rules, caches, PHP settings, conditions), and a tick leaves one out
* **Sites:** a site on nginx has an .htaccess rules card: each rule and whether its nginx file has it, Check again, and Copy nginx rules for a host's own settings. When an `.htaccess` changed since, Review and apply writes the rules again with Undo, and refuses a file that changed again during the review
* **Aura:** a site on nginx gets an issue while `.htaccess` rules wait to be applied, and one for the rules nginx does nothing with
* **Security:** dmp-root takes `.htaccess` rules of fixed kinds only, checks every field and writes the nginx itself, so nothing from an `.htaccess` reaches nginx as it is; `nginx -t` runs before every reload
* The root scripts change, so the update finishes with its installer, which asks for your password

### v1.25.0 (2026-11-08)
* **Sites:** a third web server for a site, nginx + Apache: nginx answers with the site's certificate and passes requests to its Apache vhost over HTTPS, so Apache still reads every `.htaccess` and runs its PHP, as hosts that put nginx in front of Apache do. No PHP-FPM needed, and the sites under its paths go along
* **Sites:** nginx serves images, CSS, JS and fonts that exist itself, but folders with an `.htaccess` of their own always go to Apache; a tick sends every request through Apache. The dialog lists the `.htaccess` rules about those files, which would not run otherwise
* **Sites:** the Web server card has one Change dialog with the three servers side by side, what each means, which hosts it is like and why a site cannot run on one. The wizard, the nginx tab's Sites card, the command palette and the sites list know all three
* **Aura:** a site with nginx in front of Apache gets an issue for `.htaccess` rules about files nginx serves (Send everything through Apache) and for a folder that got an `.htaccess` of its own (Write its nginx rules again)
* **Apache:** with the first site behind nginx, Apache sees the visitor's address through `mod_remoteip`, trusted from nginx's address only; turning nginx off takes it out again
* The root scripts change, so the update finishes with its installer, which asks for your password

### v1.24.2 (2026-11-08)
* **Mockup:** a public demo builds from it with `npm run build:demo`: static files with a banner that says it is sample data and links to the real panel, and an `.htaccess` with a strict CSP and noindex; `npm run demo:serve` serves the build the same way to check it
* **Mockup:** it shows the panel's own version, with two newer releases to update to, and `?proposals=none` starts with nothing suggested
* **Repo:** `npm run screenshots` takes the README's screenshots from the mockup in light and dark, through the system's Chrome; nine pairs now, with the database, SQL runner, performance, command palette and activity
* **Repo:** the sample data, tests and docs use one set of made-up names shared with webtimeless.cloud: Spellbook and Wandworks, with production addresses on the reserved `.example`
* Nothing changes in the installed panel. An update installs this release from the panel as usual

### v1.24.1 (2026-11-08)
* **Mockup:** the mockup (`npm run mockup`) has a page of its own, first in the menu, that says what it never touches on this machine, how it works and which addresses show other states; a link that would leave it shows the address it would open instead
* Nothing changes in the installed panel. An update installs this release from the panel as usual

### v1.24.0 (2026-11-08)
* **Databases:** a row's dialogs can fill the window, and the panel remembers it: viewing, editing, duplicating and adding a row, and a row of a SQL result, open full screen until you switch back
* **Databases:** a row's buttons stay below its columns as they scroll, so the last field no longer runs into them
* **Databases:** the SQL runner's earlier statements are under History, as wide as the editor, each on up to two lines with the whole statement on hover
* An update installs this release from the panel as usual

### v1.23.3 (2026-11-07)
* **Sites:** the PHP tab is now Server and PHP, with the web server first and Move to nginx or Apache there, out of Domains and SSL; a site without WordPress gets it as Server, and a site under a path says which server its domain runs on, with a link to change it
* **Sites:** the Overview's Server and PHP tile shows both, like Apache · PHP 8.3, and the command palette has Move to nginx and Move to Apache for every site that can move as it is
* **Install:** the installer's tests no longer read whether this machine has nginx set up (the installer takes its nginx folder from DMP_INSTALL_NGINX_DIR in tests). Nothing changes when it runs, so the Updates page's note to run the installer again can be skipped for this release
* An update installs this release from the panel as usual

### v1.23.2 (2026-11-07)
* **Sites:** the Profiles card has Check again even before the first profile, reads the list again when you come back to the panel's tab, and after Open and profile checks every few seconds until the new profile shows, for up to a minute
* An update installs this release from the panel as usual

### v1.23.1 (2026-11-07)
* **Sites:** the Performance tab lists the profiles Xdebug 3.5 writes: it names them with a dot in the time and the site's dots as _, which the panel did not read, so a profiled page never showed. Each is matched to its site by the longest known host, and the list shows the page without the trigger
* **Services:** Xdebug's gcstats mode can be switched on with the others; its files go to the panel's profiles folder, and with traces they are deleted after 3 days
* This release changes the root scripts, so the Updates page asks for your sudo password to install it, as for any release that does

### v1.23.0 (2026-11-07)
* **Databases:** slow queries, a database's tables and a site's scheduled events show their first 21, with Show more, Show all and Show fewer under the list
* **Databases:** Explain in SQL on a slow query opens the SQL view with its plan already shown, and the editor loads while you read the list, so it never opens on a plain box
* **Databases:** Explain takes an UPDATE, a DELETE, and an INSERT or REPLACE with a SELECT, by explaining the SELECT that finds the same rows, still as the read-only account; an INSERT that lists its rows says it has no plan
* **Databases:** Slow queries is now Top queries, and says where its numbers come from: MySQL's statement statistics, always on, every query ranked by its time in all, with no need for the slow log. The slow log's limit suggests 1 second for local work
* **Databases:** Table health is one list: each table that needs a fix once, WordPress's and plugins' or themes' alike, with its problems in a few words and Fix for that table; open a row to fix one problem, or Fix all for every table in one job, each saved first for Undo. Optimize is one line under it
* **Databases:** the count of rows to clean up above the WordPress view is the clean-up card's own, caches, logs and repeated meta included
* **Sites:** the Database tab opens on Overview, the WordPress view renamed, then Tables, SQL and Backups and tools; a site without WordPress opens on Tables, and old links to the WordPress view still work
* **Panel:** a link to a card on the same page (what needs a look, PHP's sections, unfinished installs) rings the card for two seconds after the scroll, so you see where you landed
* **Panel:** Activity's Jobs is a full-width table like Run history, with each job's site, its steps done and when it started, and a job's own page is as wide as a run's
* An update installs this release from the panel as usual

### v1.22.0 (2026-11-07)
* **Panel:** the menu comes in three groups, Work (Sites, Aura, Mail), Server (Services, WP Cores) and System (Activity, Updates, Settings), with every page still in view and a short hint or a live count on the right of each item: the sites there are, new mail, a newer release
* **Panel:** Settings is a page of its own, with the panel password, the AI assistant, Claude Code's defaults and the constants new sites get
* **Panel:** Activity holds Jobs and Run history as two tabs; Aura holds the machine checks of the old Environment page as its Machine checks tab; WordPress cores is now WP Cores. Old addresses go on to the new pages, so bookmarks and links still work
* **Sites:** removed sites are a Removed filter on the Sites page instead of the Archive page, never mixed with live sites: one line under the list says how many are kept, or how many match what you typed, with Show them
* **Sites:** a Performance tab holds a site's Xdebug profiles and its slow queries together, moved from the PHP and Database tabs
* **Databases:** the WordPress view and the MySQL page start with what needs a look, one link per card that found something, worst first: table problems, autoload over its limit, expired transients, plugin leftovers, rows to clean up, databases no site uses and users left behind
* An update installs this release from the panel as usual

### v1.21.0 (2026-11-07)
* **Databases:** Table health has Turn all into InnoDB for a site's MyISAM tables of every kind, WordPress's, plugins' and themes': one job, the smallest table first, each saved whole first, with Stop between two tables and one Undo for them all
* **Databases:** What plugins and themes keep (it was What plugins keep) looks for a table no name explains in the site's code, so a theme's own table, a must-use plugin's or a plugin's by another name gets its owner, and Delete is no longer offered for a table the theme in use or a must-use plugin makes. A table nothing in the code names says so
* **Databases:** the counts in What a clean-up would find and Transients are plain numbers that show as a link on hover, without the arrow after them
* An update installs this release from the panel as usual

### v1.20.0 (2026-11-07)
* **Command palette:** Ctrl+K runs quick actions as well as jumping: a site's clear cache, flush rewrite rules, snapshot, clear debug.log, terminal, fetch, pull and reissue the certificate (the open site's first), and reload Apache or nginx, restart a service and clear Mail, asking first where it matters. Mail, Archive, Jobs and Developer options are in it too
* **Databases:** Slow queries, a new view of a site's Database tab and a card on Services, MySQL, lists the queries that cost the most time, with runs, time in all and each, rows read for rows sent, a missing index hint, one real run on request and Open in SQL to EXPLAIN. MySQL 8 counts every query with nothing to switch on; on MariaDB the slow log, which now goes to its table too, is grouped by query. Start counting again measures from now
* **PHP:** Profiles on a site's PHP tab: turn on Xdebug's profiler for the site's PHP version (trigger only), open a page to profile it, and see its time by plugin and theme and its slowest functions with their callers, or download the file for KCachegrind or an IDE. Profiles go to the panel's own folder and are deleted after 3 days
* This release changes the root scripts, so the Updates page asks for your sudo password to install it, as for any release that does

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
* **Sites:** a site with WordPress installs under its paths (`local.wandworks.example/learn`) moves to nginx with them: each is served from its own folder with `alias`, its own PHP-FPM upstream (its pool, or the default version's), WordPress's fallback to its own `index.php`, and the same deny rules. A new site under a path of a site on nginx goes into its nginx file. Checked with nginx 1.24's own `nginx -t` and with requests against it
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
* **Sites:** repos inside a site's folder show on its Git card, each in a section of its own after the site's: wp-content, and each theme, plugin and must-use plugin folder with a `.git` of its own (`Theme: wandworks`, `Plugin: wandworks-blocks`). Each has its branch picker, ahead and behind, uncommitted changes, Pull, Fetch, Switch and its pull or merge requests, and the one the site was installed from is marked. Before, a site whose theme or plugin was its repo, as the panel installs one with the Theme or Plugin layout, showed no Git card at all
* **Sites:** the Sites list shows a site's own branch, or its first theme or plugin repo's when it has none, with how many more repos it has. A folder reached through a symlink is left out, and a site shows at most 20 repos
* **Sites:** the new site wizard, the organization list's "installed as" and the GitLab host checks count these repos too. The root scripts do not change: the Updates page installs this release as usual

### v1.4.0 (2026-11-06)
* **Sites:** installed sites on your own GitLab whose name does not say so (`git.wandworks.test`), on Gitea or Forgejo, or cloned through an SSH alias (`git@gitlab-work:wandworks/site.git`) get the right branch, commit and repository links and their merge requests with no setting. The panel resolves aliases with `ssh -G` and asks each unknown host once a week with the same SSH hello `git fetch` makes; no token, and no new host key is accepted for you
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
* **Sites:** a pasted repo URL in a GitLab subgroup (`git@gitlab.com:wandworks/web/site.git`) keeps its whole path, and the manual repo start says it takes any git host
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
