---
name: wt-script-change
description: Change dmp-root or its shell libraries in devmagic-panel safely, with input validation, atomic file writes, shellcheck, bats tests against a temp tree, and a reinstall so the root-owned copy matches. Use when adding or editing a dmp-root command, scripts/lib/*.sh, or install.sh.
---

# WT Script Change

`dmp-root` runs as root without a password. Treat every change as security work.

```
- [ ] 1. Validate input in dmp-root before any work
- [ ] 2. Implement in scripts/lib/<area>.sh
- [ ] 3. Wire the command in scripts/bin/dmp-root (usage text too)
- [ ] 4. bats tests
- [ ] 5. shellcheck
- [ ] 6. Server side: runRoot() call and its test
- [ ] 7. Reinstall
```

## 1. Validation

- Names: `with_names <fn> "$@"`, which runs `dmp_require_local_name` on each.
- Fixed choices: an allow-list like `DMP_APACHE_MODULES`.
- Exact argument counts: `(( $# == 1 )) || dmp_usage_error "..."`.
- Paths come from `config.env` only. Never accept a path argument; derive it
  from a validated name (`$WEB_DIR/$domain`).

## 2. Implementation

- Temp file in the target folder, then `mv`. Keep the previous file when a
  later check can fail, and restore it on failure.
- Keys 0600 before writing. Folders with explicit `install -d -m`.
- Reload Apache only through `dmp_apache_reload` (configtest first).

## 4. bats

In `scripts/tests/dmp-root.bats`, using `setup_tree`: the happy path, the
refusal (exit 2) for bad input, and the failure path (exit 1) leaving the
system as it was. Add stubs with `stub <name> '<body>'` for new system commands.

## 7. Reinstall

The root-owned copy in `/usr/local/lib/devmagic-panel` changes only when the
user reruns `./install.sh` (it skips what is already done). Tell the user to
run it; never edit the installed copy directly.

## Names

Examples in code, comments, tests, mock data, UI text and placeholders, docs,
the changelog and commit messages use made-up names only: `local.acme.com`,
`local.shop.com`, `git@github.com:acme/site.git`, a person like Alex Morgan.
Never a real client, project, company or person, including the sites on this
machine and their repos, branches, commits and authors.
