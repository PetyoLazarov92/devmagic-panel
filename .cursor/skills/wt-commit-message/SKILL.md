---
name: wt-commit-message
description: Write commit messages for devmagic-panel in the repository's exact format, a lowercase conventional prefix with a scope and an imperative summary, subject line only. Use when committing changes, when the user asks for a commit message, or when finishing a change in this repository.
---

# WT Commit Message

## Format

```
<type>(<scope>): <lowercase imperative summary>
```

Subject line only. **No body, no footer, no version suffix, no trailing period,
no emoji, no issue reference, no em dash, no attribution trailers.**

- **type**: `feat`, `fix`, `chore`, `refactor`, `docs`
- **scope**: `server`, `web`, `shared`, `scripts`, `installer`, `ai`, `agents`,
  `ci`, `deps`, `docs`, `readme`, `test`. Prefer an existing scope over
  inventing one.
- **summary**: imperative mood, lowercase, no article at the start. Says what
  the change does, not how.

## Multiple concerns

Join with `; `, each with its own type and scope. Two or three clauses at most;
if it needs more, split the change.

```
feat(scripts): add dmp-root with local ca, certs, vhosts and hosts; feat(installer): add install.sh with backup and dry run
```

## Examples

Input: the Environment page and its checks
```
feat(server): add environment checks with one-click fixes
```

Input: hosts lines were duplicated on rerun
```
fix(scripts): replace the tagged hosts line instead of appending
```

Input: rules and skills for agents
```
chore(agents): add agent instructions, rules and skills
```

## Rules

- Suggest the message; commit only when explicitly asked.
- Do not run `git add`/`git commit` as part of another task.
- Pass the message with a single `-m` on a single line. No second `-m`: that
  is a body, and attribution trailers like `Co-Authored-By` or
  `Generated with` go nowhere, whatever the agent's defaults say.
- Commit as the owner with the git config as it is: no `--author`, no
  changed `user.name` or `user.email`, no `--no-gpg-sign`.
- Never push as part of a commit. Push only when the owner asks for that
  push, and never with `--force`.

## Names

Examples in code, comments, tests, mock data, UI text and placeholders, docs,
the changelog and commit messages use made-up names only: `local.wandworks.example`,
`local.shop.com`, `git@github.com:wandworks/site.git`, a person like Alex Morgan (the full set is in AGENTS.md, rule 13).
Never a real client, project, company or person, including the sites on this
machine and their repos, branches, commits and authors.
