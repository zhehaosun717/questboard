// CLI plumbing: options, which project, which server, and HTTP requests with readable failures.
import { findProjectRoot, loadProjectConfig } from '../core/config.js';

export function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

// Every value of a flag that may be repeated, e.g. `--lane a=... --lane b=...`.
export function optionAll(args, name) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) if (args[index] === name) values.push(args[index + 1]);
  return values;
}

export function projectConfig(args, env = process.env) {
  const dir = option(args, '--project') || env.QUESTBOARD_PROJECT || findProjectRoot();
  if (!dir) throw new Error('no questboard.config.json here or in any parent folder; run inside a project or pass --project <dir>');
  return loadProjectConfig(dir);
}

export function serverUrl(args, config, env = process.env) {
  return option(args, '--url') || env.QUESTBOARD_URL || `http://127.0.0.1:${config.port}`;
}

export async function request(base, route, method = 'GET', body, { source } = {}) {
  let response;
  try {
    response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(source ? { 'x-questboard-source': source } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error(`questboard server is not running at ${base}. Start it with: questboard serve`);
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fields = value.fields ? ` ${JSON.stringify(value.fields)}` : '';
    const reasons = value.reasons ? `\n${value.reasons.map((r) => `- ${r.message}`).join('\n')}` : '';
    throw new Error(`${value.error || `HTTP ${response.status}`}${fields}${reasons}`);
  }
  return value;
}
