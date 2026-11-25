import * as fs from 'fs';
import * as path from 'path';

export type Platform = NodeJS.Platform;

export function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function samePath(a: string, b: string, platform: Platform): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** True when linkPath is a symlink or junction to target, or (Windows file fallback) a hard link to it. */
export function isLinkTo(linkPath: string, target: string, platform: Platform = process.platform): boolean {
  const st = lstatOrNull(linkPath);
  if (!st) return false;
  if (st.isSymbolicLink()) {
    try {
      const raw = fs.readlinkSync(linkPath);
      const abs = path.resolve(path.dirname(linkPath), raw.replace(/^\\\\\?\\/, ''));
      return samePath(abs, target, platform);
    } catch {
      return false;
    }
  }
  if (platform === 'win32' && st.isFile()) {
    const t = lstatOrNull(target);
    return !!t && t.isFile() && t.ino === st.ino && t.dev === st.dev && st.nlink > 1;
  }
  return false;
}

/** A symlink (or junction) whose target is gone. */
export function isDanglingLink(p: string): boolean {
  const st = lstatOrNull(p);
  if (!st || !st.isSymbolicLink()) return false;
  try {
    fs.statSync(p);
    return false;
  } catch {
    return true;
  }
}

export type LinkResult = 'ok' | 'created' | 'relinked' | 'blocked';

/**
 * Makes linkPath point at target. Never removes real data: when a real file or
 * folder sits at linkPath, returns 'blocked' and leaves it alone. A wrong or
 * dangling link (only the link, never what it points to) is replaced.
 */
export function ensureLink(
  target: string,
  linkPath: string,
  isDir: boolean,
  platform: Platform = process.platform,
): LinkResult {
  if (isLinkTo(linkPath, target, platform)) return 'ok';
  const st = lstatOrNull(linkPath);
  let result: LinkResult = 'created';
  if (st) {
    if (!st.isSymbolicLink()) return 'blocked';
    fs.unlinkSync(linkPath);
    result = 'relinked';
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  createLink(target, linkPath, isDir, platform);
  return result;
}

export function createLink(target: string, linkPath: string, isDir: boolean, platform: Platform = process.platform): void {
  if (platform !== 'win32') {
    fs.symlinkSync(target, linkPath);
    return;
  }
  if (isDir) {
    // Junctions need no admin rights or Developer Mode.
    fs.symlinkSync(target, linkPath, 'junction');
    return;
  }
  try {
    fs.symlinkSync(target, linkPath, 'file');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
    // File symlinks need Developer Mode. A hard link works without it, but an atomic
    // save replaces it with a separate file; Doctor and Repair detect and fix that.
    fs.linkSync(target, linkPath);
  }
}

/** Removes a link only (never a real file or folder). Returns false when linkPath is not a link. */
export function removeLink(linkPath: string): boolean {
  const st = lstatOrNull(linkPath);
  if (!st || !st.isSymbolicLink()) return false;
  // Junctions on Windows are removed with rmdir semantics; unlink handles both in Node.
  fs.unlinkSync(linkPath);
  return true;
}
