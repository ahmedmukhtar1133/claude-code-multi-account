import * as fs from 'fs';
import * as path from 'path';

export type Op =
  | { op: 'move'; from: string; to: string }
  | { op: 'mkdir'; path: string }
  | { op: 'rmdir'; path: string }
  | { op: 'link'; path: string; target: string; isDir: boolean }
  | { op: 'unlink'; path: string; target: string; isDir: boolean }
  | { op: 'append'; file: string; offset: number; length: number; source: string };

/**
 * Write-ahead log of every change. Each op is recorded before it is carried out,
 * so undo must tolerate an op that never happened. The run folder (journal plus
 * backups) is created on the first record, so a run that changes nothing leaves nothing.
 */
export class Journal {
  readonly file: string;
  private started = false;

  constructor(readonly runDir: string) {
    this.file = path.join(runDir, 'journal.jsonl');
  }

  get used(): boolean {
    return this.started;
  }

  record(op: Op): void {
    if (!this.started) {
      fs.mkdirSync(this.runDir, { recursive: true });
      this.started = true;
    }
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(op) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  static read(file: string): Op[] {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Op);
  }
}

export class Busy extends Error {}

const STALE_MS = 2 * 60 * 1000;

/** Cross-window lock: mkdir is atomic on every platform. A lock older than two minutes is stale. */
export function withLock<T>(supportDir: string, fn: () => T): T {
  const lock = path.join(supportDir, 'lock');
  fs.mkdirSync(supportDir, { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      /* removed meanwhile */
    }
    if (age < STALE_MS) throw new Busy('Another window is updating the account folders.');
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function runId(tag: string, now = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return `${ts}-${tag}`;
}
