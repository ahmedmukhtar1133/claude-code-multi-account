import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { promptText, recentSessions, sessionTitle, sharedCounts, timeAgo } from '../src/stats';
import { cleanup, tempHome, write } from './helpers';

const line = (o: object) => JSON.stringify(o) + '\n';

test('sharedCounts counts projects with sessions, skills without synced, agents and commands', () => {
  const home = tempHome();
  try {
    write(home, {
      'projects/-a/1.jsonl': '',
      'projects/-a/2.jsonl': '',
      'projects/-b/memory/MEMORY.md': 'no sessions here',
      'skills/one/SKILL.md': '',
      'skills/synced/org/SKILL.md': '',
      'agents/x.md': '',
      'commands/y.md': '',
      'CLAUDE.md': '',
    });
    assert.deepEqual(sharedCounts(home), { projects: 1, sessions: 2, skills: 1, agents: 1, commands: 1, hasClaudeMd: true, hasSettings: false });
  } finally {
    cleanup(home);
  }
});

test('sessionTitle prefers a custom title, then the AI title, then the first real prompt', () => {
  const home = tempHome();
  try {
    const f = path.join(home, 's.jsonl');
    fs.writeFileSync(f, line({ type: 'user', isMeta: true, message: { content: 'meta' } }) + line({ type: 'user', message: { content: '<command-name>/x</command-name>' } }) + line({ type: 'user', message: { content: [{ type: 'text', text: 'Fix the   build' }] } }));
    assert.equal(sessionTitle(f), 'Fix the build');
    fs.appendFileSync(f, line({ type: 'ai-title', aiTitle: 'Build fix' }));
    assert.equal(sessionTitle(f), 'Build fix');
    fs.appendFileSync(f, line({ type: 'custom-title', customTitle: 'My name' }) + 'not json\n');
    assert.equal(sessionTitle(f), 'My name');
  } finally {
    cleanup(home);
  }
});

test('recentSessions sorts newest first, limits, and marks active ones', () => {
  const home = tempHome();
  try {
    const now = Date.now();
    write(home, { 'p/old.jsonl': line({ type: 'ai-title', aiTitle: 'Old' }), 'p/new.jsonl': line({ type: 'ai-title', aiTitle: 'New' }), 'p/mid.jsonl': line({ type: 'user', message: { content: 'Middle one' } }), 'p/empty.jsonl': '' });
    fs.utimesSync(path.join(home, 'p/old.jsonl'), new Date(now - 86_400_000), new Date(now - 86_400_000));
    fs.utimesSync(path.join(home, 'p/mid.jsonl'), new Date(now - 3_600_000), new Date(now - 3_600_000));
    const r = recentSessions(path.join(home, 'p'), 2, now);
    assert.deepEqual(r.map((s) => [s.id, s.title, s.active]), [['new', 'New', true], ['mid', 'Middle one', false]]);
    assert.deepEqual(recentSessions(path.join(home, 'missing'), 3), []);
  } finally {
    cleanup(home);
  }
});

test('timeAgo reads naturally', () => {
  const now = 1_000_000_000_000;
  assert.equal(timeAgo(now - 30_000, now), 'now');
  assert.equal(timeAgo(now - 5 * 60_000, now), '5 min ago');
  assert.equal(timeAgo(now - 3 * 3_600_000, now), '3 h ago');
  assert.equal(timeAgo(now - 30 * 3_600_000, now), 'yesterday');
});

test('promptText drops editor context and slash-command wrappers', () => {
  assert.equal(promptText('<ide_selection>code here</ide_selection>\nWhy does this fail?'), 'Why does this fail?');
  assert.equal(promptText('<command-name>/clear</command-name>'), '');
  assert.equal(promptText([{ type: 'text', text: '<ide_opened_file>a.ts</ide_opened_file>' }, { type: 'text', text: 'Rename it' }]), 'Rename it');
});
