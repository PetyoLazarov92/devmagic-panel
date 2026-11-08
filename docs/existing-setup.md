# Living with your existing setup

[Docs](README.md) › Living with your existing setup

The panel works next to sites devmagic or you made by hand, and changes only
what is its own.

## Vhosts stay as they are

The panel only rewrites or removes a vhost whose first line is its own marker.
Sites made by hand or by devmagic keep their vhost; the panel reissues their
certificate and manages their hosts line.

## nginx runs next to Apache, never in its place

Once you set it up, Apache answers on `127.0.0.1` and nginx on `127.0.0.2`,
both on ports 80 and 443, so other devices on your network no longer reach
Apache. A site goes to the server its hosts line points at; the panel and
phpMyAdmin stay on Apache.

- A site you move to nginx gets `/etc/nginx/sites-available/<domain>.conf`
  with the panel's marker and its PHP through PHP-FPM; nginx reads no
  `.htaccess`. Sites under its paths go along, each from its own folder with
  its own PHP.
- A site with nginx in front of Apache keeps its Apache vhost and gets the
  same `<domain>.conf`, which passes requests to Apache on `127.0.0.1` over
  HTTPS. The first one adds `conf-available/devmagic-panel-remoteip.conf`
  (Apache sees the visitor's address from nginx, and from nginx only) and
  turns `mod_remoteip` on; turning nginx off takes both out again.
- Vhosts made by hand and names in hosts lines outside the panel's block keep
  their sites on Apache.
- nginx configs you wrote stay as they are. One that listens on port 80 or 443
  on every address keeps nginx from starting next to Apache, so the setup names
  it and waits until it listens on `127.0.0.2` or is off.
- Turning nginx off puts Apache's `ports.conf` and Debian's default site back
  and stops nginx.

## Hosts entries go in one marked block

In `/etc/hosts`, between `# BEGIN devmagic-panel` and `# END devmagic-panel`,
one line per site. Everything outside the block is left alone.

## wpcore is shared

The panel uses the same `/etc/wpcore.conf` and cores folder as the `wpcore`
command, so a core added from either side shows up in both.

## The two files the panel adds to a site

Both are must-use plugins, excluded from git in the repo's local
`.git/info/exclude` (never `.gitignore`), so they never show up in
`git status` or get committed, and both do nothing when the site's address is
not a local name.

- **One-click wp-admin login** adds
  `wp-content/mu-plugins/devmagic-panel-login.php` to each site you use it on.
  It only accepts one-time links the panel makes for 60 seconds.
- **Local mode** is `wp-content/mu-plugins/devmagic-panel-local.php`. New
  sites get it; existing sites get it when you turn it on (site page or Aura).
  It:
  - sends all mail to Mailpit (`127.0.0.1:1025`), tagged with the site so the
    Mail page can show it;
  - tells search engines not to index, and shows a Local label after the site
    name in the admin bar;
  - accepts logins only from this computer (Apache answers on every network
    address, so a simple local password must not work from another machine);
  - blocks requests to mail APIs and any hosts you add;
  - lets wp-admin install and update plugins without FTP details (`FS_METHOD`
    direct, when `wp-config.php` sets none);
  - on a network, makes a long My Sites menu fit the window and scroll, with a
    filter once it lists 10 sites;
  - for vhosts made by hand, sends missing uploads to production.

## `.htaccess`

Written only when a site has none (new installs, or the Aura fix), with
WordPress's own rules for a single site or a network, and kept out of git
locally. An `.htaccess` your repo tracks is never changed.

## Your crontab keeps its lines

The panel's cron tasks live in one marked block, between
`# BEGIN devmagic-panel` and `# END devmagic-panel`, and the panel changes
only those. Lines you wrote with `crontab -e` are shown and left as they are. A
site's WP-Cron runs from page loads as before until you switch it to cron on
its Cron tab.

## Removing, reinstalling and restoring a site

- **Removing a site** works for any site in the usual layout
  (`/var/www/<domain>` with a `<domain>-ssl.conf` vhost), made by the panel or
  not. It exports the database, archives the folder, vhost, certificate and
  dump into the Archive, and only then removes them and drops the database
  (and the site's own database user). Archived copies can be restored for 14
  days; then they are purged. Hosts lines outside the panel's block stay as
  they are.
- **Reinstalling or restoring over a site** archives the current one the same
  way first, after you confirm, so nothing is lost: the wizard warns when the
  domain is installed already, and a restore asks when the site exists again.
  Undo on the job puts the current site back.
