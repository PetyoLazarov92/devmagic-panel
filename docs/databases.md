# Databases

[Docs](README.md) › Databases

A site's **Database** tab has four views: **Tables**, **WordPress**, **SQL**
and **Backups and tools**. Every other database on the server opens from
**Services → MySQL** with the same Tables and SQL views
(`/services/mysql?db=<name>`). MySQL's own databases and the ones the panel
keeps for a site are only read.

## Tables

- Every table with its engine, rows and size, with a filter for the site's
  prefix and other prefixes.
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
- A PHP serialized value whose string lengths no longer add up, or JSON that
  no longer reads, is flagged, with **Count the lengths again**.
- A change applies only while the row still holds what you saw, so an edit
  made since is never overwritten.
- Each change saves the rows as they were first, and **Undo** (in the toast or
  under **Changes you can undo**) puts them back for 14 days.
- Views, tables without a primary key, binary and computed columns stay read
  only, and a site's rows wait while a job works on it.

## WordPress

What WordPress keeps in its database, for each site of a network:

- **Autoloaded options** against Site Health's 800 KB limit, the biggest by
  name, and **Turn off** for a big one (written as the site's WordPress
  writes it: on and off, or yes and no before 6.6).
- **Transients**, with the expired ones still stored, and **Delete expired** or
  **Delete all**.
- **What a clean-up would find**: revisions, auto-drafts, posts and comments in
  the trash, spam, and meta or terms left behind by something deleted, each
  with a tick, and **Delete the ticked**. A post goes with its meta, terms and
  comments, as WordPress deletes it; a link's terms stay.
- The postmeta keys that take the most room, and the users with their roles.

Each clean-up is a job that saves what it removes first; see
[Undo](#undo-and-saved-copies).

## SQL

One statement at a time, in a code editor: MySQL's keywords coloured and
suggested, the database's own tables as you type and a table's columns after
`table.`, **Tab** to take a suggestion (Escape then Tab leaves the editor),
**Ctrl+Enter** to run. Drag the corner of the box to resize it.

- **Read only** (the default): SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, TABLE or
  VALUES, as the read-only MySQL account, up to 1,000 rows and 30 seconds.
  **Explain** shows how MySQL would run it, **CSV** downloads the result, and
  the last 30 statements stay in this browser.
- **Can write**: one statement that changes rows (INSERT, UPDATE, DELETE,
  REPLACE) or a table, an index or a view (ALTER, CREATE, DROP, RENAME,
  TRUNCATE). **Check and run** first shows the rows it changes (tried in a
  transaction that is rolled back, on tables that can roll back), the tables
  it saves first with their size, and the disk's free room. With the
  database's name typed, a job saves those tables whole and runs it.

The runner never touches another database, accounts, rights, routines or files.

## Backups and tools

- **Snapshots**: take, restore and download a snapshot of the site's database.
- **Import a dump**: a `.sql`, `.sql.gz` or `.zip` streamed into a side
  database and swapped in at once, with MySQL's limits raised while it runs.
- **Prepare from production**: a production dump without users (one
  administrator you pick stays, the author of every post), orders, form
  entries, logs or keys.
- **Clean this database**: the same clean-up on the database the site has now.
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
- **Processes**: what MySQL runs now, the longest first, with **Stop** for a
  statement (never one of MySQL's own threads).
- **Import a dump** into a new database, or into one no site uses, which is
  saved to the MySQL backups first and emptied. The dump's own
  `CREATE DATABASE`, `DROP DATABASE` and `USE` lines are left out, so it
  changes no other database.

## Undo and saved copies

| Change | Saved first to | Undo |
| --- | --- | --- |
| A row changed, added or deleted | `~/devmagic-panel-backups/row-changes/` | Puts it back while the row still holds what the change left |
| A clean-up, an emptied or deleted table | `~/devmagic-panel-backups/cleanups/` | Puts the rows back; a row made again since stays as it is |
| SQL that writes | `~/devmagic-panel-backups/cleanups/` | Puts the tables it names back as they were before it |
| A replaced or deleted database | The panel's MySQL backups | Puts the database back |

All are readable only by you and go after 14 days. Undo is on the job, in the
toast, and under **Changes you can undo**.

## How it stays safe

- The browser reads in a read-only transaction with a time limit. The SQL
  runner reads as `devmagic_panel_ro`, an account with SELECT and SHOW VIEW
  only, made by setup or from the Environment page.
- Values reach MySQL as hex literals in the column's collation, and names only
  once MySQL listed them. A filter's value never reaches a URL.
- Every import runs `mysql --binary-mode`, so a client command like `\!` in a
  dump fails as SQL instead of running.
- The assistant sees a database as names, sizes and counts only, never a value
  from a row. Run history keeps no row values or SQL that writes.
