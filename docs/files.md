# Files

Every site has a **Files** tab: its folder, one level at a time, and any file
in it opened in place of the list. The panel reads and changes files as you,
never as root, and never leaves the site's folder.

- [Browsing](#browsing)
- [Opening a file](#opening-a-file)
- [Editing a file](#editing-a-file)
- [New, rename, move, copy](#new-rename-move-copy)
- [Upload, zip and extract](#upload-zip-and-extract)
- [Delete and Undo](#delete-and-undo)
- [Uploads from production](#uploads-from-production)
- [What stays out of reach](#what-stays-out-of-reach)

## Browsing

- The bar names where you are: the site folder, then each folder down to this
  one. Each part is a link, and `..` at the top of the list goes one up.
- Under it, a filter for the names in this folder and the places worth one
  click: `wp-content`, Themes, Plugins, Uploads, each git repo of the site,
  `wp-config.php` and `debug.log`. Only the ones that are there show.
- The list has the name, size, when it changed and its permissions, folders
  first. Name, Size and Changed sort. On a phone only the name and size show.
- A folder has no size until you ask: **Measure** in its Size cell counts
  everything below it (`du`, staying on the folder's disk) and shows the
  total until the list is read again.
- Press `/` anywhere on the tab to go to the box, and Escape in it to empty
  it and leave search results.
- `.git` and `node_modules` are left out until you switch on **Show hidden**.
  Dot files like `.htaccess` always show.
- A row says only what changes what you can do with it: **repo** for the top
  folder of a git repo, **the panel's file** for the two mu-plugins the panel
  adds, **shared core, read only** for `wp-admin` and `wp-includes` of a
  shared core, **link** for other links, and **read only** for a file another
  account owns (often `www-data`).
- The row's menu opens it, downloads it or copies its full path, and for what
  you can change: Edit, Rename, Duplicate, Move to, Copy to and Delete.
- The folder and the file are in the address
  (`?tab=files&dir=wp-content/themes`), so Back, a reload and a bookmark land
  where you were. A very long folder lists its first 5,000 entries and says
  how many it left out.

## Opening a file

- Text opens with line numbers, up to 2 MB. `&line=42` in the address marks
  that line and brings it into view.
- A line of `debug.log` or the web server's log on the Logs tab that names a
  file of the site (`.../functions.php on line 28`) is a link to that file at
  that line.
- Images open as they are: png, jpg, gif and webp. An SVG opens as text, since
  it can hold scripts.
- Anything else, and text over 2 MB, shows its size, date and permissions with
  **Download**.
- A download is always sent as a file to save, never as a page: with
  `Content-Disposition: attachment`, `nosniff` and a policy that runs nothing.

## Editing a file

- **Edit** on a text file you can write opens it in an editor: line numbers,
  the language coloured by the file's ending (PHP, JS, CSS, HTML, JSON, SQL),
  Ctrl+F to find, Tab to indent with the file's own indent. `&edit=1` in the
  address opens a file that way.
- **Save**, or Ctrl+S in the editor, writes the file: to a temporary file next to it first,
  then in its place, so a save never leaves half a file. Its permissions and
  its line endings stay as they were.
- If the file changed on disk since you opened it (an editor, git, WordPress),
  the save stops and says so. **Reload from disk** drops what you typed;
  **Save anyway** replaces what is on disk.
- Nothing is written while you type: only **Save** writes. **Cancel** drops
  what you typed and leaves the file as it is on disk, asking once on the
  button first, and the browser asks before a reload or a closed tab loses
  what you typed.
- `wp-config.php` gets a warning while you edit it. A file another account
  owns, a file of a shared core and anything that is not text have no Edit.
- The editor is loaded when you first press Edit. If it cannot load, the file
  still shows as text.

## Find, git and changes

The box above the list has three ways to look. **This folder** filters the
names of the folder you are in as you type. **Names below** and **Text in
files** look in the folder and every folder under it once you press Enter,
and the results take the list's place:

- Names are matched whatever the case of the letters, nearest folders first.
- Text is read from text files only, whatever the case, as plain characters
  (no patterns). Each line found is a link that opens the file at that line.
- `.git` and `node_modules` are left out, and minified files and source maps
  for text. Links are named and never followed.
- A search lists up to 200 results and says when there are more.

A search has an address of its own, so Back and a reload keep it.

In a folder of a git repo the bar names the repo and its branch, and each
entry says what git says about it: modified, new, added, renamed, conflict,
or "changes inside" for a folder. A file that changed has a **Changes**
button that shows its diff since the last commit. git is only read: no
program of the repo's config runs for it, and the panel never commits,
stages or checks out.

When a save finds the file changed on disk, **See the difference** shows
what is on disk next to what you typed before you choose. A diff holds the
file's text, so it goes to the browser only: never stored, never sent to an
AI.

After a save of a PHP file the panel asks PHP whether it parses
(`php -n -l`, which never runs the file). The save is never held back: a
syntax error is named with its line, with a button that goes there.

## New, rename, move, copy

- **New file** and **New folder** make one in the folder you are in. A new
  file opens in the editor.
- **Rename** changes a name in its folder. A name has no slash, and nothing is
  ever written over: a name that is taken is refused.
- **Move to** and **Copy to** open a picker of the site's folders. A folder
  cannot go into itself, and a folder you may not write is refused with the
  reason. **Duplicate** makes `name copy.ext` next to the original.
- Tick rows, or the box in the header for all of them, and a bar offers Move
  to, Copy to and Delete for the selection. A row that cannot change keeps a
  greyed box.
- A copy of more than 1 GB is refused: do that one in a terminal.

## Permissions

**Permissions**, in a row's menu or for the rows you tick, sets one of five
modes, each named with what it means:

| Mode | Meaning |
| --- | --- |
| `644` | you write, everyone reads |
| `640` | you write, your group reads |
| `600` | only you read and write |
| `755` | you write, everyone reads and opens or runs it |
| `750` | you write, your group reads and opens or runs it |

- There is no box to type a number in, so nothing here lets everyone write
  (`777`, `666`) or sets a setuid bit.
- A folder takes `755` or `750` only: with the others nobody could open it.
  Only the folder itself changes, never what is in it.
- A link is refused, since its permissions are those of what it points at,
  and so is anything in a shared core. Everything is checked before the first
  one changes.
- It runs as you, so a file another account owns says so and stays as it is.

## From other places

- The command palette (Ctrl+K) has **Files of** each site.
- On the **Plugins and themes** tab each plugin and theme has **Open folder**,
  which lands in its folder here. Must-use plugins, drop-ins and themes found
  in a repo through Local mode have none.

## Upload, zip and extract

- **Upload**, or files dropped on the list, puts files in the folder you are
  in: up to 200 at a time and 1 GB each, with a line that says how far it is.
  A name that is already there is left as it is, and the message names it.
  Nothing is written over.
- A folder is not uploaded as it is: pack it into a zip, upload that and
  choose **Extract**.
- **Download as zip** on a folder, or **Download** for the rows you tick,
  sends them as one zip made for that download. Links in it stay links.
- **Compress** makes `name.zip` next to the entry, or one zip of the rows you
  tick, under a name that is free.
- **Extract** on a zip, tar, tar.gz, tgz, tar.bz2 or tar.xz unpacks it into a
  new folder next to it, named after the archive. The archive is read first
  and refused when an entry would leave that folder, sits under a link, or
  it all unpacks to more than 1 GB. Links in it are left out, and the message
  says how many.
- Zips need `zip` and `unzip`. Where one is missing, the panel says so with
  the line to install it.

## Delete and Undo

- **Delete** moves the entry to the panel's file trash, in the panel's data
  folder and outside the site, and the message that says so has **Undo**.
- The list ends with **Changes you can undo**: each delete of the last 14
  days with **Put back**. After 14 days it is removed for good.
- Put back never writes over something: if another file took the name in the
  meantime, both are kept and the panel says which.
- A delete that would break the site asks first, with the reason:
  `wp-config.php`, `index.php`, `.htaccess` and `wp-content` in the site
  folder, the themes, plugins, uploads and mu-plugins folders, one of the
  panel's two files, and a git repo (commits never pushed go with it).
- More than 1 GB is too much to keep for Undo and is refused: delete that in
  a terminal.

## Uploads from production

The Files tab of a WordPress site has two views: **Browse** and **Uploads
from production** (`?tab=files&view=uploads`). The second brings files of
`wp-content/uploads` from the site's own server, over SSH, when you ask.
Nothing about uploads is on the Database tab, and a refresh from production
never copies them.

- It uses the server saved for Refresh from production (SSH host and
  WordPress folder), with **Change**, and asks for both when none is saved. A
  server that asks for a password gets the one you type for that run; it is
  never kept.
- **Here** says what this computer has: the files and size of uploads, the
  free space, the last copy, and whether Local mode already loads missing
  files from production when a page asks for them.
- **Compare** lists the files on the server and reads the ones here. It
  copies nothing. Then every folder shows what is new, what changed and its
  size, in four groups: **Media** by month (and by site on a network),
  **Generated and rebuildable** (styles and converted images plugins make
  again), **Private data** (form entries, order files, paid downloads,
  members' files) and **Other folders**. Only media with something new starts
  ticked, and private data has a warning when you tick it.
- **All media**, **Last 3 months** and **Nothing** tick for you. **Originals
  only** leaves resized copies like `photo-300x200.jpg` on the server
  (`wp media regenerate` makes them again), and **Skip files larger than**
  leaves big files there.
- **Bring** copies what you ticked. It only adds: a file that is here already
  stays as it is, and nothing here is deleted. It is refused when it would
  not fit with 1 GB to spare. **Stop** keeps what came, and a new run brings
  the rest.
- Files that are here too and newer on the server are listed. Bringing them
  is its own switch, off by default: each file here goes to the file trash
  first, and **Changes you can undo** on Browse puts it back for 14 days.
- Files that are only here are listed, and nothing is done with them.
- Never copied: PHP files, links, `.htaccess`, database dumps, and plugins'
  cache, log and backup folders. A folder with a name the panel does not take
  is left on the server and counted.
- Nothing is written or deleted on the server, no key is added there, and its
  host key is still checked. It needs `rsync` on both sides.
- In `wp-content/uploads`, Browse has a line that leads here. The new site
  wizard's **Also copy the uploads** stays as it is.

## What stays out of reach

- A path is checked as it is written and again after links are followed.
  `..`, a leading slash and control characters are refused.
- A link that leaves the site's folder is shown with where it points and is
  not followed, except into the shared cores folder of `wpcore`, which is
  read only here: a core is shared by other sites.
- Nothing here needs root, and no `dmp-root` command is involved. A file you
  may not read as yourself says so.
- A link that leaves the site's folder is never written through, renamed,
  moved or deleted here: it is the site's wiring.
- File contents stay between the panel and your browser. They are never sent
  to the AI assistant, the assistant cannot run the Files actions, and the
  run history stores what you saved as `(hidden)`.
