import * as fs from 'fs';
import * as path from 'path';
import { isOwnInMixed, MERGED_JSON, MIXED_DIRS, SHARED_FILES, SHARED_ITEMS } from './layout';
import { Journal } from './journal';
import { ensureLink, isLinkTo, lstatOrNull, Platform } from './link';

export interface SyncContext {
  /** The account folder being linked to the store. */
  accountRoot: string;
  /** The store (~/.claude). */
  store: string;
  /** Short account name used in run folder names. */
  tag: string;
  journal: Journal;
  platform: Platform;
  /** Project keys (folder names under projects/) that stay per account. */
  unsharedProjects: ReadonlySet<string>;
  /** Project key of the open workspace, linked ahead of Claude Code starting. */
  currentProject?: string;
  /** Windows repair: when a broken hard link left two copies, keep the newer one. */
  preferNewer?: boolean;
  /** Human-readable notes for the user (kept copies, skipped items). */
  notes: string[];
  /** Incoming files that clashed with a different file in the store, relative to the account folder. */
  kept: string[];
}

const exists = (p: string) => lstatOrNull(p) !== null;

function rel(ctx: SyncContext, p: string): string {
  return path.relative(ctx.accountRoot, p);
}

function backupPath(ctx: SyncContext, p: string): string {
  return path.join(ctx.journal.runDir, 'moved', rel(ctx, p));
}

/** Where a clashing incoming file goes: outside ~/.claude, so Claude Code never loads it as an extra agent, command or skill. */
export function keptPath(ctx: SyncContext, p: string): string {
  return path.join(ctx.journal.runDir, 'kept', rel(ctx, p));
}

function mkdirp(ctx: SyncContext, dir: string): void {
  if (exists(dir)) return;
  mkdirp(ctx, path.dirname(dir));
  ctx.journal.record({ op: 'mkdir', path: dir });
  fs.mkdirSync(dir);
}

export function move(ctx: SyncContext, from: string, to: string): void {
  if (isInside(to, ctx.journal.runDir)) {
    // The run's own backup folder: not journaled, and kept after an undo.
    ctx.journal.record({ op: 'move', from, to });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return;
  }
  mkdirp(ctx, path.dirname(to));
  ctx.journal.record({ op: 'move', from, to });
  fs.renameSync(from, to);
}

function linkInto(ctx: SyncContext, target: string, linkPath: string, isDir: boolean): void {
  if (isLinkTo(linkPath, target, ctx.platform)) return;
  const st = lstatOrNull(linkPath);
  if (st?.isSymbolicLink()) unlinkOnly(ctx, linkPath);
  ctx.journal.record({ op: 'link', path: linkPath, target, isDir });
  const r = ensureLink(target, linkPath, isDir, ctx.platform);
  if (r === 'blocked') ctx.notes.push(`Not linked, something is in the way: ${linkPath}`);
}

function unlinkOnly(ctx: SyncContext, linkPath: string): void {
  let target = '';
  let isDir = false;
  try {
    target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    isDir = lstatOrNull(target)?.isDirectory() ?? false;
  } catch {
    /* unreadable link */
  }
  ctx.journal.record({ op: 'unlink', path: linkPath, target, isDir });
  fs.unlinkSync(linkPath);
}

function sameContent(a: string, b: string): boolean {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function isInside(child: string, parent: string): boolean {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/**
 * Moves everything at `incoming` into `target` inside the store without losing
 * anything. Folders merge entry by entry. On a clash the store's copy stays in
 * use and the incoming copy goes to the run's "kept" folder (or "moved" when both
 * are identical), never into the store. history.jsonl is appended.
 */
export function mergeInto(ctx: SyncContext, incoming: string, target: string): void {
  const inSt = lstatOrNull(incoming);
  if (!inSt) return;

  if (inSt.isSymbolicLink()) {
    let dest = '';
    try {
      dest = path.resolve(path.dirname(incoming), fs.readlinkSync(incoming));
    } catch {
      /* unreadable */
    }
    // A link into the store already shares its data; dropping the link loses nothing.
    if (dest && isInside(dest, ctx.store)) {
      unlinkOnly(ctx, incoming);
      return;
    }
  }

  const tSt = lstatOrNull(target);
  if (!tSt) {
    move(ctx, incoming, target);
    return;
  }

  if (inSt.isDirectory() && tSt.isDirectory()) {
    for (const child of fs.readdirSync(incoming)) {
      mergeInto(ctx, path.join(incoming, child), path.join(target, child));
    }
    if (fs.readdirSync(incoming).length === 0) {
      ctx.journal.record({ op: 'rmdir', path: incoming });
      fs.rmdirSync(incoming);
    }
    return;
  }

  if (inSt.isFile() && tSt.isFile()) {
    if (sameContent(incoming, target)) {
      move(ctx, incoming, backupPath(ctx, incoming));
      return;
    }
    if (path.basename(target) === 'history.jsonl') {
      appendHistory(ctx, incoming, target);
      return;
    }
    if (ctx.preferNewer && fs.statSync(incoming).mtimeMs > tSt.mtimeMs) {
      move(ctx, target, backupPath(ctx, incoming) + '.store-copy');
      move(ctx, incoming, target);
      ctx.notes.push(`Kept the newer ${rel(ctx, incoming)}; the older copy is in ${ctx.journal.runDir}`);
      return;
    }
  }

  move(ctx, incoming, keptPath(ctx, incoming));
  ctx.kept.push(rel(ctx, incoming));
}

/** Downloadable plugin content: clashes there are counted, not listed. */
const DOWNLOADED = [path.join('plugins', 'cache'), path.join('plugins', 'marketplaces')];

/** One summary note for the kept copies of a run. */
export function summarizeKept(ctx: SyncContext): void {
  if (!ctx.kept.length) return;
  const isDownloaded = (r: string) => DOWNLOADED.some((d) => r === d || r.startsWith(d + path.sep));
  const listed = ctx.kept.filter((r) => !isDownloaded(r));
  const downloaded = ctx.kept.length - listed.length;
  const dir = path.join(ctx.journal.runDir, 'kept');
  if (listed.length) ctx.notes.push(`${listed.length} file(s) differed from the shared copy, which stays in use. This account's versions are in ${dir}: ${listed.slice(0, 10).join(', ')}${listed.length > 10 ? ', …' : ''}`);
  if (downloaded) ctx.notes.push(`${downloaded} downloaded plugin file(s) differed; the shared versions stay in use (this account's copies are in ${dir}).`);
}

function appendHistory(ctx: SyncContext, incoming: string, target: string): void {
  let data = fs.readFileSync(incoming);
  const size = fs.statSync(target).size;
  if (size > 0) {
    const fd = fs.openSync(target, 'r');
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    fs.closeSync(fd);
    if (last[0] !== 0x0a) data = Buffer.concat([Buffer.from('\n'), data]);
  }
  // Move first, append second: undo then reverses the append while the source copy is still in the backup.
  const source = backupPath(ctx, incoming);
  move(ctx, incoming, source);
  ctx.journal.record({ op: 'append', file: target, offset: size, length: data.length, source });
  fs.appendFileSync(target, data);
}

/** Links one whole shared item (file or folder) of the account to the store. */
function syncShared(ctx: SyncContext, item: string): void {
  const a = path.join(ctx.accountRoot, item);
  const s = path.join(ctx.store, item);
  const isDir = !SHARED_FILES.has(item);
  if (isLinkTo(a, s, ctx.platform) && exists(s)) return;

  const st = lstatOrNull(a);
  if (st?.isSymbolicLink()) unlinkOnly(ctx, a);
  else if (st) mergeInto(ctx, a, s);

  if (exists(a)) {
    // Merge left something behind (it should not); never link over data.
    ctx.notes.push(`Not linked, something is in the way: ${a}`);
    return;
  }
  if (!exists(s)) {
    if (!isDir) return; // Claude Code creates the file; the next repair adopts and links it.
    mkdirp(ctx, s);
  }
  linkInto(ctx, s, a, isDir);
}

/**
 * A folder that stays real in the account, with each child linked to the
 * store's child of the same name, except the `keep` names, which stay the account's own.
 */
/**
 * Merges a JSON object of entries (keyed by name) from the account's copy into the store's copy:
 * entries only the account has are added, and an entry with a newer lastUpdated replaces the store's.
 * The store file is rewritten in place, so links (and Windows hard links) to it stay valid.
 * Returns false when either file isn't a JSON object, so the caller can fall back to a normal merge.
 */
function mergeJsonEntries(incoming: string, target: string): boolean {
  let a: unknown;
  let s: unknown;
  try {
    a = JSON.parse(fs.readFileSync(incoming, 'utf8'));
    s = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return false;
  }
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(a) || !isObj(s)) return false;
  const stamp = (v: unknown) => (isObj(v) && typeof v.lastUpdated === 'string' ? Date.parse(v.lastUpdated) || 0 : 0);
  const out: Record<string, unknown> = { ...s };
  let changed = false;
  for (const [k, v] of Object.entries(a)) {
    if (!(k in out) || stamp(v) > stamp(out[k])) {
      if (JSON.stringify(out[k]) !== JSON.stringify(v)) changed = true;
      out[k] = v;
    }
  }
  if (changed) fs.writeFileSync(target, JSON.stringify(out, null, 2));
  return true;
}

function syncMixed(ctx: SyncContext, dir: string, keep: ReadonlySet<string>, ensure: readonly string[] = []): void {
  const a = path.join(ctx.accountRoot, dir);
  const s = path.join(ctx.store, dir);

  const st = lstatOrNull(a);
  if (st?.isSymbolicLink()) unlinkOnly(ctx, a);
  mkdirp(ctx, a);
  mkdirp(ctx, s);

  for (const child of fs.readdirSync(a)) {
    const p = path.join(a, child);
    const t = path.join(s, child);
    const cst = lstatOrNull(p);
    if (!cst) continue;
    if (keep.has(child) || isOwnInMixed(dir, child)) {
      // An item that became per-account: drop the link. A folder gets an empty one of its own;
      // a file (a cache) is recreated by Claude Code.
      if (cst.isSymbolicLink()) {
        const wasDir = (() => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return keep.has(child);
          }
        })();
        unlinkOnly(ctx, p);
        if (wasDir) mkdirp(ctx, p);
      }
      continue;
    }
    if (isLinkTo(p, t, ctx.platform)) {
      if (!exists(t)) unlinkOnly(ctx, p); // removed from the store
      continue;
    }
    if (cst.isSymbolicLink()) unlinkOnly(ctx, p);
    else if (cst.isFile() && MERGED_JSON[dir]?.has(child) && lstatOrNull(t)?.isFile() && mergeJsonEntries(p, t)) {
      move(ctx, p, backupPath(ctx, p)); // its entries are in the store now; relinked below
    } else mergeInto(ctx, p, t);
  }

  for (const name of ensure) if (!keep.has(name)) mkdirp(ctx, path.join(s, name));

  for (const child of fs.readdirSync(s)) {
    if (keep.has(child) || isOwnInMixed(dir, child)) continue;
    const t = path.join(s, child);
    const p = path.join(a, child);
    if (exists(p) && !lstatOrNull(p)!.isSymbolicLink()) {
      ctx.notes.push(`Not linked, something is in the way: ${p}`);
      continue;
    }
    linkInto(ctx, t, p, fs.statSync(t).isDirectory());
  }
}

/** Brings one non-default account folder in line with the store. Idempotent. */
export function syncAccount(ctx: SyncContext): void {
  if (path.resolve(ctx.accountRoot) === path.resolve(ctx.store)) return;
  fs.mkdirSync(ctx.accountRoot, { recursive: true });
  for (const item of SHARED_ITEMS) {
    if (item === 'projects' && ctx.unsharedProjects.size > 0) {
      syncMixed(ctx, item, ctx.unsharedProjects, ctx.currentProject ? [ctx.currentProject] : []);
    } else {
      syncShared(ctx, item);
    }
  }
  for (const [dir, keep] of Object.entries(MIXED_DIRS)) {
    syncMixed(ctx, dir, new Set(keep));
  }
  summarizeKept(ctx);
}
