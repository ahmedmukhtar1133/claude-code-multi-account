# Changelog

## 1.0.0

- New windows start on the account you picked last, in any window. Before, only a pick made in an empty window carried over, so switching inside a folder window left new windows on an older account. Folders you picked an account for still keep theirs.
- New setting `claudeMultiAccount.newWindowAccount`: `folderThenLast` (default: a folder keeps its own pick, everything else opens on the last pick), `lastPicked` (every new window opens on the last pick) or `defaultAccount` (every new window opens on `defaultAccount`). Also in the side panel, under the accounts.
- Changing Default Account no longer offers to reload windows that are already open; it only decides where new windows start.

## 0.1.2

- Setting up the first account no longer needs a reload. When the window is already running on that account's folder (the usual case: the first account is `~/.claude`), the status bar, the panel and the Sessions tab switch to it right away. A reload is only asked for when Claude Code in the window uses a different folder.
- Status tab: each problem is a card with a short title and its own fix button (Repair links, Delete leftover tokens, Remove the overriding setting, Switch to a signed-out account, Show in Extensions). Doctor's notification offers the same fix.
- Leftover Claude Code Manager token copies (`manager-accounts`) can be deleted from the panel after a confirm, and are now found in every account folder, not only `~/.claude`. If Claude Code Manager is still installed, the panel points to it instead.
- Sessions tab: shows the project's sessions even before any account is set up (they are read from `~/.claude`), and has a Refresh link.

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
