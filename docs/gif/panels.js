// Renders the real side panel (out/src/panel.js) with made-up sample data, for the README GIFs.
// Usage: node docs/gif/panels.js   (after npm run compile). Writes docs/gif/build/panel-*.html.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { PanelProvider } = require(path.join(root, 'out/src/panel.js'));

const out = path.join(__dirname, 'build');
fs.mkdirSync(out, { recursive: true });

const now = Date.now();
const base = [
  { id: 'a', title: 'Fix the flaky checkout test', modified: now - 20_000, active: true },
  { id: 'b', title: 'Add rate limiting to the login API', modified: now - 26 * 60_000, active: false },
  { id: 'c', title: 'Refactor the billing service', modified: now - 3 * 3_600_000, active: false },
  { id: 'd', title: 'Write release notes for 2.4', modified: now - 26 * 3_600_000, active: false },
];
// After a new session was started in the other window.
const after = [
  { id: 'n', title: 'Rename the payment webhook handler', modified: now - 5_000, active: true },
  { ...base[0], modified: now - 4 * 60_000, active: false },
  ...base.slice(1),
];
const shared = { projects: 6, sessions: 84, skills: 4, agents: 2, commands: 3, hasClaudeMd: true, hasSettings: true };

const two = [
  { name: 'Personal', folder: '~/.claude', isDefault: true },
  { name: 'Work', folder: '~/.claude-work', isDefault: false },
];
const three = [...two, { name: 'Client', folder: '~/.claude-accounts/client', isDefault: false }];

function state(accounts, current, sessions, signedOut = []) {
  return {
    accounts: accounts.map((a) => ({ ...a, isCurrent: a.name === current, signedIn: !signedOut.includes(a.name) })),
    candidates: [],
    sessions,
    hasProject: true,
    health: [{ level: 'ok', message: 'Everything is linked.' }],
    shared,
    repoUrl: 'https://github.com/',
    siteRef: '',
  };
}

const variants = {
  personal: state(two, 'Personal', base),
  work: state(two, 'Work', base),
  'personal-after': state(two, 'Personal', after),
  'work-after': state(two, 'Work', after),
  client: state(three, 'Client', base, ['Client']),
};

// VS Code "Dark Modern" theme colours, as the webview receives them.
const vars = [
  '--vscode-font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif', '--vscode-font-size:13px',
  '--vscode-foreground:#CCCCCC', '--vscode-descriptionForeground:#9D9D9D',
  '--vscode-button-background:#0078D4', '--vscode-button-foreground:#FFFFFF', '--vscode-button-border:#FFFFFF12',
  '--vscode-textLink-foreground:#4DAAFC', '--vscode-sideBarSectionHeader-background:#181818', '--vscode-sideBar-background:#181818',
  '--vscode-widget-border:#313131', '--vscode-list-inactiveSelectionBackground:#37373D', '--vscode-list-hoverBackground:#2A2D2E',
  '--vscode-focusBorder:#0078D4', '--vscode-testing-iconPassed:#73C991', '--vscode-editorWarning-foreground:#CCA700',
  '--vscode-editor-background:#1F1F1F', '--vscode-badge-background:#616161', '--vscode-badge-foreground:#F8F8F8',
].join(';');

for (const [name, s] of Object.entries(variants)) {
  let html = new PanelProvider(async () => s, async () => {}).html(s);
  const stub = `<script>window.acquireVsCodeApi=()=>({getState:()=>({tab:'sessions',more:false}),setState(){},postMessage(){}});</script>`;
  html = html
    .replace(/<meta http-equiv[^>]*>/, '')
    .replace('<head>', `<head><style>:root{${vars}}html{background:#181818}body{min-height:100vh}a:hover,.srow:hover{background:none}</style>`)
    .replace(/<script nonce="[^"]*">/, stub + '<script>');
  fs.writeFileSync(path.join(out, `panel-${name}.html`), html);
}
console.log('panels written:', Object.keys(variants).join(', '));
