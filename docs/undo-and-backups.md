# Undo and backups

[Docs](README.md) › Undo and backups

## Backups of system files

The installer backs up certificates, vhosts, nginx's sites, `/etc/hosts` and the
system CA folder to `~/devmagic-panel-backups/` before it changes anything.
Make another backup any time:

```bash
sudo /usr/local/lib/devmagic-panel/bin/dmp-root backup
```

To go back:

```bash
sudo /usr/local/lib/devmagic-panel/bin/dmp-restore --list
sudo /usr/local/lib/devmagic-panel/bin/dmp-restore          # newest backup
sudo /usr/local/lib/devmagic-panel/bin/dmp-restore <file>   # a given one
```

It asks for your password on purpose: restoring writes Apache and nginx
config, so it is not part of the passwordless rule. While nginx runs next to
Apache, a backup from before keeps Debian's default nginx site off. It backs up
the current state first, so a restore can be undone too. If the panel's own
site is gone afterwards, run `~/.local/share/devmagic-panel/current/install.sh`
again.

## Undo inside the panel

| What | Saved first | Undo |
| --- | --- | --- |
| Installs and most jobs | As each step goes | **Undo** on the job's page |
| A removed or replaced site | The **Archive**, 14 days | **Restore** on the Archive page |
| A change to your crontab, a deleted WP-Cron event | `~/devmagic-panel-backups/` | **Undo** in the notice |
| A row changed, added or deleted | `~/devmagic-panel-backups/row-changes/`, 14 days | In the notice and under **Changes you can undo**, while the row still holds what the change left |
| A clean-up, an emptied or deleted table | `~/devmagic-panel-backups/cleanups/`, 14 days | On the job and under **Changes you can undo**; a row made again since stays as it is |
| SQL that writes | `~/devmagic-panel-backups/cleanups/`, 14 days | Puts the tables it names back as they were before it |
| A deleted or replaced database, deleted MySQL users | The panel's MySQL backups, 14 days | **Undo** on the job |

The copies under `~/devmagic-panel-backups/` are readable only by you. See
[Databases](databases.md#undo-and-saved-copies) for the database ones.
