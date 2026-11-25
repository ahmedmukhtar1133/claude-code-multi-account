import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { adopt } from '../src/adopt';
import { runDoctor } from '../src/doctor';
import { argsLookSplit, describe, parseGet, parseList } from '../src/mcpSync';
import { cleanup, tempHome, write } from './helpers';

// Captured from Claude Code 2.1.332 against throwaway servers.
const GET_STDIO = `dummy:
  Scope: User config (available in all your projects)
  Status: ✘ Failed to connect
  Issue: CONNECTION_CLOSED: Connection closed
  Type: stdio
  Command: echo
  Args: hi two words
  Environment:
    FAKE_KEY=abc123
    OTHER=x=y

To remove this server, run: claude mcp remove dummy -s user
`;

const GET_HTTP = `web:
  Scope: User config (available in all your projects)
  Status: ✘ Failed to connect
  Issue: ENOTFOUND: getaddrinfo ENOTFOUND example.invalid
  Type: http
  URL: https://example.invalid/mcp
  Headers:
    X-Token: tok

To remove this server, run: claude mcp remove web -s user
`;

const LIST = `Checking MCP server health…

web: https://example.invalid/mcp (HTTP) - ✘ Failed to connect - ENOTFOUND
dummy: echo hi two words - ✘ Failed to connect
claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ! Needs authentication
plugin:playwright:playwright: npx @playwright/mcp@latest - ✓ Connected
`;

test('parseList keeps user servers, skips connectors and plugin servers', () => {
  assert.deepEqual(parseList(LIST), ['web', 'dummy']);
});

test('parseGet builds add-json config for stdio and http', () => {
  const s = parseGet('dummy', GET_STDIO)!;
  assert.deepEqual(s.config, { type: 'stdio', command: 'echo', args: ['hi', 'two', 'words'], env: { FAKE_KEY: 'abc123', OTHER: 'x=y' } });
  assert.deepEqual(s.warnings, []);
  const w = parseGet('web', GET_HTTP)!;
  assert.deepEqual(w.config, { type: 'http', url: 'https://example.invalid/mcp', headers: { 'X-Token': 'tok' } });
  assert.ok(!describe(s).includes('abc123'));
  assert.ok(!describe(w).includes('tok"'));
});

test('parseGet ignores project and local servers', () => {
  assert.equal(parseGet('p', GET_HTTP.replace('User config (available in all your projects)', 'Project config (shared via .mcp.json)')), null);
});

test('argsLookSplit flags a path that probably had a space', () => {
  assert.ok(argsLookSplit(['/Users/a/Library/Application', 'Support/x.js']));
  assert.ok(!argsLookSplit(['-y', '@scope/pkg@latest']));
  assert.ok(!argsLookSplit(['/usr/bin/x', '--flag', 'value']));
});

test('doctor is clean after adoption and spots the known traps', () => {
  const home = tempHome();
  try {
    write(path.join(home, '.claude'), { 'settings.json': '{}', 'history.jsonl': '', 'CLAUDE.md': '', 'skills/a/SKILL.md': 'x' });
    write(path.join(home, '.claude-work'), { 'settings.json': '{}' });
    adopt({ home, accountRoot: path.join(home, '.claude-work'), tag: 'work' });
    const accounts = [{ name: 'Personal' }, { name: 'Work', folder: '.claude-work' }];
    const clean = runDoctor({ home, accounts });
    assert.deepEqual(clean.map((f) => f.level), ['ok'], JSON.stringify(clean));

    fs.writeFileSync(path.join(home, '.claude/settings.json'), '{"env":{"CLAUDE_CONFIG_DIR":"/x"}}');
    fs.mkdirSync(path.join(home, '.claude/skills/new-skill'));
    const bad = runDoctor({
      home,
      accounts: [...accounts, { name: 'Oops', folder: '.claude' }],
      claudeEnvSetting: [{ name: 'CLAUDE_CONFIG_DIR', value: '/y' }],
      loggedIn: { Work: false },
    });
    const text = bad.map((f) => f.message).join('\n');
    assert.match(text, /settings\.json sets env\.CLAUDE_CONFIG_DIR/);
    assert.match(text, /claudeCode\.environmentVariables sets CLAUDE_CONFIG_DIR/);
    assert.match(text, /points at ~\/\.claude explicitly/);
    assert.match(text, /"Work" is not signed in/);
    assert.match(text, /skills\/new-skill/);
  } finally {
    cleanup(home);
  }
});
