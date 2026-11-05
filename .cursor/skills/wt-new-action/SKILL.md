---
name: wt-new-action
description: Add a new action to devmagic-panel end to end, the registry entry with its zod schema, the server handler, the dmp-root command when root is needed, the UI entry point, and tests on every layer. Use when adding anything the panel does to the system, such as creating a site, clearing a cache, switching a core or a new fix button.
---

# WT New Action

An action is the only way the panel changes anything. Follow every step.

```
- [ ] 1. Registry entry in shared/src/actions.ts
- [ ] 2. Root work? Add a dmp-root command (wt-script-change)
- [ ] 3. Handler in server/src/actions.ts
- [ ] 4. UI entry point
- [ ] 5. Tests
- [ ] 6. Release (wt-release)
```

## 1. Registry entry

```ts
'cache.clear': {
  title: 'Clear cache',
  description: 'Flushes the object cache, transients and rewrite rules of one site.',
  changesSystem: true,
  input: z.object({ domain: localName }),
},
```

- Domains and aliases use `localName`. Enums for fixed choices. Bound arrays
  with `.max()`.
- `description` is written for a person and for the AI later: what it does,
  when to use it.
- `changesSystem: true` for anything that writes; the AI may only propose those.

## 3. Handler

```ts
'cache.clear': (ctx, { domain }) =>
  steps(() => ctx.exec('wp', ['cache', 'flush', `--path=${ctx.config.WEB_DIR}/${domain}`])),
```

- Argument arrays only. Root through `root(ctx, 'command', ...args)`.
- Multi-step work uses `steps()`, which stops at the first failure.
- Secrets through `env`, never arguments.

## 4. UI

Call it with `api.runAction(id, input)`. Show progress and the output; ask
first when the action is destructive.

## 5. Tests

- `server/test/app.test.ts`: the action calls the exact command line, records a
  run, and rejects bad input with 400 before any command runs.
- `shared/test/`: schema edge cases if the input is non-trivial.
- bats for any new `dmp-root` command.

## Names

Examples in code, comments, tests, mock data, UI text and placeholders, docs,
the changelog and commit messages use made-up names only: `local.acme.com`,
`local.shop.com`, `git@github.com:acme/site.git`, a person like Alex Morgan.
Never a real client, project, company or person, including the sites on this
machine and their repos, branches, commits and authors.
