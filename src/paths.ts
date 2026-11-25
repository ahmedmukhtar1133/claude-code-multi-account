import * as fs from 'fs';
import * as path from 'path';

export interface Account {
  name: string;
  /** Config folder relative to home, absolute, or null/empty for the default account (~/.claude). */
  folder?: string | null;
}

export const isDefault = (a: Account): boolean => !a.folder || a.folder.trim() === '';

/** Resolves a setting path ("~/x", "x" relative to home, or absolute). */
export function resolveFromHome(p: string, home: string): string {
  const t = p.trim();
  if (t === '~') return home;
  if (t.startsWith('~/') || t.startsWith('~\\')) return path.join(home, t.slice(2));
  return path.isAbsolute(t) ? path.normalize(t) : path.join(home, t);
}

export const storeDir = (home: string): string => path.join(home, '.claude');

export function accountDir(a: Account, home: string): string {
  return isDefault(a) ? storeDir(home) : resolveFromHome(a.folder as string, home);
}

/** Folder for this extension's own data: lock, backups and adoption journals. Outside ~/.claude on purpose. */
export function supportDir(home: string): string {
  // Installs from before the rename keep their folder, so existing undo journals stay valid.
  const legacy = path.join(home, '.claude-shared-profiles');
  return fs.existsSync(legacy) ? legacy : path.join(home, '.claude-multi-account');
}

export function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'account';
}

/** The value CLAUDE_CONFIG_DIR must have for an account; undefined means "unset it". */
export function configDirEnv(a: Account, home: string): string | undefined {
  return isDefault(a) ? undefined : accountDir(a, home);
}
