# Troubleshooting

[Docs](README.md) › Troubleshooting

## The browser says the certificate is not trusted

Close and reopen the browser once after the first install, so it loads the new
CA. The Environment page's Certificates group shows whether the system and each
browser store trust it; running
`~/.local/share/devmagic-panel/current/install.sh` again adds it to browser
profiles made since.

## `https://local.devmagic` does not open

Check the panel's service and its log, then Apache:

```bash
systemctl --user status devmagic-panel
journalctl --user -u devmagic-panel -n 50
sudo apache2ctl configtest
```

## The panel says "Waiting for the panel to start"

Its service starts after you log in, so a tab the browser restores right then
waits for it and opens the panel by itself once it answers. If it keeps
waiting, check the service as above, or start it with
`systemctl --user start devmagic-panel`.

## Another web server holds ports 80 and 443

The installer warns when nginx is installed. Stop the other server or move it
to other ports, then restart Apache from the Services page; the Environment
page checks that both ports answer.

## MySQL admin account: not configured or cannot connect

Run `setup` again (see [Quick start](../README.md#-quick-start)). On a new
MySQL or MariaDB, root signs in only through sudo; answer `c` to make the
panel's own account with `sudo mysql`.

## Local sites send no mail

Local mode sends it to Mailpit. Install or start Mailpit on the Services or
Mail page, then read it on the Mail page.

## The installer stops at `apt-get update`

apt fails as a whole when any one package source on the machine fails, often
one another app added (an editor, a browser). The installer names that source,
the file it is in and why, and when its key is on the machine already, the
`signed-by=` that points the source at it. Fix that source, or move its file
out of `/etc/apt/sources.list.d` for now, then run the installer again.

## An update says to run `install.sh` in a terminal

That release changes the root scripts, which only its installer may put in
place with your password. Run the command the Updates page shows.

## Where are the logs?

Installs and updates log to `~/.local/state/devmagic-panel/logs/`; every
action the panel ran is in Run history; the
[Developer options](pages.md#developer-options) page shows the service's
startup log.
