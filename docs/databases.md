# Databases

[Docs](README.md) › Databases

A site's **Database** tab has four views, in this order: **Overview** (what
needs a look first), **Tables** (the rows), **SQL** (queries on them) and
**Backups and tools** (upkeep). A WordPress site opens on Overview, any other
on Tables; an old link to the WordPress view opens Overview. Every other database on the server opens from
**Services → MySQL** with the same Tables and SQL views
(`/services/mysql?db=<name>`). MySQL's own databases and the ones the panel
keeps for a site are only read.

## Overview

What WordPress keeps in its database, for each site of a network: the first
view of a WordPress site's Database tab. The view
shows what the panel read last time at once ("Read 3 h ago" in its bar), reads
the quick parts again, and the parts that read whole tables only on **Check
again** or after a job changed the site; each of those fills its card in when
it is read, with up to a minute. Leaving the view stops its reads in MySQL too.
A long list shows its first 7 rows and **Show all**, which this browser
remembers per site: another site's lists open short. A name in a list (an option, a meta key, a post type)
opens its table in Tables, filtered on it; the filter's value goes with the
page's history, never its address.

- **Table health**: every table of the site that is not as it should be,
  once, with its problems in a few words: in WordPress's tables a lost
  primary key or AUTO_INCREMENT (a bad import's mark: new posts get ID 0), a
  missing index, MyISAM, or utf8 (utf8mb3); in plugins' and themes' tables
  MyISAM, marked not WordPress's. A lost key comes first. **Fix** on a row
  fixes everything the panel can on that table; open the row for each
  problem in full with its own fix. **Fix all** fixes every table in one
  job, the smallest first. Every fix saves the table whole first, so Undo
  puts it back; Stop ends Fix all between two tables. A key fix waits while
  duplicate or zero IDs are there, and says how many; latin1 is only
  flagged, since its text may already hold UTF-8 bytes a conversion would
  garble. Room a rebuild gives back (like after a clean-up) is one line
  under the list with **Optimize**: upkeep, not a problem.
- **Autoloaded options** against Site Health's 800 KB limit, the biggest by
  name, and **Turn off** for a big one (written as the site's WordPress
  writes it: on and off, or yes and no before 6.6).
- **Transients**, with the expired ones still stored, and **Delete expired** or
  **Delete all**.
- **What a clean-up would find**, in four groups. **Posts**: revisions (with
  **Keep** under the row: all of them go, or all but the newest 1, 3, 5 or 10
  of each post), auto-drafts and posts in the trash. **Comments**: spam, the
  trash and Akismet's history. **Caches and logs**, where the site has their
  tables: oEmbed caches, Action Scheduler's finished, failed and cancelled
  actions with their logs, expired WooCommerce sessions, saved login sessions
  (not ticked: everyone signs in again) and repeated post meta (**Look for
  them** reads every value of postmeta, with up to two minutes). **Left behind
  by something deleted**: meta and terms whose post, comment, term or user is
  gone. Kinds with nothing to clean fold into one line. Each count opens its
  rows in Tables with a chip like "Only: spam comments", built by the server
  from the clean-up's own condition, so what shows is what it would delete;
  deleting rows there takes only those rows, while the clean-up also takes a
  post's meta, terms and comments, as WordPress deletes it (a link's terms
  stay). One **Delete the ticked** runs every ticked kind as one job with one
  Undo.
- **Post meta by key**: the custom fields (`meta_key`) that fill postmeta, to
  see what makes it big (a page builder's data, an old plugin's leftovers).
  Up to 300,000 rows they come by size; on a bigger table by rows first, as a
  size needs every value read, and **Count sizes** reads the sizes anyway.
- **What plugins and themes keep**: the tables that are not WordPress's own,
  each with what it likely belongs to and whether that is on, off or gone.
  First by the table's name (known plugins, then the plugins folder); a table
  no name explains is looked for in the site's PHP code, as `wandworks_log` in
  `$wpdb->prefix . 'wandworks_log'` or its full name: one `grep` over the themes,
  must-use plugins and plugins finds the theme in use, another theme, a
  must-use plugin (always on) or a plugin by another name. A table nothing
  in the code names says so. **Delete** (type the name; saved whole first) is
  only for a table whose owner is not in use. Then the options a plugin that
  is off or gone still loads on every page, with **Turn off autoload**; and
  posts of types no plugin or theme registers any more (WP-CLI's list, with
  plugins loaded). These are guesses, said as guesses.
- The users with their roles.
- **What grows**: the panel notes the site's table sizes once a day when this
  view opens (30 days, names and sizes only) and shows the tables that grew
  most since.

Each clean-up and fix is a job that saves what it changes first; see
[Undo](#undo-and-saved-copies). A clean-up deletes in batches of 5,000 rows,
each its own short transaction, with the rows done so far and **Stop**: it ends
after the batch it is on, Retry carries on, and Undo puts back what it
removed. It checks the disk has room for its copy first. A job keeps running
when you leave the page: open the view again and it is back in its card, and
a toast says when one you are not looking at ends.

## Tables

- Every table with its engine, rows and size, with a filter for the site's
  prefix and other prefixes, sorted by name or biggest first. The sort is
  remembered with your other view choices, in every browser you sign in from.
  The list shows the first 21 tables, with **Show 21 more** and **Show all**;
  Find a table and the prefix filters search every table.
- A table's rows a page at a time (25 to 250), sorted by any column, with
  filters (is, contains, starts with, more or less than, NULL). With two or
  more, pick **Match every filter** or **Match any filter**.
- A row opens with all its values. Long ones load in full on request, and PHP
  serialized values and JSON show as a tree.
- **Structure**: the columns, indexes, `CREATE TABLE`, and what deserves a
  look (no primary key, MyISAM, an old character set, free space).
- **Export** the whole database (with its views, routines and events) or the
  tables you tick as a `.sql.gz`, streamed from mysqldump with nothing left on
  disk. It has no `CREATE DATABASE` or `USE`, so it imports into any database.
- **Open in phpMyAdmin**, on a site Apache serves, when phpMyAdmin is
  installed.

### Changing rows

**Edit**, **Duplicate** and **Delete** on a row, **Add a row to the table**,
and tick rows on a page to delete them together.

- Long values load in full before you edit them. NULL is a tick of its own.
- The button next to a row's title fills the window, for a row with many
  columns or long values. The panel remembers it: viewing, editing,
  duplicating and adding rows, and a row of a SQL result, open the same way
  until you switch back. The buttons stay below the columns as they scroll.
- A PHP serialized value whose string lengths no longer add up, or JSON that
  no longer reads, is flagged, with **Count the lengths again**.
- A value with NUL bytes or Windows line breaks opens in an editor that shows
  them (`\0`, `\r`) and keeps them as they are; a plain text box would hide
  the first and turn `\r\n` into `\n`. PHP keeps NUL bytes around the names of
  an object's protected and private properties: when one is deleted, the
  panel names the property and does not offer to count the lengths again,
  which would quietly make it a public one.
- A NUL byte cannot be typed: `\0` typed is a backslash and a zero. Type
  `\0*\0name` or `\0Class\0name` in a property name and click **Turn \0 into
  NUL bytes**: only those spots change, the lengths are counted again, and it
  is offered only when the value then reads. A new value that starts like a
  serialized array or object and does not read is flagged too.
- A change applies only while the row still holds what you saw, so an edit
  made since is never overwritten.
- Each change saves the rows as they were first, and **Undo** (in the toast or
  under **Changes you can undo**) puts them back for 14 days.
- Views, tables without a primary key, binary and computed columns stay read
  only, and a site's rows wait while a job works on it.

## Top queries

On a site's **Performance** tab, next to its profiles; for every database at
once, on Services, MySQL.

Every query the database ran, the most time in all first: a quick query that
runs a thousand times on a page can cost more than one slow one, and only a
ranking by total time shows it. Each row has how many runs, the time in all
and each, the slowest run, and rows read against rows sent, with **missing
index?** where a query reads far more rows than it returns or ran without an
index. A row opens the query whole, one real run of it with its values (shown
on request: it can hold data, and it is never stored or sent to an AI), and
**Explain in SQL**, which opens the SQL view with that run and its plan. The
list shows the first 21, with **Show more**.

- On MySQL 8 the numbers come from MySQL's statement statistics
  (`performance_schema`): always on, every query, nothing to switch on. The
  slow query log is separate and not needed; it can stay off.
- On MariaDB, or where those are off, they come from the slow log: switching
  it on in Services, MySQL also sends it to its table (`log_output =
  FILE,TABLE`), where the panel reads it. Its limit is 10 seconds by
  default; 1 second suits local work.
- **Start counting again** empties both, so a page loaded after it shows only
  its own queries: Start counting again, load the slow page, Check again,
  then Explain the top query. The panel's own reads are left out.

## SQL

One statement at a time, in a code editor: MySQL's keywords coloured and
suggested, the database's own tables as you type and a table's columns after
`table.`, **Tab** to take a suggestion (Escape then Tab leaves the editor),
**Ctrl+Enter** to run. Drag the corner of the box to resize it.

- **Read only** (the default): SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, TABLE or
  VALUES, as the read-only MySQL account, up to 1,000 rows and 30 seconds.
  **Explain** shows how MySQL would run it, **CSV** downloads the result, and
  the last 30 statements stay in this browser, under **History**, as wide as
  the editor (the whole statement on hover). Explain also takes an UPDATE,
  a DELETE, or an INSERT or REPLACE with a SELECT: MySQL explains those only
  to an account that may run them, so the panel explains the SELECT that
  finds the same rows (what makes them slow) and shows it above the plan. An
  INSERT that lists its rows reads nothing, so it has no plan.
- **Can write**: one statement that changes rows (INSERT, UPDATE, DELETE,
  REPLACE) or a table, an index or a view (ALTER, CREATE, DROP, RENAME,
  TRUNCATE). **Check and run** first shows the rows it changes (tried in a
  transaction that is rolled back, on tables that can roll back), the tables
  it saves first with their size, and the disk's free room. With the
  database's name typed, a job saves those tables whole and runs it.

The runner never touches another database, accounts, rights, routines or files.

## Backups and tools

- **Snapshots**: take, restore and download a snapshot of the site's database.
- **Import a database**: one card for every way a copy replaces the site's
  database. It goes into a side database and is swapped in at once, with
  MySQL's limits raised while it runs, production domains replaced with the
  site's (URLs only, or every mention when you tick it), and the tables from
  before kept for 7 days under Kept databases.
  - **From production**: set up once per site with the SSH host, the
    WordPress folder there, the tables whose rows stay there and whether the
    copy is cleaned; then **Refresh now** exports production's database over
    SSH, reading only, and imports it. For a cleaned copy the administrator
    it keeps and that user's password sit together by the button: the login
    is remembered for next time, the password never is. On a network that
    user is a super admin and an administrator of every site.
    Nothing is written on production, and the settings hold no secret: a
    server that asks for a password gets it for that one refresh, typed
    each time and never saved.
  - **From a dump**: a `.sql`, `.sql.gz` or `.zip` from any source the new
    site wizard has: an upload, the Downloads folder, a cloud drive or Drive
    link, a public URL, a server over SSH (with tables to leave the rows of)
    or this machine.
  - **The copy**: **As it is**, an exact copy with every user, order and key,
    or **Cleaned**: without users (one administrator you pick stays, the
    author of every post), orders, form entries, logs or keys, cleaned in the
    side database with SQL before anything reaches the site. A dump with
    views, triggers or routines cannot be cleaned there and is imported as it
    is, straight in after a snapshot.
- **Clean this database**: the same clean-up on the database the site has
  now, with nothing imported and no address replaced.
- **Search and replace** on groups of tables at once, leaving out tables
  without the addresses, with a preview.
- **Clean copies**: export a gzipped clean copy for the team, with a check for
  leftover emails.
- **Kept databases**: the tables from before an import or clean-up, kept for 7
  days to put back.

## Services → MySQL

- The server, and every database and user with what each is to the panel (a
  site's, kept for a site, not used by a site, left behind, MySQL's own), with
  fresh sizes.
- **Analyze** and **Optimize**; delete a database or user no site uses (saved
  first to the panel's MySQL backups for 14 days, so Undo puts it back;
  **Saved copies** lists them, with Delete to remove one sooner); reset a
  site's database user.
- **Settings**: the buffer pool, the biggest packet, the redo log,
  connections, temp tables in memory, how often InnoDB writes to disk and the
  slow query log (on, it goes to its table too, for Top queries where MySQL
  keeps no statement statistics; 1 second is a good limit for local work), with what
  each runs at now, what the panel keeps, what an
  import holds raised for its run, and a suggestion where the value is low
  (the buffer pool from your sites' InnoDB data). **Change** or a suggestion's
  **Use** starts a job: `SET GLOBAL` applies it at once, and `dmp-root
  mysql-config-write` keeps it for the next start in
  `zz-devmagic-panel.cnf` in `mysql.conf.d` (or `mariadb.conf.d`), which MySQL
  reads last. Only these settings go in, as numbers inside bounds; clearing
  one takes it out of the file. Undo puts the values from before back.
- **Processes**: what MySQL runs now, the longest first, with **Stop** for a
  statement (never one of MySQL's own threads).
- **Top queries**: the same list as a site's, for every site's database at
  once.
- **Import a dump** into a new database, or into one no site uses, which is
  saved to the MySQL backups first and emptied. The dump's own
  `CREATE DATABASE`, `DROP DATABASE` and `USE` lines are left out, so it
  changes no other database.

## Undo and saved copies

| Change | Saved first to | Undo |
| --- | --- | --- |
| A row changed, added or deleted | `~/devmagic-panel-backups/row-changes/` | Puts it back while the row still holds what the change left |
| A clean-up, an emptied or deleted table | `~/devmagic-panel-backups/cleanups/` | Puts the rows back; a row made again since stays as it is |
| A table fix, autoload turned off for options | `~/devmagic-panel-backups/cleanups/` | Puts the table, or the options, back as they were |
| SQL that writes | `~/devmagic-panel-backups/cleanups/` | Puts the tables it names back as they were before it |
| A replaced or deleted database | The panel's MySQL backups | Puts the database back |

All are readable only by you and go after 14 days. Undo is on the job, in the
toast, and under **Changes you can undo**.

## How it stays safe

- The browser reads in a read-only transaction with a time limit. The SQL
  runner reads as `devmagic_panel_ro`, an account with SELECT and SHOW VIEW
  only, made by setup or from Aura's Machine checks.
- Values reach MySQL as hex literals in the column's collation, and names only
  once MySQL listed them. A filter's value never reaches a URL.
- Every import runs `mysql --binary-mode`, so a client command like `\!` in a
  dump fails as SQL instead of running.
- The assistant sees a database as names, sizes and counts only, never a value
  from a row. Run history keeps no row values or SQL that writes.
