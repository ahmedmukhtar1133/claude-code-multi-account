import * as fs from 'fs';
import * as path from 'path';
import { classify, MIXED_DIRS, SHARED_FILES, SHARED_ITEMS } from './layout';
import { isDanglingLink, isLinkTo, lstatOrNull, Platform } from './link';
import { Account, accountDir, isDefault, storeDir } from './paths';

export type Level = 'ok' | 'info' | 'warn' | 'error';

export interface Finding {
  level: Level;
  message: string;
  /** Command id that fixes it, when there is one. */
  fix?: string;
  /** Extension ids the finding is about (other account switchers). */
  extensions?: string[];
}

/** Other extensions that set CLAUDE_CONFIG_DIR or swap logins. */
export const OTHER_SWITCHERS: Readonly<Record<string, string>> = {
  'vishalguptax.claude-manager': 'Claude Code Manager',
  'wheatlay.switchboard-for-claude-code': 'Switchboard for Claude Code',
  'leog.claude-code-config-dir-patcher': 'Claude Code Profiles (leog)',
  'kahuecosta.account-switcher-for-claude-code': 'Multi-Account Switcher for Claude Code',
};

export interface DoctorInput {
  home: string;
  accounts: Account[];
  platform?: Platform;
  /** claudeCode.environmentVariables as configured. */
  claudeEnvSetting?: unknown;
  claudeProcessWrapper?: string;
  /** CLAUDE_CONFIG_DIR as VS Code was launched with, if any. */
  launchConfigDir?: string;
  /** Installed extension ids. */
  extensions?: string[];
  /** Signed-in state per account name, from `claude auth status`. */
  loggedIn?: Record<string, boolean | undefined>;
  unsharedProjectKeys?: ReadonlySet<string>;
}

function envNames(setting: unknown): string[] {
  if (Array.isArray(setting)) return setting.filter((e) => e && typeof e.name === 'string').map((e) => e.name as string);
  if (setting && typeof setting === 'object') return Object.keys(setting);
  return [];
}

export function runDoctor(input: DoctorInput): Finding[] {
  const out: Finding[] = [];
  const platform = input.platform ?? process.platform;
  const store = storeDir(input.home);

  if (!fs.existsSync(store)) {
    out.push({ level: 'error', message: `${store} does not exist. Open Claude Code once on the default account first.` });
    return out;
  }

  // Settings that would send every account to one folder.
  try {
    const s = JSON.parse(fs.readFileSync(path.join(store, 'settings.json'), 'utf8')) as { env?: Record<string, unknown> };
    if (s.env && Object.prototype.hasOwnProperty.call(s.env, 'CLAUDE_CONFIG_DIR')) {
      out.push({ level: 'error', message: 'settings.json sets env.CLAUDE_CONFIG_DIR. Every account shares settings.json, so this sends all of them to one folder. Remove that key.' });
    }
  } catch {
    /* no or unreadable settings.json: nothing to check */
  }
  if (envNames(input.claudeEnvSetting).includes('CLAUDE_CONFIG_DIR')) {
    out.push({ level: 'error', message: 'claudeCode.environmentVariables sets CLAUDE_CONFIG_DIR. It overrides the account chosen for each window. Remove it from your VS Code settings.' });
  }
  if (input.claudeProcessWrapper) {
    out.push({ level: 'warn', message: 'claudeCode.claudeProcessWrapper is set. Switching works only if the wrapper passes CLAUDE_CONFIG_DIR through unchanged.' });
  }
  if (input.launchConfigDir) {
    out.push({ level: 'info', message: `VS Code was started with CLAUDE_CONFIG_DIR=${input.launchConfigDir}. This extension replaces it per window.` });
  }

  // Account list itself.
  const seen = new Map<string, string>();
  const defaults = input.accounts.filter(isDefault);
  if (defaults.length > 1) out.push({ level: 'error', message: `More than one account uses ~/.claude: ${defaults.map((a) => a.name).join(', ')}.` });
  for (const a of input.accounts) {
    const dir = accountDir(a, input.home);
    const key = platform === 'linux' ? dir : dir.toLowerCase();
    if (seen.has(key)) out.push({ level: 'error', message: `"${a.name}" and "${seen.get(key)}" use the same folder ${dir}.` });
    seen.set(key, a.name);
    if (!isDefault(a) && path.resolve(dir) === path.resolve(store)) {
      out.push({ level: 'error', message: `"${a.name}" points at ~/.claude explicitly. Leave its folder empty instead: an explicit ~/.claude is a different login.` });
    }
  }

  for (const a of input.accounts) {
    const login = input.loggedIn?.[a.name];
    if (login === false) out.push({ level: 'warn', message: `"${a.name}" is not signed in. Switch a window to it and sign in through the Claude Code panel.` });
    if (isDefault(a)) continue;
    out.push(...checkAccount(a, input.home, platform, input.unsharedProjectKeys ?? new Set()));
  }

  // Leftovers from token-copying switchers.
  if (fs.existsSync(path.join(store, 'manager-accounts'))) {
    out.push({ level: 'warn', message: `${path.join(store, 'manager-accounts')} exists. Claude Code Manager keeps copies of login tokens there in plain text. This extension never reads it; consider deleting it once you no longer use that switcher.` });
  }
  const switchers = (input.extensions ?? []).filter((id) => id.toLowerCase() in OTHER_SWITCHERS);
  if (switchers.length) {
    const names = switchers.map((id) => OTHER_SWITCHERS[id.toLowerCase()]).join(', ');
    out.push({
      level: 'warn',
      message: `Another account switcher is installed: ${names}. Two switchers fight over the account. Disable it, or turn off its account switching.`,
      extensions: switchers,
    });
  }

  if (!out.some((f) => f.level === 'error' || f.level === 'warn')) out.push({ level: 'ok', message: 'Everything is linked and nothing overrides the per-window account.' });
  // Show paths inside the home folder as ~/..., which is shorter and doesn't print the user name.
  const homePrefix = input.home.endsWith(path.sep) ? input.home : input.home + path.sep;
  return out.map((f) => ({ ...f, message: f.message.split(homePrefix).join('~/') }));
}

function checkAccount(a: Account, home: string, platform: Platform, unshared: ReadonlySet<string>): Finding[] {
  const out: Finding[] = [];
  const dir = accountDir(a, home);
  const store = storeDir(home);
  if (!fs.existsSync(dir)) {
    out.push({ level: 'error', message: `"${a.name}": folder ${dir} is missing.`, fix: 'claudeMultiAccount.repair' });
    return out;
  }
  const broken: string[] = [];
  for (const item of SHARED_ITEMS) {
    if (item === 'projects' && unshared.size > 0) continue;
    const p = path.join(dir, item);
    const s = path.join(store, item);
    if (isLinkTo(p, s, platform) && lstatOrNull(s)) continue;
    if (!lstatOrNull(p) && !lstatOrNull(s) && SHARED_FILES.has(item)) continue;
    broken.push(item);
  }
  for (const [m, keep] of Object.entries(MIXED_DIRS)) {
    const sDir = path.join(store, m);
    if (!fs.existsSync(sDir)) continue;
    for (const child of fs.readdirSync(sDir)) {
      if (keep.includes(child)) continue;
      if (!isLinkTo(path.join(dir, m, child), path.join(sDir, child), platform)) broken.push(`${m}/${child}`);
    }
    const own = path.join(dir, m);
    if (fs.existsSync(own)) {
      for (const child of fs.readdirSync(own)) {
        if (isDanglingLink(path.join(own, child))) broken.push(`${m}/${child} (dangling)`);
      }
    }
  }
  if (broken.length) {
    const hint = platform === 'win32' && broken.some((b) => SHARED_FILES.has(b)) ? ' On Windows a save can turn a linked file into a separate copy; Repair keeps the newer one.' : '';
    out.push({ level: 'warn', message: `"${a.name}": not shared yet: ${broken.slice(0, 8).join(', ')}${broken.length > 8 ? ` and ${broken.length - 8} more` : ''}.${hint}`, fix: 'claudeMultiAccount.repair' });
  }
  const unknown = fs.readdirSync(dir).filter((n) => classify(n) === 'unknown');
  if (unknown.length) {
    out.push({ level: 'info', message: `"${a.name}": kept per account because this extension doesn't know them yet: ${unknown.join(', ')}.` });
  }
  return out;
}
