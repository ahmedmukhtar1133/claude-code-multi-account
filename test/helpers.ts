import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function tempHome(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'csp-test-')));
}

export function cleanup(home: string): void {
  fs.rmSync(home, { recursive: true, force: true });
}

/** Creates files from a map of relative path to content; a trailing "/" makes an empty folder. */
export function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    if (rel.endsWith('/')) {
      fs.mkdirSync(p, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

export const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

export const isSymlink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** A comparable picture of a folder tree: type, content and link targets. */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const rel = path.relative(root, p);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = 'L:' + fs.readlinkSync(p);
      else if (st.isDirectory()) {
        out[rel] = 'D';
        walk(p);
      } else out[rel] = 'F:' + fs.readFileSync(p, 'utf8');
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}
