# Files

Every site has a **Files** tab: its folder, one level at a time, and any file
in it opened in place of the list. The panel reads and changes files as you,
never as root, and never leaves the site's folder.

- [Browsing](#browsing)
- [Opening a file](#opening-a-file)
- [What stays out of reach](#what-stays-out-of-reach)

## Browsing

- The bar names where you are: the site folder, then each folder down to this
  one. Each part is a link, and `..` at the top of the list goes one up.
- Under it, a filter for the names in this folder and the places worth one
  click: `wp-content`, Themes, Plugins, Uploads, each git repo of the site,
  `wp-config.php` and `debug.log`. Only the ones that are there show.
- The list has the name, size, when it changed and its permissions, folders
  first. Name, Size and Changed sort. On a phone only the name and size show.
- `.git` and `node_modules` are left out until you switch on **Show hidden**.
  Dot files like `.htaccess` always show.
- A row says only what changes what you can do with it: **repo** for the top
  folder of a git repo, **the panel's file** for the two mu-plugins the panel
  adds, **shared core, read only** for `wp-admin` and `wp-includes` of a
  shared core, **link** for other links, and **read only** for a file another
  account owns (often `www-data`).
- The row's menu opens it, downloads it or copies its full path.
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

## What stays out of reach

- A path is checked as it is written and again after links are followed.
  `..`, a leading slash and control characters are refused.
- A link that leaves the site's folder is shown with where it points and is
  not followed, except into the shared cores folder of `wpcore`, which is
  read only here: a core is shared by other sites.
- Nothing here needs root, and no `dmp-root` command is involved. A file you
  may not read as yourself says so.
- File contents stay between the panel and your browser. They are never sent
  to the AI assistant and never stored in the run history.
