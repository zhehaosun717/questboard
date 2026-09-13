// Where usage fetchers find API keys: an environment variable first, then the key OpenCode already stores for
// that provider. A key is handed to one request and dropped; nothing here logs, caches or returns a key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function openCodeAuthFile({ env = process.env, homedir = os.homedir() } = {}) {
  if (env.OPENCODE_AUTH_FILE) return path.resolve(env.OPENCODE_AUTH_FILE);
  const dataHome = env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(homedir, '.local', 'share');
  return path.join(dataHome, 'opencode', 'auth.json');
}

export function describeKeySources({ envNames = [], openCodeIds = [] }) {
  const parts = [];
  if (envNames.length) parts.push(`环境变量 ${envNames.join(' / ')}`);
  if (openCodeIds.length) parts.push(`OpenCode 登录（${openCodeIds.join(' / ')}）`);
  return parts.join('，或 ');
}

export function createCredentials({ env = process.env, homedir = os.homedir() } = {}) {
  const authFile = openCodeAuthFile({ env, homedir });

  function openCodeEntry(id) {
    try {
      const all = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      const entry = all && typeof all === 'object' ? all[id] : null;
      return entry && typeof entry === 'object' ? entry : null;
    } catch {
      return null;
    }
  }

  // Returns { key, from } where `from` names the source (never the key), or null.
  function apiKey({ envNames = [], openCodeIds = [] }) {
    for (const name of envNames) {
      const value = env[name];
      if (typeof value === 'string' && value.trim()) return { key: value.trim(), from: `环境变量 ${name}` };
    }
    for (const id of openCodeIds) {
      const entry = openCodeEntry(id);
      if (entry && entry.type === 'api' && typeof entry.key === 'string' && entry.key.trim()) {
        return { key: entry.key.trim(), from: `OpenCode 登录（${id}）` };
      }
    }
    return null;
  }

  // Which sources hold a key, as booleans, for the settings page. Never the key itself.
  function presence({ envNames = [], openCodeIds = [] }) {
    return [
      ...envNames.map((name) => ({ kind: 'env', name, present: typeof env[name] === 'string' && Boolean(env[name].trim()) })),
      ...openCodeIds.map((id) => {
        const entry = openCodeEntry(id);
        return { kind: 'opencode', name: id, present: Boolean(entry && entry.type === 'api' && typeof entry.key === 'string' && entry.key.trim()) };
      }),
    ];
  }

  return { apiKey, presence, authFile };
}
