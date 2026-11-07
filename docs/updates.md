# Updates

[Docs](README.md) › Updates

## Where updates come from

The release workflow builds and checks a package from each version tag
(`v0.7.0`) and publishes it twice: as a GitHub release, and as the package tag
`pkg/v0.7.0` (with the `pkg/latest` branch) for git.

The panel reads them at start and every six hours through the first way that
can reach the repository: public HTTPS when it is public, the GitHub CLI when
it is signed in, or git over SSH when your key can read it. It needs no token,
keeps the way that worked for next time, and the Updates page shows which one
it used and why the others did not work.

The header shows "v0.7.0 available" (only its icon on a phone), or "No access
to updates" when no way works. The Updates page lists what is new from the
release notes of every version since yours, right under the update: the newest
open, the ones before it closed.

## How an update installs

- **The panel updates itself**, after you confirm, when the release keeps the
  installed root scripts. It downloads the package (about 11 MB), checks its
  checksum, unpacks it in `~/.local/share/devmagic-panel/releases` next to the
  running one, points `current` at it and restarts. Nothing is built. The run
  is logged to `~/.local/state/devmagic-panel/logs/update-<date>.log`. When the
  release changes `install.sh` too, the panel still updates itself and says to
  run `~/.local/share/devmagic-panel/current/install.sh` afterwards for the
  installer's part.
- **It downloads the release, then installs it with your sudo password** when
  the release changes the root scripts (`scripts/`: `dmp-root`, its libraries,
  `wpcore`), which only its own `install.sh` may put in place.
  - You type the password into a field on the Updates page. It goes once to
    the release's `install.sh --from-panel`, on its stdin through a FIFO
    systemd opens for it, never on a command line or in a file, and the panel
    never saves it.
  - The installer runs in a background unit of its own, keeps the root scripts,
    `config.env` and the sudoers rule, swaps the new root scripts in whole,
    restarts the panel and checks it answers with the new version.
  - When a step fails, it puts everything back and the page says what
    happened; an install interrupted by a reboot can run again.
  - The same command still works in a terminal:
    `~/.local/share/devmagic-panel/releases/<version>/install.sh`.
  - Without your password nothing can replace root code: the passwordless sudo
    rule only covers `dmp-root` and `wpcore`, never their replacement.

## Going back

**Installed releases** lists what the releases folder keeps: the running
release and the newest others, three in all. **Switch to it** points `current`
at one and restarts, to go back after an update. One with other root scripts
than the installed ones switches through its own `install.sh` with your sudo
password, or in a terminal when its installer is older than v0.25.0.

## Another repository

`UPDATE_REPO` (owner/name) and `UPDATE_GIT_URL` in
`/etc/devmagic-panel/config.env` point the panel at another repository, like a
fork. A panel that runs from a checkout (`npm run dev:server`) does not update
itself. Panels before v0.7.0 saved a GitHub token; v0.7.0 deletes it, and the
Updates page says to revoke it on GitHub too.
