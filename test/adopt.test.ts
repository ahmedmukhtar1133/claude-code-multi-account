import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { adopt, listRuns, repair, undo } from '../src/adopt';
import { projectKey } from '../src/layout';
import { cleanup, isSymlink, read, snapshot, tempHome, write } from './helpers';

const STORE = {
  'projects/-p-a/s1.jsonl': 'store session\n',
  'projects/-p-a/memory/MEMORY.md': 'store memory\n',
  'history.jsonl': '{"h":1}\n',
  'settings.json': '{"theme":"dark"}',
  'CLAUDE.md': 'shared rules',
  'skills/mine/SKILL.md': 'my skill',
  'skills/synced/default-org/SKILL.md': 'default org skill',
  'plugins/cache/p/1/plugin.json': '{}',
  'plugins/installed_plugins.json': '{"a":1}',
  'plugins/synced/x.json': 'default synced',
  '.claude.json': 'not read',
  'manager-accounts/tokens': 'secret',
};

const WORK = {
  'projects/-p-a/s2.jsonl': 'work session\n',
  'projects/-p-a/memory/MEMORY.md': 'work memory\n',
  'projects/-p-b/s3.jsonl': 'work only project\n',
  'history.jsonl': '{"h":2}\n',
  'settings.json': '{"theme":"light"}',
  'CLAUDE.md': 'shared rules',
  'skills/work-skill/SKILL.md': 'work skill',
  'skills/synced/work-org/SKILL.md': 'work org skill',
  'plugins/installed_plugins.json': '{"b":2}',
  'plugins/synced/y.json': 'work synced',
  '.claude.json': 'work identity',
  '.credentials.json': 'work login',
  'sessions/1.json': '{}',
  'manager-accounts/tokens': 'work secret',
  'unknown-thing': 'leave me',
};

function setup() {
  const home = tempHome();
  write(path.join(home, '.claude'), STORE);
  write(path.join(home, '.claude-work'), WORK);
  return { home, store: path.join(home, '.claude'), work: path.join(home, '.claude-work') };
}

test('adopting a folder merges shared data, keeps account data, links everything', () => {
  const { home, store, work } = setup();
  try {
    const r = adopt({ home, accountRoot: work, tag: 'work' });
    assert.ok(r.runDir);

    // Shared items are links into the store.
    for (const item of ['projects', 'history.jsonl', 'settings.json', 'CLAUDE.md']) {
      assert.ok(isSymlink(path.join(work, item)), item);
    }
    // Sessions from both accounts sit side by side; clashing memory is kept twice.
    assert.equal(read(store, 'projects/-p-a/s1.jsonl'), 'store session\n');
    assert.equal(read(store, 'projects/-p-a/s2.jsonl'), 'work session\n');
    assert.equal(read(store, 'projects/-p-b/s3.jsonl'), 'work only project\n');
    assert.equal(read(store, 'projects/-p-a/memory/MEMORY.md'), 'store memory\n');
    assert.equal(read(r.runDir!, 'kept/projects/-p-a/memory/MEMORY.md'), 'work memory\n');
    // History appended, settings: store wins, incoming kept beside it.
    assert.equal(read(store, 'history.jsonl'), '{"h":1}\n{"h":2}\n');
    assert.equal(read(store, 'settings.json'), '{"theme":"dark"}');
    assert.equal(read(r.runDir!, 'kept/settings.json'), '{"theme":"light"}');
    // Nothing named after the account lands in the store.
    assert.deepEqual(Object.keys(snapshot(store)).filter((k) => k.includes('from-work')), []);

    // Mixed folders: real folder, shared children linked, synced stays the account's own.
    assert.ok(!isSymlink(path.join(work, 'skills')));
    assert.ok(isSymlink(path.join(work, 'skills/mine')));
    assert.ok(isSymlink(path.join(work, 'skills/work-skill')));
    assert.equal(read(store, 'skills/work-skill/SKILL.md'), 'work skill');
    assert.ok(!isSymlink(path.join(work, 'skills/synced')));
    assert.equal(read(work, 'skills/synced/work-org/SKILL.md'), 'work org skill');
    assert.ok(!fs.existsSync(path.join(store, 'skills/synced/work-org')));
    assert.ok(isSymlink(path.join(work, 'plugins/cache')));
    assert.equal(read(work, 'plugins/synced/y.json'), 'work synced');

    // Login, identity, runtime, unknown and claude-manager data untouched.
    assert.equal(read(work, '.claude.json'), 'work identity');
    assert.equal(read(work, '.credentials.json'), 'work login');
    assert.equal(read(work, 'manager-accounts/tokens'), 'work secret');
    assert.equal(read(work, 'unknown-thing'), 'leave me');
    assert.equal(read(store, '.claude.json'), 'not read');

    // Backup holds the shareable data only.
    assert.equal(read(r.runDir!, 'copy/settings.json'), '{"theme":"light"}');
    assert.ok(!fs.existsSync(path.join(r.runDir!, 'copy/.credentials.json')));
    assert.ok(r.notes.some((n) => n.includes('settings.json') && n.includes('kept')));
  } finally {
    cleanup(home);
  }
});

test('undo restores both folders exactly', () => {
  const { home, store, work } = setup();
  try {
    const before = { store: snapshot(store), work: snapshot(work) };
    const r = adopt({ home, accountRoot: work, tag: 'work' });
    const problems = undo(home, r.runDir!);
    assert.deepEqual(problems, []);
    assert.deepEqual(snapshot(store), before.store);
    assert.deepEqual(snapshot(work), before.work);
    assert.equal(listRuns(home)[0].undone, true);
  } finally {
    cleanup(home);
  }
});

test('undo keeps history written after the adoption', () => {
  const { home, store, work } = setup();
  try {
    const r = adopt({ home, accountRoot: work, tag: 'work' });
    fs.appendFileSync(path.join(store, 'history.jsonl'), '{"h":3}\n');
    assert.deepEqual(undo(home, r.runDir!), []);
    assert.equal(read(store, 'history.jsonl'), '{"h":1}\n{"h":3}\n');
    assert.equal(read(work, 'history.jsonl'), '{"h":2}\n');
  } finally {
    cleanup(home);
  }
});

test('repair links a fresh account and leaves no trace when nothing changes', () => {
  const { home, store } = setup();
  const fresh = path.join(home, '.claude-accounts/personal');
  try {
    const first = repair({ home, accountRoot: fresh, tag: 'personal' });
    assert.ok(first.runDir);
    assert.ok(isSymlink(path.join(fresh, 'projects')));
    assert.ok(isSymlink(path.join(fresh, 'settings.json')));
    assert.ok(isSymlink(path.join(fresh, 'todos')));
    assert.ok(fs.existsSync(path.join(store, 'todos')));
    assert.ok(!fs.existsSync(path.join(fresh, 'skills/synced')));
    const second = repair({ home, accountRoot: fresh, tag: 'personal' });
    assert.equal(second.runDir, null);
    assert.deepEqual(second.notes, []);
  } finally {
    cleanup(home);
  }
});

test('repair adopts a skill created while on another account, and drops links to removed skills', () => {
  const { home, store, work } = setup();
  try {
    adopt({ home, accountRoot: work, tag: 'work' });
    write(work, { 'skills/new-one/SKILL.md': 'made on work' });
    fs.rmSync(path.join(store, 'skills/mine'), { recursive: true });
    repair({ home, accountRoot: work, tag: 'work' });
    assert.ok(isSymlink(path.join(work, 'skills/new-one')));
    assert.equal(read(store, 'skills/new-one/SKILL.md'), 'made on work');
    assert.ok(!fs.existsSync(path.join(work, 'skills/mine')) && !isSymlink(path.join(work, 'skills/mine')));
  } finally {
    cleanup(home);
  }
});

test('a file Claude Code created before the link existed is adopted on the next repair', () => {
  const { home, store } = setup();
  fs.rmSync(path.join(store, 'CLAUDE.md'));
  const fresh = path.join(home, '.claude-accounts/p');
  try {
    repair({ home, accountRoot: fresh, tag: 'p' });
    assert.ok(!fs.existsSync(path.join(fresh, 'CLAUDE.md')));
    write(fresh, { 'CLAUDE.md': 'written on p' });
    repair({ home, accountRoot: fresh, tag: 'p' });
    assert.ok(isSymlink(path.join(fresh, 'CLAUDE.md')));
    assert.equal(read(store, 'CLAUDE.md'), 'written on p');
  } finally {
    cleanup(home);
  }
});

test('unshared projects stay per account; switching back to shared merges them', () => {
  const { home, store, work } = setup();
  try {
    adopt({ home, accountRoot: work, tag: 'work' });
    const nda = projectKey('/clients/nda');
    const cur = projectKey('/p/current');
    repair({ home, accountRoot: work, tag: 'work', unsharedProjects: new Set([nda]), currentProject: cur });
    assert.ok(!isSymlink(path.join(work, 'projects')));
    assert.ok(isSymlink(path.join(work, 'projects/-p-a')));
    assert.ok(isSymlink(path.join(work, 'projects', cur)));
    write(work, { [`projects/${nda}/s.jsonl`]: 'secret work session' });
    repair({ home, accountRoot: work, tag: 'work', unsharedProjects: new Set([nda]) });
    assert.ok(!fs.existsSync(path.join(store, 'projects', nda)));

    repair({ home, accountRoot: work, tag: 'work' });
    assert.ok(isSymlink(path.join(work, 'projects')));
    assert.equal(read(store, `projects/${nda}/s.jsonl`), 'secret work session');
  } finally {
    cleanup(home);
  }
});

test('windows repair keeps the newer copy when a hard link was broken by a save', () => {
  const { home, store, work } = setup();
  try {
    adopt({ home, accountRoot: work, tag: 'work' });
    fs.unlinkSync(path.join(work, 'settings.json'));
    write(work, { 'settings.json': '{"theme":"newer"}' });
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(work, 'settings.json'), future, future);
    const r = repair({ home, accountRoot: work, tag: 'work', preferNewer: true });
    assert.equal(read(store, 'settings.json'), '{"theme":"newer"}');
    assert.ok(isSymlink(path.join(work, 'settings.json')));
    assert.ok(r.notes.some((n) => n.includes('newer')));
  } finally {
    cleanup(home);
  }
});

test('clashing plugin marketplace files never land in the store', () => {
  const { home, store, work } = setup();
  try {
    write(store, { 'plugins/marketplaces/m/plugins/x/commands/run.md': 'v2', 'plugins/marketplaces/m/agents/a.md': 'v2' });
    write(work, { 'plugins/marketplaces/m/plugins/x/commands/run.md': 'v1', 'plugins/marketplaces/m/agents/a.md': 'v1' });
    const before = Object.keys(snapshot(path.join(store, 'plugins/marketplaces'))).sort();
    const r = adopt({ home, accountRoot: work, tag: 'work' });
    assert.deepEqual(Object.keys(snapshot(path.join(store, 'plugins/marketplaces'))).sort(), before);
    assert.equal(read(store, 'plugins/marketplaces/m/agents/a.md'), 'v2');
    assert.equal(read(r.runDir!, 'kept/plugins/marketplaces/m/agents/a.md'), 'v1');
    assert.ok(r.notes.some((n) => n.startsWith('2 downloaded plugin file(s)')), JSON.stringify(r.notes));
  } finally {
    cleanup(home);
  }
});
