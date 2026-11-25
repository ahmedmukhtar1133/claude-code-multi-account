import * as fs from 'fs';
import * as path from 'path';
import { classify } from './layout';
import { Journal, Op, runId, withLock } from './journal';
import { createLink, isLinkTo, lstatOrNull, Platform, removeLink } from './link';
import { storeDir, supportDir } from './paths';
import { SyncContext, syncAccount } from './sync';

export interface RunOptions {
  home: string;
  accountRoot: string;
  tag: string;
  unsharedProjects?: ReadonlySet<string>;
  currentProject?: string;
  platform?: Platform;
  preferNewer?: boolean;
  now?: Date;
}

export interface RunResult {
  /** Folder holding the journal and backups, or null when nothing changed. */
  runDir: string | null;
  notes: string[];
}

/** Folders that Claude Code can download again; not copied into the backup. */
const SKIP_BACKUP = new Set([path.join('plugins', 'cache'), path.join('plugins', 'marketplaces')]);

function makeContext(o: RunOptions, kind: 'adopt' | 'repair'): SyncContext {
  const runDir = path.join(supportDir(o.home), 'runs', runId(`${kind}-${o.tag}`, o.now));
  return {
    accountRoot: o.accountRoot,
    store: storeDir(o.home),
    tag: o.tag,
    journal: new Journal(runDir),
    platform: o.platform ?? process.platform,
    unsharedProjects: o.unsharedProjects ?? new Set(),
    currentProject: o.currentProject,
    preferNewer: o.preferNewer,
    notes: [],
    kept: [],
  };
}

/** Copies the account's shareable data (not login, not plugin caches) before anything moves. */
export function backupShareable(accountRoot: string, dest: string): number {
  let bytes = 0;
  if (!fs.existsSync(accountRoot)) return 0;
  for (const name of fs.readdirSync(accountRoot)) {
    const kind = classify(name);
    if (kind !== 'shared' && kind !== 'mixed') continue;
    const src = path.join(accountRoot, name);
    const st = lstatOrNull(src);
    if (!st || st.isSymbolicLink()) continue;
    fs.cpSync(src, path.join(dest, name), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (p) => {
        const r = path.relative(accountRoot, p);
        if (SKIP_BACKUP.has(r)) return false;
        const s = lstatOrNull(p);
        if (s?.isFile()) bytes += s.size;
        return true;
      },
    });
  }
  return bytes;
}

/**
 * Adopts an existing config folder (for example ~/.claude-work): backs up its
 * shareable data, merges it into ~/.claude and replaces it with links. Its login
 * and account files stay where they are.
 */
export function adopt(o: RunOptions): RunResult {
  return withLock(supportDir(o.home), () => {
    const ctx = makeContext(o, 'adopt');
    const copyDir = path.join(ctx.journal.runDir, 'copy');
    fs.mkdirSync(copyDir, { recursive: true });
    backupShareable(o.accountRoot, copyDir);
    syncAccount(ctx);
    return { runDir: ctx.journal.runDir, notes: ctx.notes };
  });
}

/** Creates missing links and adopts new entries. Cheap when nothing changed; leaves no trace then. */
export function repair(o: RunOptions): RunResult {
  return withLock(supportDir(o.home), () => {
    const ctx = makeContext(o, 'repair');
    syncAccount(ctx);
    return { runDir: ctx.journal.used ? ctx.journal.runDir : null, notes: ctx.notes };
  });
}

const exists = (p: string) => lstatOrNull(p) !== null;

/** Reverses a run, newest change first. Skips (and reports) what can no longer be reversed safely. */
export function undo(home: string, runDir: string): string[] {
  return withLock(supportDir(home), () => {
    const ops = Journal.read(path.join(runDir, 'journal.jsonl')).reverse();
    const problems: string[] = [];
    for (const op of ops) {
      try {
        undoOne(op, problems);
      } catch (e) {
        problems.push(`${op.op}: ${(e as Error).message}`);
      }
    }
    fs.writeFileSync(path.join(runDir, 'undone'), new Date().toISOString());
    return problems;
  });
}

function undoOne(op: Op, problems: string[]): void {
  switch (op.op) {
    case 'move':
      if (!exists(op.to)) return; // never happened
      if (exists(op.from)) {
        problems.push(`Left in place, ${op.from} exists again: ${op.to}`);
        return;
      }
      fs.mkdirSync(path.dirname(op.from), { recursive: true });
      fs.renameSync(op.to, op.from);
      return;
    case 'mkdir':
      try {
        fs.rmdirSync(op.path); // only when empty
      } catch {
        /* not empty or gone: keep */
      }
      return;
    case 'rmdir':
      fs.mkdirSync(op.path, { recursive: true });
      return;
    case 'link':
      if (isLinkTo(op.path, op.target)) removeLink(op.path) || fs.unlinkSync(op.path);
      return;
    case 'unlink':
      if (!exists(op.path) && op.target) {
        fs.mkdirSync(path.dirname(op.path), { recursive: true });
        createLink(op.target, op.path, op.isDir);
      }
      return;
    case 'append': {
      if (!exists(op.file)) return;
      const buf = fs.readFileSync(op.file);
      const slice = buf.subarray(op.offset, op.offset + op.length);
      // The appended bytes, minus a newline we may have added in front.
      let src: Buffer | null = null;
      try {
        src = exists(op.source) ? fs.readFileSync(op.source) : null;
      } catch {
        src = null;
      }
      const matches = src !== null && (slice.equals(src) || slice.equals(Buffer.concat([Buffer.from('\n'), src])));
      if (!matches) {
        if (buf.length >= op.offset + op.length && src === null) return; // never happened or source gone
        problems.push(`History lines left in ${op.file}: the file changed in a way that can't be undone safely`);
        return;
      }
      fs.writeFileSync(op.file, Buffer.concat([buf.subarray(0, op.offset), buf.subarray(op.offset + op.length)]));
      return;
    }
  }
}

/** Runs of this extension, newest first. */
export function listRuns(home: string): { dir: string; name: string; undone: boolean }[] {
  const root = path.join(supportDir(home), 'runs');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => fs.existsSync(path.join(root, n, 'journal.jsonl')))
    .sort()
    .reverse()
    .map((n) => ({ dir: path.join(root, n), name: n, undone: fs.existsSync(path.join(root, n, 'undone')) }));
}

const MARKER = '.shared-profiles.json';

/** Marks an account folder as managed, so repairs run on it without asking. */
export function markSetUp(accountRoot: string, how: 'adopted' | 'created'): void {
  fs.writeFileSync(path.join(accountRoot, MARKER), JSON.stringify({ how, at: new Date().toISOString() }) + '\n');
}

export function isSetUp(accountRoot: string): boolean {
  return fs.existsSync(path.join(accountRoot, MARKER));
}

/** A folder that is missing, empty, or holds only links: safe to link without an adoption. */
export function isBlank(accountRoot: string): boolean {
  if (!fs.existsSync(accountRoot)) return true;
  return fs.readdirSync(accountRoot).every((n) => lstatOrNull(path.join(accountRoot, n))?.isSymbolicLink() || n === '.DS_Store');
}

/** Bytes an adoption copies into its backup (shareable data without plugin caches). */
export function shareableSize(accountRoot: string): number {
  let bytes = 0;
  const walk = (p: string, rel: string) => {
    if (SKIP_BACKUP.has(rel)) return;
    const st = lstatOrNull(p);
    if (!st || st.isSymbolicLink()) return;
    if (st.isFile()) bytes += st.size;
    else if (st.isDirectory()) for (const c of fs.readdirSync(p)) walk(path.join(p, c), path.join(rel, c));
  };
  if (!fs.existsSync(accountRoot)) return 0;
  for (const name of fs.readdirSync(accountRoot)) {
    const kind = classify(name);
    if (kind === 'shared' || kind === 'mixed') walk(path.join(accountRoot, name), name);
  }
  return bytes;
}
