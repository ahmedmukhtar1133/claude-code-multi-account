import * as vscode from 'vscode';
import { SessionInfo, SharedCounts, timeAgo } from './stats';

export interface PanelAccount {
  name: string;
  folder: string;
  isDefault: boolean;
  isCurrent: boolean;
  signedIn?: boolean;
}

export interface PanelHealth {
  level: 'ok' | 'info' | 'warn' | 'error';
  message: string;
  extensions?: string[];
  fix?: string;
}

export interface PanelState {
  accounts: PanelAccount[];
  /** Folders of other accounts found in the home folder, offered for adoption when nothing is set up. */
  candidates: { label: string; dir: string }[];
  sessions: SessionInfo[];
  hasProject: boolean;
  health: PanelHealth[];
  shared: SharedCounts;
  repoUrl: string;
  /** deskworthy.app links get this query appended (ref tag). */
  siteRef: string;
}

/** Live Deskworthy apps for the footer's daily "Try" link: name and page slug on deskworthy.app. */
const APPS: readonly [string, string][] = [
  ['CopyHold', 'clipboard-manager'],
  ['Snipkeep', 'screenshot-tool'],
  ['VeilShot', 'screenshot-editor'],
  ['Telltale', 'system-monitor'],
  ['Lockwell', 'password-manager'],
  ['Paperly', 'pdf-tools'],
  ['Findigo', 'file-organizer'],
  ['Squish', 'image-compressor'],
  ['DiskAtlas', 'disk-space-analyzer'],
  ['Kempt', 'mac-maintenance'],
];

const AVATAR = ['#D97757', '#3B82F6', '#18A7A1', '#8A4A78', '#C08A2D', '#4F7A3A'];

export interface PanelMessage {
  cmd: string;
  arg?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const DESKWORTHY_LOGO =
  '<svg class="dw" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#2747D6"/><path d="M16 13h15.5C42.3 13 51 21.5 51 32s-8.7 19-19.5 19H16z" fill="#FFFFFF"/><rect x="23" y="23.5" width="17" height="17" rx="4.5" fill="#F0A63A"/></svg>';

/** The side panel. All data comes from the extension; the webview only renders and posts clicks back. */
export class PanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private last?: PanelState;

  constructor(
    private readonly getState: () => Promise<PanelState>,
    private readonly onMessage: (m: PanelMessage) => Promise<void>,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [] };
    view.webview.onDidReceiveMessage(async (m: PanelMessage) => {
      await this.onMessage(m);
      await this.refresh();
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    });
    if (this.last) view.webview.html = this.html(this.last);
    void this.refresh();
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    try {
      this.last = await this.getState();
      this.view.webview.html = this.html(this.last);
    } catch (e) {
      this.view.webview.html = `<body style="padding:12px">Could not read the account folders: ${esc((e as Error).message)}</body>`;
    }
  }

  private html(s: PanelState): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const body = s.accounts.length ? this.main(s) : this.setup(s);
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head>
<body>${body}${this.footer(s)}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const st = vscode.getState() || {};
function showTab(id) {
  document.querySelectorAll('[role=tab]').forEach((t) => { const on = t.dataset.tab === id; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
  document.querySelectorAll('[role=tabpanel]').forEach((p) => { p.hidden = p.id !== 'p-' + id; });
  const n = vscode.getState() || {}; n.tab = id; vscode.setState(n);
}
if (document.querySelector('[role=tab]')) showTab(st.tab && document.getElementById('p-' + st.tab) ? st.tab : 'sessions');
const more = document.getElementById('more-rows');
function setMore(open) {
  if (!more) return;
  more.hidden = !open;
  const b = document.getElementById('more-btn');
  b.textContent = open ? 'Show fewer' : b.dataset.label;
  const n = vscode.getState() || {}; n.more = open; vscode.setState(n);
}
if (more) setMore(!!st.more);
document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('[role=tab]');
  if (tab) { showTab(tab.dataset.tab); return; }
  if (ev.target.closest('#more-btn')) { setMore(more.hidden); return; }
  const el = ev.target.closest('[data-cmd]');
  if (!el) return;
  ev.preventDefault();
  vscode.postMessage({ cmd: el.dataset.cmd, arg: el.dataset.arg });
});
document.addEventListener('keydown', (ev) => {
  const tab = ev.target.closest && ev.target.closest('[role=tab]');
  const k = ev['key'];
  if (!tab || (k !== 'ArrowRight' && k !== 'ArrowLeft')) return;
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const next = tabs[(tabs.indexOf(tab) + (k === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  showTab(next.dataset.tab); next.focus();
});
</script></body></html>`;
  }

  private dot(signedIn?: boolean): string {
    return `<span class="dot ${signedIn === false ? 'warn' : signedIn ? 'ok' : 'unk'}" aria-hidden="true"></span>`;
  }

  private main(s: PanelState): string {
    const others = s.accounts.filter((a) => !a.isCurrent);
    const problems = s.health.filter((h) => h.level === 'warn' || h.level === 'error');
    // The dot on the avatar shows sign-in state; words only when something needs doing.
    const stateText = (a: PanelAccount) => (a.signedIn === false ? ' · <span class="warnText">signed out</span>' : '');

    const accounts = `<section class="accounts" aria-label="Accounts">
      ${s.accounts
        .map((a, i) => {
          const avatar = `<span class="av" style="background:${AVATAR[i % AVATAR.length]}" aria-hidden="true">${esc(a.name.charAt(0).toUpperCase())}<span class="st ${a.signedIn === false ? 'warn' : a.signedIn ? 'ok' : 'unk'}"></span></span>`;
          const info = `<span class="who"><span class="n">${esc(a.name)}</span><span class="mut small">${esc(a.folder)}${stateText(a)}</span></span>`;
          const rename = `<button class="icon" data-cmd="rename" data-arg="${esc(a.name)}" title="Rename ${esc(a.name)}" aria-label="Rename ${esc(a.name)}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/></svg></button>`;
          return a.isCurrent
            ? `<div class="acc here">${avatar}${info}${rename}<span class="pill">This window</span></div>`
            : `<div class="acc">${avatar}${info}${rename}<button class="btn small" data-cmd="switchTo" data-arg="${esc(a.name)}" title="Switch this window to ${esc(a.name)}">Switch</button></div>`;
        })
        .join('')}
      <div class="actions">
        <button class="btn ghost" data-cmd="add">+ Add account</button>
        ${others.length ? `<button class="btn ghost" data-cmd="copyMcp" title="MCP servers are saved with each login, so each account has its own">${others.length === 1 ? `Copy MCP from ${esc(others[0].name)}` : 'Copy MCP servers'}</button>` : ''}
      </div></section>`;

    const tabs = `<div class="tabs" role="tablist" aria-label="Sections">
      <button role="tab" id="t-sessions" data-tab="sessions" aria-controls="p-sessions">Sessions</button>
      <button role="tab" id="t-status" data-tab="status" aria-controls="p-status">Status${problems.length ? `<span class="badge">${problems.length}</span>` : ''}</button></div>`;

    const row = (x: SessionInfo) =>
      `<a class="srow" href="#" data-cmd="openSession" data-arg="${esc(x.id)}" title="Open in Claude Code"><span class="t">${esc(x.title)}</span>${
        x.active ? '<span class="live">Active</span>' : `<span class="w">${esc(timeAgo(x.modified))}</span>`
      }</a>`;
    const shown = s.sessions.slice(0, 3);
    const rest = s.sessions.slice(3);
    const sessions = `<div role="tabpanel" id="p-sessions" aria-labelledby="t-sessions" class="panel" hidden>
      ${
        !s.hasProject
          ? '<div class="mut pad">Open a folder to see its Claude sessions here.</div>'
          : shown.length
            ? `<div class="list">${shown.map(row).join('')}${rest.length ? `<div id="more-rows" class="list" hidden>${rest.map(row).join('')}</div>` : ''}</div>
          ${rest.length ? `<button id="more-btn" class="btn ghost" data-label="Show ${rest.length} more">Show ${rest.length} more</button>` : ''}
          <div class="mut small pad">Sessions from every account. Click one to open it in Claude Code.</div>`
            : '<div class="mut pad">No sessions in this project yet.</div>'
      }</div>`;

    const c = s.shared;
    const status = `<div role="tabpanel" id="p-status" aria-labelledby="t-status" class="panel" hidden>
      ${
        problems.length
          ? problems
              .map(
                (h) =>
                  `<div class="health"><span class="dot ${h.level === 'error' ? 'err' : 'warn'}" aria-hidden="true"></span><span>${esc(h.message)}${
                    h.extensions?.length ? ` <a class="link" href="#" data-cmd="showExt" data-arg="${esc(h.extensions.join(','))}">Show in Extensions</a>` : ''
                  }</span></div>`,
              )
              .join('') + (problems.some((h) => h.fix) ? '<button class="btn" data-cmd="repair">Repair links</button>' : '')
          : '<div class="health"><span class="dot ok" aria-hidden="true"></span><span>Everything is linked and working.</span></div>'
      }
      <a class="link pad" href="#" data-cmd="doctor">Run Doctor</a>
      <h3>Shared by all accounts</h3>
      <div class="stats">
        <div><b>${c.projects}</b><span>projects</span></div>
        <div><b>${c.sessions}</b><span>sessions</span></div>
        <div><b>${c.skills}</b><span>skills</span></div>
        <div><b>${c.agents}</b><span>agents</span></div>
      </div>
      <div class="mut small pad">Also shared: commands, CLAUDE.md, settings, hooks, plugins. Kept per account: login, MCP servers, folder trust.</div></div>`;

    return `<main>${accounts}${tabs}${sessions}${status}</main>`;
  }

  private setup(s: PanelState): string {
    return `<main><div class="card">
      <div class="name">Not set up yet</div>
      <div class="mut">Use a different Claude account in each window while every account shares history, memory, skills and settings.</div>
      <button class="btn" data-cmd="add">Add an account</button>
      ${s.candidates.map((c) => `<button class="btn ghost" data-cmd="adopt" data-arg="${esc(c.dir)}">Adopt ${esc(c.label)}</button>`).join('')}
    </div></main>`;
  }

  private footer(s: PanelState): string {
    const day = Math.floor(Date.now() / 86_400_000);
    const [app, slug] = APPS[day % APPS.length];
    const site = (p: string) => `https://deskworthy.app/${p}${s.siteRef}`;
    return `<footer>
      <div class="card promo">
        <div class="brand">${DESKWORTHY_LOGO}Built by Deskworthy</div>
        <div class="mut small">Small Mac apps for screenshots, PDFs, passwords, your clipboard and disk space.</div>
        <div class="links"><a class="link" href="#" data-cmd="openUrl" data-arg="${esc(site('apps/' + slug))}">Try ${esc(app)}</a><span class="mut">·</span><a class="link" href="#" data-cmd="openUrl" data-arg="${esc(site('apps'))}">All apps</a></div>
      </div>
      <div class="oss mut small">Open source (MIT) · <a class="link" href="#" data-cmd="openUrl" data-arg="${esc(s.repoUrl)}">View on GitHub</a><br>Unofficial, not affiliated with Anthropic.</div>
    </footer>`;
  }
}

const CSS = `
:root { color-scheme: light dark; }
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; padding: 14px 14px 14px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: transparent; display: flex; flex-direction: column; gap: 20px; min-height: calc(100vh - 28px); }
main { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.card { background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,.10)); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.22)); border-radius: 6px; padding: 10px 12px; display: grid; gap: 6px; min-width: 0; }
.bar { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
.who { min-width: 0; display: grid; gap: 2px; }
.name { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.mut { color: var(--vscode-descriptionForeground); }
.small { font-size: 12px; }
.bar .small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pad { padding: 2px 4px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; background: var(--vscode-descriptionForeground); }
.dot.ok { background: var(--vscode-testing-iconPassed, #73C991); }
.dot.warn { background: var(--vscode-editorWarning-foreground, #CCA700); }
.dot.err { background: var(--vscode-editorError-foreground, #F14C4C); }
.btn { display: block; width: 100%; padding: 5px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; cursor: pointer; font: inherit; text-align: center; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn:hover { background: var(--vscode-button-hoverBackground); }
.bar .btn { width: auto; }
.btn.ghost { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, rgba(128,128,128,.55))); margin-top: 4px; }
.btn.ghost:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
button:focus-visible, a:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
a { color: inherit; text-decoration: none; }
.link { color: var(--vscode-textLink-foreground); cursor: pointer; }
.link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); }
[role=tab] { flex: 1; background: none; border: none; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); font: inherit; padding: 6px 4px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 5px; margin-bottom: -1px; }
[role=tab][aria-selected=true] { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground)); }
[role=tab]:hover { color: var(--vscode-foreground); }
.badge { background: var(--vscode-editorWarning-foreground, #CCA700); color: var(--vscode-editor-background, #1E1E1E); border-radius: 8px; font-size: 10px; font-weight: 700; min-width: 16px; padding: 0 4px; line-height: 16px; }
.panel { display: flex; flex-direction: column; gap: 8px; min-width: 0; margin-top: -6px; }
.panel[hidden] { display: none; }
h3 { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; margin: 12px 0 4px; color: var(--vscode-descriptionForeground); }
.accounts { display: grid; gap: 8px; }
.acc { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 6px; min-width: 0; border: 1px solid transparent; }
.acc.here { background: var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,.14)); border-color: var(--vscode-widget-border, rgba(128,128,128,.22)); }
.srow:hover { background: var(--vscode-list-hoverBackground); }
.av { position: relative; width: 28px; height: 28px; border-radius: 50%; flex: none; display: grid; place-items: center; color: #FFFFFF; font-weight: 700; font-size: 13px; }
.av .st { position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--vscode-sideBar-background, #181818); background: var(--vscode-descriptionForeground); }
.av .st.ok { background: var(--vscode-testing-iconPassed, #73C991); }
.av .st.warn { background: var(--vscode-editorWarning-foreground, #CCA700); }
.who { flex: 1; min-width: 0; display: grid; }
.who .n { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.who .small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pill { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--vscode-badge-background, rgba(128,128,128,.3)); color: var(--vscode-badge-foreground, inherit); white-space: nowrap; }
.btn.small { width: auto; padding: 3px 10px; font-size: 12px; }
.icon { flex: none; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px; background: none; color: inherit; cursor: pointer; opacity: 0; }
.acc:hover .icon, .icon:focus-visible { opacity: .75; }
.icon:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
.icon:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.actions .btn { margin-top: 0; font-size: 12px; padding: 6px 6px; flex: 1 1 auto; width: auto; white-space: nowrap; }
.warnText { color: var(--vscode-editorWarning-foreground, #CCA700); }
.list { display: grid; gap: 3px; min-width: 0; }
.list[hidden] { display: none; }
.srow { display: flex; gap: 8px; align-items: baseline; padding: 6px 6px; border-radius: 4px; min-width: 0; }
.srow .t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow .w { color: var(--vscode-descriptionForeground); white-space: nowrap; font-size: 12px; font-variant-numeric: tabular-nums; }
.live { font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-testing-iconPassed, #73C991); border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; }
.health { display: flex; gap: 8px; align-items: baseline; padding: 2px 4px; min-width: 0; }
.health > span:last-child { overflow-wrap: anywhere; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.stats div { display: grid; justify-items: center; padding: 6px 2px; border-radius: 4px; background: var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,.12)); }
.stats b { font-size: 16px; font-variant-numeric: tabular-nums; }
.stats span { font-size: 11px; color: var(--vscode-descriptionForeground); }
footer { margin-top: auto; display: grid; gap: 10px; padding-top: 8px; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.dw { width: 16px; height: 16px; flex: none; }
.links { display: flex; gap: 6px; align-items: center; }
.oss { text-align: center; }
`;
