---
name: wt-env-check
description: Add a check to the devmagic-panel machine checks (Aura's Machine checks tab, once the Environment page), with a clear ok, warn or fail result, an optional one-click fix through a registry action, and Vitest coverage using the fake executor. Use when the panel should detect a missing package, module, setting or drift on the machine.
---

# WT Env Check

```
- [ ] 1. Pick the group and a stable id (group.thing)
- [ ] 2. Write the check in server/src/environment.ts
- [ ] 3. Fix: an existing action, or a new one (wt-new-action)
- [ ] 4. Tests
```

## 2. The check

- Read files directly when they are world-readable; run programs through
  `ctx.exec`; root-only reads through `runRoot`.
- `fail` = the panel or sites will not work. `warn` = works, but worse or a
  cleanup is due. Mark components the panel works without as `optional`.
- `detail` says what is wrong in a few words and names the thing: "missing:
  proxy_http", "not in hosts: local.a.de".
- When a check cannot run yet (no sudoers rule), say so as a `warn`, not a
  `fail` that blames the wrong thing.

## 3. The fix

```ts
fixes: [{ action: 'hosts.add', input: { domain, aliases }, label: 'Add to hosts' }]
```

Add `confirm` text when the fix can break something the user relies on.

## 4. Tests

In `server/test/environment.test.ts`: the healthy case stays all ok
(`healthyResponses()`), the failing case returns the right status, detail and
fix input. Add the command's healthy answer to `healthyResponses()`.

## Names

Examples in code, comments, tests, mock data, UI text and placeholders, docs,
the changelog and commit messages use made-up names only: `local.wandworks.example`,
`local.shop.com`, `git@github.com:wandworks/site.git`, a person like Alex Morgan (the full set is in AGENTS.md, rule 13).
Never a real client, project, company or person, including the sites on this
machine and their repos, branches, commits and authors.
