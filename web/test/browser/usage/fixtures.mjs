// Scripted `/api/quests` snapshot and `/api/usage` report fixtures shared by every scenario module, plus the
// pre-revision "legacy" backend shape used by s4/s4m.
import { iso, NOW, SENT } from './context.mjs';

export function snapshot(id) {
  const project = { name: 'Mock Project', lanes: [] };
  if (id) project.id = id;
  return {
    generatedAt: iso(Date.now()),
    project,
    quests: [],
    roster: [],
    eligibility: {},
    env: { treeLocked: false },
    live: {},
    threads: {},
    reviewPages: [],
    unpostedBriefs: [],
    verification: null,
    laneLimits: {},
    openQuestions: 0,
  };
}
export function prov(id, over = {}) {
  return { id, name: id, source: 'api', ok: true, configured: true, windows: [], balances: [], plan: '', note: '', asOf: null, fetchedAt: iso(NOW), ...over };
}
export function rich(id, name, pct, over = {}) {
  return prov(id, {
    name,
    state: 'fresh',
    fresh: true,
    stale: false,
    refreshing: false,
    cooling: false,
    windows: [{ label: '5h', usedPercent: pct, resetsAt: null }],
    lastSuccessAt: iso(NOW - 60000),
    attemptedAt: iso(NOW - 61000),
    ...over,
  });
}
export const report = (providers, generatedAt = iso(Date.now())) => ({ status: 200, body: { generatedAt, providers } });
export const three = (a = 10, b = 20, c = 30) => [rich('tone', 'T One', a), rich('ttwo', 'T Two', b), rich('tthree', 'T Three', c)];

// ---------------------------------------------------------------- U1/U4 legacy backend (pre-revision route)
export const legacyProviders = () => [
  prov('codex', { name: 'Legacy Codex', windows: [{ label: '5h', usedPercent: 42, resetsAt: null }] }),
  prov('kimi', { name: 'Legacy Kimi', ok: false, configured: false, error: '没有找到 key：KIMI_API_KEY' }),
  prov('deepseek', { name: 'Legacy Deepseek', balances: [{ currency: 'CNY', amount: 9 }] }),
  prov('openrouter', { name: 'Legacy Openrouter', ok: false, configured: true, error: `upstream said {"api_key":"sk-${SENT}"} https://user:${SENT}@api.example.com/v1/credits?key=${SENT}` }),
];
