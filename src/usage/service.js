// Collects every provider's usage in parallel and caches the result briefly. Error text shown to the owner comes
// only from UsageError messages written in this module's providers, so a key or response body never leaks.
import os from 'node:os';
import { UsageError, runCommand } from './common.js';
import { createCredentials, describeKeySources } from './credentials.js';
import { PROVIDERS } from './providers.js';

const CACHE_MS = 60000;

export function createUsageService({
  fetchImpl = fetch, env = process.env, homedir = os.homedir(), exec = runCommand, providers = PROVIDERS, cacheMs = CACHE_MS, now = () => Date.now(),
} = {}) {
  const credentials = createCredentials({ env, homedir });
  let cache = null;
  let pending = null;

  async function readOne(provider) {
    const base = { id: provider.id, name: provider.name, source: provider.source, fetchedAt: new Date(now()).toISOString() };
    const empty = { windows: [], balances: [], plan: '', note: '', asOf: null };
    if (provider.unavailable) return { ...base, ...empty, ok: false, configured: false, error: provider.unavailable };
    let key = null;
    if (provider.keys) {
      const found = credentials.apiKey(provider.keys);
      if (!found) return { ...base, ...empty, ok: false, configured: false, error: `没有找到 key：${describeKeySources(provider.keys)}` };
      key = found.key;
      base.keyFrom = found.from;
    }
    if (provider.oauth) {
      const found = credentials.oauthToken(provider.oauth);
      if (!found) return { ...base, ...empty, ok: false, configured: false, error: `没有找到登录：${describeKeySources({ openCodeIds: provider.oauth.openCodeIds })}` };
      if (found.expired) return { ...base, ...empty, ok: false, configured: true, error: `${found.from} 的登录已过期，请重新登录` };
      key = found.key;
      base.keyFrom = found.from;
    }
    try {
      const result = await provider.fetch({ fetchImpl, key, exec, env, homedir });
      const entry = {
        ...base,
        ok: result.ok === undefined ? true : result.ok,
        configured: result.configured === undefined ? true : result.configured,
        windows: result.windows || [],
        balances: result.balances || [],
        plan: result.plan || '',
        note: result.note || '',
        asOf: result.asOf || null,
      };
      return result.error ? { ...entry, error: result.error } : entry;
    } catch (error) {
      const message = error instanceof UsageError ? error.message : `读取失败（${error && error.name ? error.name : 'Error'}）`;
      return { ...base, ...empty, ok: false, configured: true, error: message };
    }
  }

  function report({ refresh = false } = {}) {
    if (!refresh && cache && now() - cache.at < cacheMs) return Promise.resolve(cache.value);
    if (pending) return pending;
    pending = Promise.all(providers.map(readOne))
      .then((list) => {
        const value = { generatedAt: new Date(now()).toISOString(), providers: list };
        cache = { at: now(), value };
        return value;
      })
      .finally(() => { pending = null; });
    return pending;
  }

  return { report };
}
