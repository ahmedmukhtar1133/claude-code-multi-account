// Copies user-scope MCP servers between accounts through the official CLI
// (`claude mcp list`, `claude mcp get`, `claude mcp add-json`). This module never
// opens .claude.json, which also holds the account's login identity.

export interface McpServer {
  name: string;
  /** JSON accepted by `claude mcp add-json`. */
  config: Record<string, unknown>;
  /** Reasons to check this server by hand before adding it. */
  warnings: string[];
}

const NAME = /^([A-Za-z0-9_.-]+): /;

/** Server names from `claude mcp list`. Connectors and plugin servers are not user-scope and do not match. */
export function parseList(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = NAME.exec(line);
    if (m) names.push(m[1]);
  }
  return [...new Set(names)];
}

const KNOWN = new Set(['Scope', 'Status', 'Issue', 'Type', 'Command', 'Args', 'URL', 'Environment', 'Headers']);

/** Parses `claude mcp get <name>`. Returns null when the server is not in the user scope. */
export function parseGet(name: string, text: string): McpServer | null {
  const fields: Record<string, string> = {};
  const nested: Record<string, string[]> = {};
  let section: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const deep = /^ {4,}(\S.*)$/.exec(raw);
    if (deep && section) {
      nested[section].push(deep[1]);
      continue;
    }
    const top = /^ {2}([A-Za-z][A-Za-z ]*):(?: (.*))?$/.exec(raw);
    if (top) {
      const key = top[1];
      const value = top[2] ?? '';
      if (value === '') {
        section = key;
        nested[key] = [];
      } else {
        section = null;
        fields[key] = value;
      }
      continue;
    }
    if (raw.trim() !== '') section = null;
  }

  if (!(fields.Scope ?? '').startsWith('User config')) return null;

  const warnings: string[] = [];
  for (const k of [...Object.keys(fields), ...Object.keys(nested)]) {
    if (!KNOWN.has(k)) warnings.push(`Has a "${k}" setting this extension can't copy`);
  }

  const type = (fields.Type ?? 'stdio').toLowerCase();
  const config: Record<string, unknown> = { type };
  if (type === 'stdio') {
    if (!fields.Command) warnings.push('No command found');
    config.command = fields.Command ?? '';
    const args = (fields.Args ?? '').split(' ').filter((a) => a !== '');
    config.args = args;
    if (argsLookSplit(args)) warnings.push('An argument may contain a space that the CLI output hides');
    const env: Record<string, string> = {};
    for (const line of nested.Environment ?? []) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
    if (Object.keys(env).length) config.env = env;
  } else {
    if (!fields.URL) warnings.push('No URL found');
    config.url = fields.URL ?? '';
    const headers: Record<string, string> = {};
    for (const line of nested.Headers ?? []) {
      const i = line.indexOf(': ');
      if (i > 0) headers[line.slice(0, i)] = line.slice(i + 2);
    }
    if (Object.keys(headers).length) config.headers = headers;
  }
  return { name, config, warnings };
}

/**
 * The CLI prints arguments joined by spaces. A path with a space in it then shows
 * up as a path-like token followed by a plain word; flag that for a manual check.
 */
export function argsLookSplit(args: string[]): boolean {
  for (let i = 0; i + 1 < args.length; i++) {
    const a = args[i];
    const b = args[i + 1];
    const pathLike = /[\\/]/.test(a) && !a.startsWith('-') && !/^[a-z]+:\/\//i.test(a);
    const plainNext = !b.startsWith('-') && !/^[\\/~]/.test(b) && !/^[A-Za-z]:\\/.test(b);
    if (pathLike && plainNext) return true;
  }
  return false;
}

/** What a preview shows: command and arguments, never env or header values. */
export function describe(s: McpServer): string {
  const c = s.config;
  if (c.type === 'stdio') {
    const env = c.env ? ` (env: ${Object.keys(c.env as object).join(', ')})` : '';
    return `${c.command} ${JSON.stringify(c.args)}${env}`;
  }
  const h = c.headers ? ` (headers: ${Object.keys(c.headers as object).join(', ')})` : '';
  return `${c.type} ${c.url}${h}`;
}
