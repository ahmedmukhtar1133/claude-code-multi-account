# Changelog

## 0.1.1

- If a second copy of the extension is running in the same window (for example a `.vsix` next to the store version), the second copy now stays inactive instead of switching the window to the default account, and the active copy warns that the extension is installed twice.
- Plugin caches (`plugin-directory-cache-v2.json`, `plugin-catalog-cache.json`, `.last_inuse_sweep`) are now per account. Claude Code rewrites them on every start, which used to break the link and put the account's copy aside as a clash.
- `plugins/known_marketplaces.json` stays shared: when Claude Code replaces it, Repair merges the account's entries back into the shared copy (newest wins) instead of setting them aside.

## 0.1.0

- A different Claude account in each VS Code window, set through `CLAUDE_CONFIG_DIR` before Claude Code starts. The default account (`~/.claude`) keeps its login untouched.
- History, sessions, memory, `CLAUDE.md`, settings, skills, agents, commands, hooks and plugins shared through links to `~/.claude`. Skills synced from each claude.ai organization stay per account.
- Side panel: accounts with sign-in state, recent sessions of the open project (click to open in Claude Code), status and what is shared.
- Add account, rename account, adopt an existing config folder (with a backup copy and journaled undo), repair links, Doctor.
- Copy MCP servers between accounts through the official CLI.
- A window keeps its account when you open another folder in it.
- Per-project opt-out for history sharing.
- Never reads login data, makes no network calls, doesn't modify Claude Code. Unofficial, not affiliated with Anthropic.
