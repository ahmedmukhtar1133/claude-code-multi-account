# Changelog

## 0.1.0

- A different Claude account in each VS Code window, set through `CLAUDE_CONFIG_DIR` before Claude Code starts. The default account (`~/.claude`) keeps its login untouched.
- History, sessions, memory, `CLAUDE.md`, settings, skills, agents, commands, hooks and plugins shared through links to `~/.claude`. Skills synced from each claude.ai organization stay per account.
- Side panel: accounts with sign-in state, recent sessions of the open project (click to open in Claude Code), status and what is shared.
- Add account, adopt an existing config folder (with a backup copy and journaled undo), repair links, Doctor.
- Copy MCP servers between accounts through the official CLI.
- A window keeps its account when you open another folder in it.
- Per-project opt-out for history sharing.
- Never reads login data, makes no network calls, doesn't modify Claude Code. Unofficial, not affiliated with Anthropic.
