import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** The official Claude Code CLI: on PATH, or the binary bundled with the VS Code extension. */
export function findClaude(home: string, platform: NodeJS.Platform = process.platform): string | null {
  const exe = platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    if (fs.existsSync(p)) return p;
  }
  const local = path.join(home, '.local', 'bin', exe);
  if (fs.existsSync(local)) return local;
  for (const base of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.vscode-oss']) {
    const extDir = path.join(home, base, 'extensions');
    let names: string[] = [];
    try {
      names = fs.readdirSync(extDir).filter((n) => n.startsWith('anthropic.claude-code-')).sort().reverse();
    } catch {
      continue;
    }
    for (const n of names) {
      const p = path.join(extDir, n, 'resources', 'native-binary', exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI as a given account: configDir undefined means the default account (variable unset). */
export function runClaude(
  bin: string,
  args: string[],
  configDir: string | undefined,
  opts: { input?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, DISABLE_AUTOUPDATER: '1' };
  if (configDir === undefined) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = configDir;
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { env, cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Signed-in state through `claude auth status`; only the loggedIn flag is kept. */
export async function isLoggedIn(bin: string, configDir: string | undefined): Promise<boolean | undefined> {
  const r = await runClaude(bin, ['auth', 'status'], configDir, { timeoutMs: 20_000 });
  try {
    const j = JSON.parse(r.stdout) as { loggedIn?: unknown };
    return typeof j.loggedIn === 'boolean' ? j.loggedIn : undefined;
  } catch {
    return undefined;
  }
}
