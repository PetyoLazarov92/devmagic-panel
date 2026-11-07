---
name: wt-release
description: Ship a change in devmagic-panel by bumping the semver version in package.json and the README badge, adding a CHANGELOG.md entry in the repository format, updating docs that the change affects, and verifying typecheck, Vitest, bats, shellcheck and build. Use after implementing a feature or fix, or when the user asks to release, bump the version, update the changelog, or finish up a change.
---

# WT Release

Run this after the code change is complete. Work through the checklist in order.

```
- [ ] 1. Decide the bump (see versioning rule: patch, minor, major)
- [ ] 2. Root package.json "version"
- [ ] 3. README.md badge on line 3
- [ ] 4. CHANGELOG.md entry at the top
- [ ] 5. Docs: the `docs/` page, README sections, AGENTS.md, rules, if the change affects them. A README feature line stays under 25 words; detail goes to the docs page and the CHANGELOG
- [ ] 6. Tests cover the change (logic and refusals)
- [ ] 7. Verify
- [ ] 8. Names review
- [ ] 9. Suggest the commit message (wt-commit-message)
- [ ] 10. Tag the release, only when the user asks to release
```

## 4. Changelog entry

```markdown
### v0.2.0 (2026-11-02)
* **Sites:** new site wizard creates the folder, cert, vhost and hosts line in one run
```

`### vX.Y.Z (YYYY-MM-DD)` with today's ISO date, `*` bullets, a bolded area
ending with a colon, present tense, what the user notices. Once per session:
if this session already added an entry, extend it instead of adding another.

## 7. Verify

```bash
npm run typecheck
npm test
npm run test:scripts
npm run lint:scripts
npm run build
./install.sh --dry-run --yes   # when install.sh or dmp-root changed
```

All must pass. Report what ran and what passed; if something could not run,
say so.

## 8. Names review

Examples use made-up names only: `local.acme.com`, `local.shop.com`,
`git@github.com:acme/site.git`, a person like Alex Morgan. Never a real
client, project, company or person, including the sites on this machine and
their repos, branches, commits and authors.

Before the commit, compare the repository with the names on this machine. They
are read at that moment and never written into the repository:

```bash
names=$( { ls /var/www; grep -hoE 'Server(Name|Alias).*' /etc/apache2/sites-available/*.conf; \
  for d in /var/www/*/; do git -C "$d" remote get-url origin 2>/dev/null; done; } \
  | grep -oE '[A-Za-z0-9-]{4,}' | tr 'A-Z' 'a-z' | sort -u )
for w in $names; do git grep -qiF "$w" -- . ':!package-lock.json' && echo "$w"; done
```

Use `WEB_DIR` from `/etc/devmagic-panel/config.env` when it is not `/var/www`.
Generic words (`port`, `that`, `devmagic`) are fine. Any hit that names a
client, project, company or person gets a made-up name, and the review runs
again.

## 10. Tag the release

The panel finds updates by release tags: `vX.Y.Z`, matching package.json, and
shows each release's notes, the tag's `CHANGELOG.md` section, as "what's new".
Only when the user asks to release, tag the release commit locally with an
annotated tag, and push it only when they ask:

```bash
git tag -a v0.7.0 -m "v0.7.0"
git push --follow-tags   # only when asked
```

Pushing the tag runs `.github/workflows/release.yml`: the same checks as the
test workflow, then `npm run package`, then a GitHub release with
`devmagic-panel-vX.Y.Z.tar.gz`, its `.sha256`, `devmagic-panel-vX.Y.Z.json`
and `get.sh`, and the changelog section as the notes. It also pushes the same
files as the package tag `pkg/vX.Y.Z` (the notes as its message) and moves the
`pkg/latest` branch to it, for installs and updates over git; the last five
package tags stay. It stops when the tag does not match package.json or
`CHANGELOG.md` has no section for it, so bump and write the entry before
tagging. Its last job, `site.yml`, tells webtimeless.cloud, which rebuilds with the release within minutes (with the `SITE_DISPATCH_TOKEN` secret; without it, the site's daily build shows it).

The panel updates itself from that release when its root scripts (`scripts/`,
root-owned once installed) are the installed ones. A release that changes them
is downloaded by the panel and finished with its own `install.sh` in a
terminal; one that changes only `install.sh` updates from the panel and says to
run the installer afterwards. Say which in the changelog entry.

