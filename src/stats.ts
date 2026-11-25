// Read-only facts for the side panel: what the accounts share, and recent sessions.
import * as fs from 'fs';
import * as path from 'path';
import { MIXED_DIRS } from './layout';

export interface SharedCounts {
  projects: number;
  sessions: number;
  skills: number;
  agents: number;
  commands: number;
  hasClaudeMd: boolean;
  hasSettings: boolean;
}

const list = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

export function sharedCounts(store: string): SharedCounts {
  let projects = 0;
  let sessions = 0;
  for (const p of list(path.join(store, 'projects'))) {
    const n = list(path.join(store, 'projects', p)).filter((f) => f.endsWith('.jsonl')).length;
    if (n > 0) {
      projects++;
      sessions += n;
    }
  }
  const keepSkills = new Set(MIXED_DIRS.skills);
  return {
    projects,
    sessions,
    skills: list(path.join(store, 'skills')).filter((n) => !keepSkills.has(n) && !n.startsWith('.')).length,
    agents: list(path.join(store, 'agents')).filter((n) => n.endsWith('.md')).length,
    commands: list(path.join(store, 'commands')).filter((n) => n.endsWith('.md')).length,
    hasClaudeMd: fs.existsSync(path.join(store, 'CLAUDE.md')),
    hasSettings: fs.existsSync(path.join(store, 'settings.json')),
  };
}

export interface SessionInfo {
  id: string;
  title: string;
  modified: number;
  active: boolean;
}

const ACTIVE_MS = 2 * 60 * 1000;

/** The typed text of a prompt: editor context blocks such as <ide_selection>...</ide_selection> removed. */
export function promptText(content: unknown): string {
  const parts: string[] = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const c of content) if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') parts.push(String((c as { text?: unknown }).text ?? ''));
  }
  for (const p of parts) {
    const t = p.replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').trim();
    if (t) return t;
  }
  return '';
}

const HEAD = 512 * 1024;
const TAIL = 1024 * 1024;

/** The start of a file (first prompt) and its end (Claude Code re-writes the title entry as the session goes on). */
function headAndTail(file: string): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (start: number, len: number) => {
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, start);
      return b.toString('utf8');
    };
    if (size <= HEAD + TAIL) return [read(0, size)];
    return [read(0, HEAD), read(size - TAIL, TAIL)];
  } finally {
    fs.closeSync(fd);
  }
}

/** Title the way Claude Code shows it: a custom title, else its AI title, else the first prompt. Empty when the session has none of these. */
export function sessionTitle(file: string): string {
  let parts: string[];
  try {
    parts = headAndTail(file);
  } catch {
    return '';
  }
  let custom = '';
  let ai = '';
  let first = '';
  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (!line.includes('"type"')) continue;
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(line);
      } catch {
        continue; // also skips a line cut in half at a chunk edge
      }
      if (j.type === 'custom-title' && typeof j.customTitle === 'string') custom = j.customTitle;
      else if (j.type === 'ai-title' && typeof j.aiTitle === 'string') ai = j.aiTitle;
      else if (!first && j.type === 'user' && !j.isMeta) {
        const t = promptText((j.message as { content?: unknown } | undefined)?.content);
        if (t) first = t;
      }
    }
  }
  const title = (custom || ai || first).replace(/\s+/g, ' ').trim();
  return title.length > 90 ? title.slice(0, 87) + '...' : title;
}

/** Newest sessions of one project folder (projects/<key>), newest first. */
export function recentSessions(projectDir: string, limit: number, now = Date.now()): SessionInfo[] {
  const files = list(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const p = path.join(projectDir, f);
      let modified = 0;
      try {
        modified = fs.statSync(p).mtimeMs;
      } catch {
        /* gone */
      }
      return { id: f.slice(0, -6), p, modified };
    })
    .filter((f) => f.modified > 0)
    .sort((a, b) => b.modified - a.modified);
  // Sessions without a single prompt (only /clear, for example) are left out, as Claude Code's own list does.
  const out: SessionInfo[] = [];
  for (const f of files.slice(0, limit * 3)) {
    const title = sessionTitle(f.p);
    if (title) out.push({ id: f.id, title, modified: f.modified, active: now - f.modified < ACTIVE_MS });
    if (out.length === limit) break;
  }
  return out;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(ms).toLocaleDateString();
}
