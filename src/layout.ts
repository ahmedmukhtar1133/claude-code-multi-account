// Which entries of a Claude Code config folder are shared between accounts.
// The default account's folder (~/.claude) is the store; every other account
// folder links its shared entries to the store's.

/** Entries linked as a whole to the same entry in the store. */
export const SHARED_ITEMS: readonly string[] = [
  'projects',
  'history.jsonl',
  'file-history',
  'session-env',
  'uploads',
  'todos',
  'plans',
  'tasks',
  'CLAUDE.md',
  'settings.json',
  'agents',
  'commands',
  'hooks',
  'output-styles',
  'mcp.json',
  'downloads',
];

/** Shared items that are files; everything else in SHARED_ITEMS is a folder. */
export const SHARED_FILES: ReadonlySet<string> = new Set(['history.jsonl', 'CLAUDE.md', 'settings.json', 'mcp.json']);

/**
 * Folders that stay real in each account but link each child to the store,
 * except the listed children, which belong to the account (synced from its claude.ai org).
 */
export const MIXED_DIRS: Readonly<Record<string, readonly string[]>> = {
  skills: ['synced'],
  plugins: ['synced'],
};

/**
 * Files in a mixed folder that Claude Code rewrites on every start by replacing the file
 * (which breaks a link): caches and timestamps. They stay per account.
 */
const MIXED_OWN_FILES: Readonly<Record<string, readonly RegExp[]>> = {
  plugins: [/^\./, /cache[^/]*\.json$/i],
};

/** True when a child of a mixed folder belongs to the account rather than the store. */
export function isOwnInMixed(dir: string, child: string): boolean {
  return (MIXED_DIRS[dir] ?? []).includes(child) || (MIXED_OWN_FILES[dir] ?? []).some((r) => r.test(child));
}

/**
 * Shared JSON files that Claude Code replaces on start (breaking the link). Instead of treating the
 * account's copy as a clash, its entries are merged into the store by key, newest lastUpdated wins.
 */
export const MERGED_JSON: Readonly<Record<string, ReadonlySet<string>>> = {
  plugins: new Set(['known_marketplaces.json']),
};

/** Entries this extension never links, moves or merges. */
export const NEVER_TOUCH: ReadonlySet<string> = new Set([
  '.claude-manager',
  '.claude-manager-snapshots',
  'manager-accounts',
  'chrome',
]);

/** Known per-account entries (login, account identity, org settings, caches, runtime state). */
const PER_ACCOUNT_NAMES: ReadonlySet<string> = new Set([
  '.claude.json',
  '.credentials.json',
  'sessions',
  'ide',
  'cache',
  'state',
  'telemetry',
  'backups',
  'shell-snapshots',
  'statsig',
  'debug',
  'paste-cache',
  'image-cache',
  'mcp-needs-auth-cache.json',
]);
const PER_ACCOUNT_PATTERNS: readonly RegExp[] = [
  /^policy-limits/,
  /^remote-settings/,
  /^\.last-/,
  /\.lock$/,
  /^\.claude.*\.json/,
  /\.from-.+/,
  /^\.shared-profiles/,
  /^\.multi-account/,
];

export type Kind = 'shared' | 'mixed' | 'account' | 'never' | 'unknown';

export function classify(name: string): Kind {
  if (NEVER_TOUCH.has(name)) return 'never';
  if (SHARED_ITEMS.includes(name)) return 'shared';
  if (name in MIXED_DIRS) return 'mixed';
  if (PER_ACCOUNT_NAMES.has(name) || PER_ACCOUNT_PATTERNS.some((r) => r.test(name))) return 'account';
  return 'unknown';
}

/** The folder name Claude Code uses under projects/ for a working directory. */
export function projectKey(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}
