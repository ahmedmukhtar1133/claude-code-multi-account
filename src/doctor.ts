import * as fs from 'fs';
import * as path from 'path';
import { classify, isOwnInMixed, MERGED_JSON, MIXED_DIRS, SHARED_FILES, SHARED_ITEMS } from './layout';
import { isDanglingLink, isLinkTo, lstatOrNull, Platform } from './link';
import { Account, accountDir, isDefault, storeDir } from './paths';

export type Level = 'ok' | 'info' | 'warn' | 'error';

/** A button on a finding: a panel command (see onPanelMessage) and its argument. */
export interface FindingAction {
  label: string;
  cmd: string;
  arg?: string;
}

export interface Finding {
  level: Level;
  /** Short heading for the panel card. */
  title?: string;
  message: string;
  /** Buttons that fix it, first one primary. */
  actions?: FindingAction[];
}

const REPAIR: FindingAction = { label: 'Repair links', cmd: 'repair' };

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
  /** Name of this window's account: its sign-in is fixed here, not by switching. */
  current?: string;
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
      out.push({
        level: 'error',
        title: 'settings.json overrides the account',
        message: 'settings.json sets env.CLAUDE_CONFIG_DIR. Every account shares settings.json, so this sends all of them to one folder.',
        actions: [{ label: 'Open settings.json', cmd: 'removeSettingsEnv' }],
      });
    }
  } catch {
    /* no or unreadable settings.json: nothing to check */
  }
  if (envNames(input.claudeEnvSetting).includes('CLAUDE_CONFIG_DIR')) {
    out.push({
      level: 'error',
      title: 'Claude Code setting overrides the account',
      message: 'claudeCode.environmentVariables sets CLAUDE_CONFIG_DIR, which overrides the account chosen for each window.',
      actions: [{ label: 'Remove it', cmd: 'removeClaudeEnvSetting' }],
    });
  }
  if (input.claudeProcessWrapper) {
    out.push({
      level: 'warn',
      title: 'Process wrapper is set',
      message: 'claudeCode.claudeProcessWrapper is set. Switching works only if the wrapper passes CLAUDE_CONFIG_DIR through unchanged.',
      actions: [{ label: 'Open setting', cmd: 'openSetting', arg: 'claudeCode.claudeProcessWrapper' }],
    });
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
    if (login === false) {
      out.push(
        a.name === input.current
          ? { level: 'warn', title: `${a.name} is signed out`, message: 'Sign in through the Claude Code panel in this window. This check updates on its own after you sign in.' }
          : {
              level: 'warn',
              title: `${a.name} is signed out`,
              message: 'Switch a window to it and sign in through the Claude Code panel.',
              actions: [{ label: `Switch to ${a.name}`, cmd: 'switchTo', arg: a.name }],
            },
      );
    }
    if (isDefault(a)) continue;
    out.push(...checkAccount(a, input.home, platform, input.unsharedProjectKeys ?? new Set()));
  }

  // Leftovers from token-copying switchers.
  const leftovers = tokenLeftovers(input.home, input.accounts);
  if (leftovers.length) {
    const managerInstalled = (input.extensions ?? []).some((id) => id.toLowerCase() === MANAGER_ID);
    out.push({
      level: 'warn',
      title: 'Leftover login tokens',
      message: `${leftovers.join(', ')} ${leftovers.length > 1 ? 'hold' : 'holds'} plain-text copies of login tokens saved by Claude Code Manager. This extension never reads ${leftovers.length > 1 ? 'them' : 'it'}.${
        managerInstalled ? ' Claude Code Manager is still installed and uses them; uninstall it first.' : ''
      }`,
      actions: managerInstalled
        ? [{ label: 'Show in Extensions', cmd: 'showExt', arg: MANAGER_ID }]
        : [{ label: leftovers.length > 1 ? 'Delete them' : 'Delete it', cmd: 'removeTokenLeftovers' }],
    });
  }
  const switchers = (input.extensions ?? []).filter((id) => id.toLowerCase() in OTHER_SWITCHERS);
  if (switchers.length) {
    const names = switchers.map((id) => OTHER_SWITCHERS[id.toLowerCase()]).join(', ');
    out.push({
      level: 'warn',
      title: 'Another account switcher is installed',
      message: `${names}. Two switchers fight over the account. Disable it, or turn off its account switching.`,
      actions: [{ label: 'Show in Extensions', cmd: 'showExt', arg: switchers.join(',') }],
    });
  }

  if (!out.some((f) => f.level === 'error' || f.level === 'warn')) out.push({ level: 'ok', message: 'Everything is linked and nothing overrides the per-window account.' });
  return out.map((f) => ({ ...f, message: tilde(f.message, input.home) }));
}

const MANAGER_ID = 'vishalguptax.claude-manager';

/** Shows paths inside the home folder as ~/..., which is shorter and doesn't print the user name. */
function tilde(s: string, home: string): string {
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return s.split(prefix).join('~/');
}

/** manager-accounts folders (Claude Code Manager's plain-text token copies) in ~/.claude and every account folder. */
export function tokenLeftoverDirs(home: string, accounts: Account[]): string[] {
  const dirs = new Set([storeDir(home), ...accounts.map((a) => accountDir(a, home))].map((d) => path.join(path.resolve(d), 'manager-accounts')));
  return [...dirs].filter((d) => {
    const st = lstatOrNull(d);
    return !!st && st.isDirectory() && !st.isSymbolicLink();
  });
}

function tokenLeftovers(home: string, accounts: Account[]): string[] {
  return tokenLeftoverDirs(home, accounts).map((d) => tilde(d, home));
}

function checkAccount(a: Account, home: string, platform: Platform, unshared: ReadonlySet<string>): Finding[] {
  const out: Finding[] = [];
  const dir = accountDir(a, home);
  const store = storeDir(home);
  if (!fs.existsSync(dir)) {
    out.push({ level: 'error', message: `"${a.name}": folder ${dir} is missing.`, title: `${a.name}: folder missing`, actions: [REPAIR] });
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
      if (keep.includes(child) || isOwnInMixed(m, child)) continue;
      // Claude Code replaces these on start; Repair merges them back on the next window start.
      if (MERGED_JSON[m]?.has(child)) continue;
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
    out.push({ level: 'warn', title: `${a.name}: not fully shared`, actions: [REPAIR], message: `Not linked yet: ${broken.slice(0, 8).join(', ')}${broken.length > 8 ? ` and ${broken.length - 8} more` : ''}.${hint}` });
  }
  const unknown = fs.readdirSync(dir).filter((n) => classify(n) === 'unknown');
  if (unknown.length) {
    out.push({ level: 'info', message: `"${a.name}": kept per account because this extension doesn't know them yet: ${unknown.join(', ')}.` });
  }
  return out;
}
