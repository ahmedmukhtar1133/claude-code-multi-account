import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { adopt, isBlank, isSetUp, listRuns, markSetUp, repair, shareableSize, undo } from './adopt';
import { findClaude, isLoggedIn, runClaude } from './claudeCli';
import { Finding, runDoctor } from './doctor';
import { Busy } from './journal';
import { projectKey } from './layout';
import { describe, McpServer, parseGet, parseList } from './mcpSync';
import { Account, accountDir, configDirEnv, isDefault, resolveFromHome, slug, storeDir } from './paths';

const LAUNCH_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const home = os.homedir();
const K_CHOICE = 'account';
const K_EMPTY_WINDOW = 'emptyWindowAccount';
const K_NO_SETUP_PROMPT = 'noSetupPrompt';

let log: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let ctx: vscode.ExtensionContext;
let active: Account | undefined;
let signedIn: boolean | undefined;

// ---------- settings ----------

const cfg = () => vscode.workspace.getConfiguration('sharedProfiles');

function accounts(): Account[] {
  const raw = cfg().get<unknown[]>('accounts') ?? [];
  return raw
    .filter((a): a is Account => !!a && typeof (a as Account).name === 'string' && (a as Account).name.trim() !== '')
    .map((a) => ({ name: a.name.trim(), folder: a.folder ?? null }));
}

async function saveAccounts(list: Account[]): Promise<void> {
  await cfg().update('accounts', list.map((a) => (isDefault(a) ? { name: a.name, folder: null } : a)), vscode.ConfigurationTarget.Global);
}

function unsharedKeys(): Set<string> {
  return new Set((cfg().get<string[]>('unsharedProjects') ?? []).map((p) => projectKey(resolveFromHome(p, home))));
}

function currentProjectKey(): string | undefined {
  const f = vscode.workspace.workspaceFolders?.[0];
  return f && f.uri.scheme === 'file' ? projectKey(f.uri.fsPath) : undefined;
}

function chosenAccount(): Account | undefined {
  const list = accounts();
  if (!list.length) return undefined;
  const byName = (n?: string) => (n ? list.find((a) => a.name === n) : undefined);
  const stored = ctx.workspaceState.get<string>(K_CHOICE) ?? (vscode.workspace.workspaceFolders ? undefined : ctx.globalState.get<string>(K_EMPTY_WINDOW));
  return byName(stored) ?? byName(cfg().get<string>('defaultAccount')) ?? list.find(isDefault) ?? list[0];
}

async function rememberChoice(name: string): Promise<void> {
  await ctx.workspaceState.update(K_CHOICE, name);
  if (!vscode.workspace.workspaceFolders) await ctx.globalState.update(K_EMPTY_WINDOW, name);
}

// ---------- the switch itself ----------

/** Sets CLAUDE_CONFIG_DIR for this window's extension host (and so for Claude Code) and its terminals. */
function applyEnv(a: Account): void {
  const dir = configDirEnv(a, home);
  if (dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = dir;
  const col = ctx.environmentVariableCollection;
  col.persistent = false;
  col.clear();
  if (dir !== undefined) col.replace('CLAUDE_CONFIG_DIR', dir);
  col.description = `Claude account: ${a.name}`;
}

function repairOne(a: Account, quiet: boolean): string[] {
  if (isDefault(a)) return [];
  const dir = accountDir(a, home);
  const fresh = !isSetUp(dir);
  if (fresh && !isBlank(dir)) return []; // has its own data: needs an adoption, asked for separately
  try {
    const r = repair({
      home,
      accountRoot: dir,
      tag: slug(a.name),
      unsharedProjects: unsharedKeys(),
      currentProject: currentProjectKey(),
      preferNewer: process.platform === 'win32',
    });
    if (fresh) markSetUp(dir, 'created');
    for (const n of r.notes) log.appendLine(`[${a.name}] ${n}`);
    if (r.runDir) log.appendLine(`[${a.name}] links updated; journal in ${r.runDir}`);
    return r.notes;
  } catch (e) {
    if (e instanceof Busy) {
      if (!quiet) void vscode.window.showWarningMessage(e.message + ' Try again in a moment.');
      return [];
    }
    log.appendLine(`[${a.name}] repair failed: ${(e as Error).stack ?? e}`);
    if (!quiet) void vscode.window.showErrorMessage(`Repair of "${a.name}" failed: ${(e as Error).message}`);
    return [];
  }
}

// ---------- status bar ----------

function renderStatus(): void {
  if (!active) {
    status.text = '$(account) Set up accounts';
    status.tooltip = 'Use a different Claude account in this window while sharing history, memory and settings.';
  } else {
    const dir = accountDir(active, home);
    const state = signedIn === undefined ? 'checking' : signedIn ? 'yes' : 'no, sign in through the Claude Code panel';
    status.text = `$(account) ${active.name}${signedIn === false ? ' (signed out)' : ''}`;
    status.tooltip = new vscode.MarkdownString(
      `**Claude account for this window: ${active.name}**\n\nFolder: \`${dir}\`${isDefault(active) ? ' (default)' : ''}\n\nSigned in: ${state}\n\nClick to switch.`,
    );
  }
  status.show();
}

async function refreshSignedIn(): Promise<void> {
  const bin = findClaude(home);
  if (!bin || !active) return;
  signedIn = await isLoggedIn(bin, configDirEnv(active, home));
  renderStatus();
}

// ---------- commands ----------

async function cmdSwitch(): Promise<void> {
  type Item = vscode.QuickPickItem & { run: () => Promise<void> };
  const list = accounts();
  const items: Item[] = list.map((a) => ({
    label: `${a.name === active?.name ? '$(check)' : '$(account)'} ${a.name}`,
    description: isDefault(a) ? '~/.claude (default)' : `~/${path.relative(home, accountDir(a, home))}`,
    run: () => switchTo(a),
  }));
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator, run: async () => undefined },
    { label: '$(add) Add account…', run: cmdAddAccount },
    { label: '$(folder-opened) Adopt an existing config folder…', run: () => cmdAdoptFolder() },
    { label: '$(pulse) Doctor', run: cmdDoctor },
  );
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Claude account for this window' });
  await pick?.run();
}

async function switchTo(a: Account): Promise<void> {
  if (a.name === active?.name) return;
  await rememberChoice(a.name);
  const go = await vscode.window.showInformationMessage(
    `Reload this window to use "${a.name}"? Claude Code reads the account when it starts.`,
    'Reload',
  );
  if (go === 'Reload') await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/** Makes sure the account list has an entry for ~/.claude, asking for its name the first time. */
async function ensureDefaultListed(): Promise<Account[] | undefined> {
  const list = accounts();
  if (list.some(isDefault)) return list;
  const name = await vscode.window.showInputBox({
    title: 'Name for the account you are signed in to now (~/.claude)',
    value: 'Personal',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
  });
  if (!name) return undefined;
  const next = [{ name: name.trim(), folder: null }, ...list];
  await saveAccounts(next);
  return next;
}

async function cmdAddAccount(): Promise<void> {
  const list = await ensureDefaultListed();
  if (!list) return;
  const name = (
    await vscode.window.showInputBox({
      title: 'Name for the new account',
      placeHolder: 'Work',
      validateInput: (v) => (!v.trim() ? 'Enter a name' : list.some((a) => a.name === v.trim()) ? 'That name is taken' : undefined),
    })
  )?.trim();
  if (!name) return;
  let folder = path.join('.claude-accounts', slug(name));
  for (let i = 2; fs.existsSync(path.join(home, folder)) && !isBlank(path.join(home, folder)); i++) {
    folder = path.join('.claude-accounts', `${slug(name)}-${i}`);
  }
  const acct: Account = { name, folder: folder.split(path.sep).join('/') };
  await saveAccounts([...list, acct]);
  repairOne(acct, false);
  log.appendLine(`Added "${name}" in ~/${acct.folder}`);

  const from = active ?? list.find(isDefault)!;
  const copy = await vscode.window.showInformationMessage(
    `"${name}" is ready and shares history, memory, skills and settings. Copy the MCP servers of "${from.name}" to it? (MCP servers are stored with each login, so they aren't shared automatically.)`,
    'Copy MCP servers',
    'Skip',
  );
  if (copy === 'Copy MCP servers') await syncMcp(from, acct);
  const go = await vscode.window.showInformationMessage(
    `Switch this window to "${name}"? After the reload, sign in through the Claude Code panel. Sign-in goes through Anthropic; this extension never sees it.`,
    'Switch and reload',
  );
  if (go) {
    await rememberChoice(name);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

function candidateFolders(): string[] {
  const taken = new Set(accounts().map((a) => path.resolve(accountDir(a, home))));
  let names: string[] = [];
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith('.claude-') && !['.claude-shared-profiles', '.claude-mem'].includes(n) && !n.startsWith('.claude-manager'))
    .map((n) => path.join(home, n))
    .filter((p) => {
      try {
        if (!fs.statSync(p).isDirectory() || taken.has(path.resolve(p)) || isSetUp(p)) return false;
        return ['settings.json', '.claude.json', 'projects', 'history.jsonl'].some((f) => fs.existsSync(path.join(p, f)));
      } catch {
        return false;
      }
    });
}

function mb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MB`;
}

async function cmdAdoptFolder(preset?: string, presetName?: string): Promise<void> {
  let dir = preset;
  if (!dir) {
    const found = candidateFolders();
    const pick = await vscode.window.showQuickPick(
      [...found.map((p) => ({ label: `~/${path.relative(home, p)}`, dir: p })), { label: '$(folder) Browse…', dir: '' }],
      { placeHolder: 'Config folder of another account to share history with' },
    );
    if (!pick) return;
    dir = pick.dir;
    if (!dir) {
      const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(home) });
      if (!uri?.[0]) return;
      dir = uri[0].fsPath;
    }
  }
  if (path.resolve(dir) === path.resolve(storeDir(home))) {
    void vscode.window.showWarningMessage('~/.claude is the default account and the shared store; it needs no adoption.');
    return;
  }
  const list = await ensureDefaultListed();
  if (!list) return;
  const guess = path.basename(dir).replace(/^\.claude-?/, '') || 'Work';
  const name = (
    presetName ??
    (await vscode.window.showInputBox({
      title: `Name for the account in ${dir}`,
      value: guess.charAt(0).toUpperCase() + guess.slice(1),
      validateInput: (v) => (!v.trim() ? 'Enter a name' : list.some((a) => a.name === v.trim()) ? 'That name is taken' : undefined),
    }))
  )?.trim();
  if (!name) return;

  const size = shareableSize(dir);
  const ok = await vscode.window.showWarningMessage(
    `Adopt ${dir} as "${name}"?`,
    {
      modal: true,
      detail:
        `Its history, projects, memory, skills and settings move into ~/.claude, so every account sees them. A copy (${mb(size)}, plugin caches excluded) goes to ~/.claude-shared-profiles first, and "Undo an adoption" reverses every step.\n\n` +
        `Its login and account files stay where they are and are never read.\n\nWhere both folders have a different file with the same name, the copy in ~/.claude stays in use and this folder's copy is saved with the backup. Close Claude Code sessions that use this folder before continuing.`,
    },
    'Adopt',
  );
  if (ok !== 'Adopt') return;

  try {
    const r = adopt({ home, accountRoot: dir, tag: slug(name), unsharedProjects: unsharedKeys(), currentProject: currentProjectKey() });
    markSetUp(dir, 'adopted');
    const rel = path.relative(home, dir);
    const folder = rel.startsWith('..') || path.isAbsolute(rel) ? dir : rel.split(path.sep).join('/');
    await saveAccounts([...list, { name, folder }]);
    log.appendLine(`Adopted ${dir} as "${name}". Journal and backup: ${r.runDir}`);
    for (const n of r.notes) log.appendLine(`[${name}] ${n}`);
    const more = r.notes.length ? ' Some files differed; see the details for where this account\'s copies were saved.' : '';
    const btn = await vscode.window.showInformationMessage(`"${name}" now shares history, memory, skills and settings.${more}`, 'Show details', `Switch to ${name}`);
    if (btn === 'Show details') log.show();
    if (btn === `Switch to ${name}`) await switchTo({ name, folder });
  } catch (e) {
    log.appendLine(`Adoption of ${dir} failed: ${(e as Error).stack ?? e}`);
    void vscode.window.showErrorMessage(`Adoption failed: ${(e as Error).message}. Run "Undo an adoption" to reverse the steps that completed.`);
  }
}

async function cmdUndo(): Promise<void> {
  const runs = listRuns(home).filter((r) => !r.undone);
  if (!runs.length) {
    void vscode.window.showInformationMessage('Nothing to undo.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    runs.map((r) => ({ label: r.name.includes('-adopt-') ? '$(history) Adoption' : '$(tools) Repair', description: r.name, run: r })),
    { placeHolder: 'Run to reverse (newest first)' },
  );
  if (!pick) return;
  const ok = await vscode.window.showWarningMessage(
    `Reverse ${pick.run.name}?`,
    { modal: true, detail: 'Files go back to where they were. History written since then is kept. Close Claude Code sessions on that account first. The account stays in your list; remove it in Settings if you no longer want it.' },
    'Undo',
  );
  if (ok !== 'Undo') return;
  try {
    const problems = undo(home, pick.run.dir);
    const dir = accountsDirFromRun(pick.run.dir);
    if (dir && pick.run.name.includes('-adopt-')) fs.rmSync(path.join(dir, '.shared-profiles.json'), { force: true });
    for (const p of problems) log.appendLine(`[undo] ${p}`);
    if (problems.length) {
      log.show();
      void vscode.window.showWarningMessage(`Undone, with ${problems.length} item(s) left in place. See the output panel.`);
    } else void vscode.window.showInformationMessage('Undone.');
  } catch (e) {
    void vscode.window.showErrorMessage(`Undo failed: ${(e as Error).message}`);
  }
}

/** The account folder a run worked on, read from its first journaled path. */
function accountsDirFromRun(runDir: string): string | undefined {
  try {
    const first = fs.readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8').split('\n').find((l) => l.includes('"move"') || l.includes('"link"'));
    if (!first) return undefined;
    const op = JSON.parse(first) as { from?: string; path?: string };
    const p = op.from ?? op.path ?? '';
    return accounts().map((a) => accountDir(a, home)).find((d) => p.startsWith(d + path.sep));
  } catch {
    return undefined;
  }
}

async function cmdRepair(): Promise<void> {
  const notes: string[] = [];
  const skipped: string[] = [];
  for (const a of accounts()) {
    if (isDefault(a)) continue;
    const dir = accountDir(a, home);
    if (!isSetUp(dir) && !isBlank(dir)) {
      skipped.push(a.name);
      continue;
    }
    notes.push(...repairOne(a, false));
  }
  if (skipped.length) {
    const btn = await vscode.window.showWarningMessage(`Not repaired, these folders hold their own data and need an adoption first: ${skipped.join(', ')}.`, 'Adopt');
    if (btn) await cmdAdoptFolder();
    return;
  }
  void vscode.window.showInformationMessage(notes.length ? `Links repaired. ${notes.length} note(s) in the output panel.` : 'Links repaired.');
}

async function cmdDoctor(): Promise<void> {
  const bin = findClaude(home);
  const list = accounts();
  const loggedIn: Record<string, boolean | undefined> = {};
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking accounts…' }, async () => {
    if (bin) await Promise.all(list.map(async (a) => (loggedIn[a.name] = await isLoggedIn(bin, configDirEnv(a, home)))));
  });
  const claudeCfg = vscode.workspace.getConfiguration('claudeCode');
  const findings: Finding[] = runDoctor({
    home,
    accounts: list,
    claudeEnvSetting: claudeCfg.get('environmentVariables'),
    claudeProcessWrapper: claudeCfg.get<string>('claudeProcessWrapper') || undefined,
    launchConfigDir: LAUNCH_CONFIG_DIR,
    extensions: vscode.extensions.all.map((e) => e.id),
    loggedIn,
    unsharedProjectKeys: unsharedKeys(),
  });
  if (!bin) findings.unshift({ level: 'warn', message: 'Could not find the claude CLI, so sign-in state was not checked.' });
  if (!list.length) findings.unshift({ level: 'info', message: 'No accounts set up yet. Run "Shared Profiles: Add account" or "Adopt an existing config folder".' });
  const icon = { ok: '✓', info: 'i', warn: '!', error: '✗' } as const;
  log.appendLine(`--- Doctor ${new Date().toLocaleString()} (this window: ${active?.name ?? 'none'}, CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? 'unset'})`);
  for (const f of findings) log.appendLine(`${icon[f.level]} ${f.message}`);
  log.show(true);
  const worst = findings.find((f) => f.level === 'error') ?? findings.find((f) => f.level === 'warn');
  if (worst) {
    const btn = await vscode.window.showWarningMessage(`Doctor: ${worst.message}`, ...(findings.some((f) => f.fix) ? ['Repair links'] : []));
    if (btn) await cmdRepair();
  }
}

async function pickAccount(placeHolder: string, exclude?: Account): Promise<Account | undefined> {
  const pick = await vscode.window.showQuickPick(
    accounts().filter((a) => a.name !== exclude?.name).map((a) => ({ label: a.name, a })),
    { placeHolder },
  );
  return pick?.a;
}

async function cmdSyncMcp(): Promise<void> {
  if (accounts().length < 2) {
    void vscode.window.showInformationMessage('Add a second account first.');
    return;
  }
  const from = await pickAccount('Copy MCP servers from');
  if (!from) return;
  const to = await pickAccount('Copy them to', from);
  if (to) await syncMcp(from, to);
}

/** Copies user-scope MCP servers through the official CLI. Never opens .claude.json. */
async function syncMcp(from: Account, to: Account): Promise<void> {
  const bin = findClaude(home);
  if (!bin) {
    void vscode.window.showErrorMessage('Could not find the claude CLI.');
    return;
  }
  const src = configDirEnv(from, home);
  const dst = configDirEnv(to, home);
  const candidates = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Reading MCP servers of "${from.name}" (Claude Code checks each one, this can take a moment)…` },
    async () => {
      const [a, b] = await Promise.all([
        runClaude(bin, ['mcp', 'list'], src, { cwd: home, timeoutMs: 120_000 }),
        runClaude(bin, ['mcp', 'list'], dst, { cwd: home, timeoutMs: 120_000 }),
      ]);
      const have = new Set(parseList(b.stdout));
      const out: McpServer[] = [];
      for (const n of parseList(a.stdout).filter((n) => !have.has(n))) {
        const g = await runClaude(bin, ['mcp', 'get', n], src, { cwd: home, timeoutMs: 60_000 });
        const s = parseGet(n, g.stdout);
        if (s) out.push(s);
      }
      return out;
    },
  );
  if (!candidates.length) {
    void vscode.window.showInformationMessage(`"${to.name}" already has every user MCP server of "${from.name}".`);
    return;
  }
  const picks = await vscode.window.showQuickPick(
    candidates.map((s) => ({
      label: s.name,
      description: s.warnings.length ? '$(warning) check by hand' : undefined,
      detail: describe(s) + (s.warnings.length ? `  ·  ${s.warnings.join('; ')}` : ''),
      picked: s.warnings.length === 0,
      s,
    })),
    { canPickMany: true, placeHolder: `MCP servers to add to "${to.name}" (values of env and headers are copied but not shown)` },
  );
  if (!picks?.length) return;
  const failed: string[] = [];
  for (const p of picks) {
    const r = await runClaude(bin, ['mcp', 'add-json', '--scope', 'user', p.s.name, '-'], dst, { cwd: home, input: JSON.stringify(p.s.config) });
    if (r.code !== 0) failed.push(p.s.name);
    log.appendLine(`[mcp] ${p.s.name} to "${to.name}": ${r.code === 0 ? 'added' : 'failed: ' + (r.stderr || r.stdout).trim().split('\n')[0]}`);
  }
  if (failed.length) void vscode.window.showWarningMessage(`Could not add: ${failed.join(', ')}. See the output panel.`);
  else void vscode.window.showInformationMessage(`Added ${picks.length} MCP server(s) to "${to.name}".`);
}

// ---------- startup ----------

async function offerSetup(): Promise<void> {
  if (ctx.globalState.get(K_NO_SETUP_PROMPT)) return;
  const found = candidateFolders();
  if (!found.length) return;
  const rel = `~/${path.relative(home, found[0])}`;
  const btn = await vscode.window.showInformationMessage(
    `Found ${rel}, the config folder of another Claude account. Share history, memory, skills and settings with it while keeping its own login?`,
    'Set up',
    'Not now',
    "Don't ask again",
  );
  if (btn === 'Set up') await cmdAdoptFolder(found[0]);
  if (btn === "Don't ask again") await ctx.globalState.update(K_NO_SETUP_PROMPT, true);
}

async function offerAdoptActive(a: Account): Promise<void> {
  const dir = accountDir(a, home);
  const btn = await vscode.window.showWarningMessage(
    `"${a.name}" uses ${dir}, which has its own history and settings. This window uses that account, but nothing is shared until the folder is adopted.`,
    'Adopt now',
  );
  if (btn) await cmdAdoptFolder(dir, a.name);
}

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  // First, before Claude Code starts: pick the account and set the variable.
  active = chosenAccount();
  if (active) applyEnv(active);

  log = vscode.window.createOutputChannel('Shared Profiles');
  context.subscriptions.push(log);
  log.appendLine(`Window account: ${active?.name ?? 'none'} (CLAUDE_CONFIG_DIR ${process.env.CLAUDE_CONFIG_DIR ?? 'unset'})`);

  if (active) {
    const dir = accountDir(active, home);
    if (!isDefault(active) && !isSetUp(dir) && !isBlank(dir)) void offerAdoptActive(active);
    else repairOne(active, true);
  }

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'sharedProfiles.switch';
  context.subscriptions.push(status);
  renderStatus();

  const reg = (id: string, fn: () => Promise<void>) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('sharedProfiles.switch', cmdSwitch);
  reg('sharedProfiles.addAccount', cmdAddAccount);
  reg('sharedProfiles.adoptFolder', () => cmdAdoptFolder());
  reg('sharedProfiles.undoAdoption', cmdUndo);
  reg('sharedProfiles.repair', cmdRepair);
  reg('sharedProfiles.doctor', cmdDoctor);
  reg('sharedProfiles.syncMcp', cmdSyncMcp);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('sharedProfiles')) return;
      const next = chosenAccount();
      if (next?.name !== active?.name || accountDir(next ?? { name: '' }, home) !== accountDir(active ?? { name: '' }, home)) {
        void vscode.window
          .showInformationMessage(`The account for this window is now "${next?.name ?? 'none'}". Reload to apply it.`, 'Reload')
          .then((b) => b && vscode.commands.executeCommand('workbench.action.reloadWindow'));
      }
      renderStatus();
    }),
  );

  if (!active) void offerSetup();
  else setTimeout(() => void refreshSignedIn(), 4000);
}

export function deactivate(): void {
  /* nothing to clean up: the variable lives only in this window's extension host */
}
