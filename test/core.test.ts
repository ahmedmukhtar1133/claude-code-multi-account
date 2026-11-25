import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { classify, projectKey } from '../src/layout';
import { ensureLink, isLinkTo } from '../src/link';
import { accountDir, configDirEnv, resolveFromHome, slug } from '../src/paths';
import { Busy, withLock } from '../src/journal';
import { cleanup, tempHome, write } from './helpers';

test('classify keeps login and identity per account', () => {
  for (const n of ['.claude.json', '.credentials.json', 'sessions', 'ide', 'policy-limits.json', 'remote-settings.json.synced-at', '.last-cleanup']) {
    assert.equal(classify(n), 'account', n);
  }
  for (const n of ['projects', 'history.jsonl', 'settings.json', 'CLAUDE.md', 'agents', 'file-history']) {
    assert.equal(classify(n), 'shared', n);
  }
  assert.equal(classify('skills'), 'mixed');
  assert.equal(classify('plugins'), 'mixed');
  assert.equal(classify('manager-accounts'), 'never');
  assert.equal(classify('something-new'), 'unknown');
});

test('projectKey matches Claude Code folder names', () => {
  assert.equal(projectKey('/Users/a/Documents/My Proj'), '-Users-a-Documents-My-Proj');
  assert.equal(projectKey('/private/tmp/x-501/-Users-a'), '-private-tmp-x-501--Users-a');
});

test('paths resolve relative to home; default account unsets the variable', () => {
  const home = '/home/u';
  assert.equal(resolveFromHome('.claude-work', home), '/home/u/.claude-work');
  assert.equal(resolveFromHome('~/x/y', home), '/home/u/x/y');
  assert.equal(resolveFromHome('/abs/p', home), '/abs/p');
  assert.equal(accountDir({ name: 'Personal' }, home), '/home/u/.claude');
  assert.equal(configDirEnv({ name: 'Personal', folder: null }, home), undefined);
  assert.equal(configDirEnv({ name: 'Work', folder: '.claude-work' }, home), '/home/u/.claude-work');
  assert.equal(slug('My Work!'), 'my-work');
});

test('ensureLink creates, accepts, relinks, and never replaces real data', () => {
  const home = tempHome();
  try {
    write(home, { 'store/a.txt': 'A', 'store/b.txt': 'B', 'acct/real.txt': 'mine' });
    const link = path.join(home, 'acct/link.txt');
    assert.equal(ensureLink(path.join(home, 'store/a.txt'), link, false), 'created');
    assert.equal(ensureLink(path.join(home, 'store/a.txt'), link, false), 'ok');
    assert.equal(ensureLink(path.join(home, 'store/b.txt'), link, false), 'relinked');
    assert.equal(fs.readFileSync(link, 'utf8'), 'B');
    assert.equal(ensureLink(path.join(home, 'store/a.txt'), path.join(home, 'acct/real.txt'), false), 'blocked');
    assert.equal(fs.readFileSync(path.join(home, 'acct/real.txt'), 'utf8'), 'mine');
  } finally {
    cleanup(home);
  }
});

test('isLinkTo recognises a Windows-style hard link fallback', () => {
  const home = tempHome();
  try {
    write(home, { 'store/settings.json': '{}' });
    const link = path.join(home, 'acct/settings.json');
    fs.mkdirSync(path.dirname(link));
    fs.linkSync(path.join(home, 'store/settings.json'), link);
    assert.ok(isLinkTo(link, path.join(home, 'store/settings.json'), 'win32'));
    // An atomic save replaces the hard link with a separate file.
    fs.writeFileSync(link + '.tmp', '{"x":1}');
    fs.renameSync(link + '.tmp', link);
    assert.ok(!isLinkTo(link, path.join(home, 'store/settings.json'), 'win32'));
  } finally {
    cleanup(home);
  }
});

test('withLock refuses a second holder', () => {
  const home = tempHome();
  try {
    withLock(home, () => {
      assert.throws(() => withLock(home, () => 1), Busy);
    });
    assert.equal(withLock(home, () => 2), 2);
  } finally {
    cleanup(home);
  }
});
