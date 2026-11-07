# How it stays safe

[Docs](README.md) › How it stays safe

## Localhost only

The server binds `127.0.0.1`, refuses unknown `Host` headers and cross-origin
requests, and needs a login.

## No shell, root only through `dmp-root`

Nothing runs through a shell. Root work goes only through `dmp-root`, which
validates every argument and takes every path from the root-owned config. The
passwordless sudo rule covers `dmp-root` and `wpcore` only, never a way to
replace them: new root scripts go in place only through a release's
`install.sh`, with your sudo password.

## Only local names

Only local names are accepted (`local.*`, `www.local.*`, `*.test`,
`*.localhost`), so the passwordless rule cannot mint trusted certs for real
domains.

## Secrets and passwords

- Secrets live in `~/.config/devmagic-panel/secrets.json` (0600).
- The panel password is stored as a scrypt hash, and changing it signs every
  other browser out.
- A reset with the computer password only shows where sudo asks this account
  for one (so it proves who you are), checks it with `sudo -v` on stdin, and
  locks for an hour after 5 failures from anywhere.
- Passwords go to MySQL and WP-CLI through the environment or stdin, never the
  command line.
- Run history keeps passwords, row values and SQL that writes as `(hidden)`.
- The browser and password managers are not offered the sudo password, the
  computer password for a reset, the API key or the passwords for sites and
  databases: those fields are text drawn as dots, with each manager's ignore
  marker. Only the panel's own login is a password field, for a manager to
  save and fill.

## Databases

The SQL runner reads as `devmagic_panel_ro`, an account with SELECT and SHOW
VIEW only, in a read-only transaction with a time limit. SQL that writes is a
job you switch to, that saves the tables it names first. See
[Databases](databases.md#how-it-stays-safe) for the rest.

## Sign-ins the panel never reads

Updates need no GitHub token: the GitHub CLI and git keep their own sign-in,
and the panel never reads it. The same goes for the GitLab CLI, which lists
GitLab groups and merge requests, and for Claude Code and rclone in an install
from an organization.

## Checked packages

Updates are packages GitHub built from a version tag, checked against their
`.sha256` before anything is unpacked, whichever way they arrive. The Node.js
the installer may download is checked against nodejs.org's checksums the same
way.
