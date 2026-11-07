# AI assistant

[Docs](README.md) › AI assistant

Optional and off by default; every page works without it.

## Turning it on

Turn it on under **AI assistant** in Settings, pick a model and
save your own Anthropic API key (or rely on `ANTHROPIC_API_KEY` or
`ant auth login`). The key stays in the panel's secrets file and never goes
back to the browser.

## What it does

- **A briefing on the Sites page**: a short note from Claude on what needs
  attention, each point with the panel's own fix buttons.
- **Ask Claude** in the header opens a chat.
- **Describe the site to Claude** on the new site wizard fills in every step
  from your words, the repo, the dump and `conventions.md` (how sites are set
  up here, editable under AI assistant and meant to be shared with your team).
  You review each step and install as usual.

## What it can see and change

Claude reads the panel's own data (sites, findings, logs, repo docs, git,
services, a site's database as names, sizes and counts) and shows what it
looked at. Anything it wants to change comes back as a card you run yourself.

- Tool results have anything secret-looking blanked out.
- Database contents are never sent.
- The assistant can never change its own settings.

## From Claude Code or Claude Desktop

The panel is also an MCP server. Copy the `claude mcp add` command from the AI
assistant card and run it once. Claude Code then reads your sites with the same
tools, and anything it wants to change shows up as a card in the panel that you
run yourself. This needs no API key and works with the assistant off.
