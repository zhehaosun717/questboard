// S2: questboard_get_quest carries the current attempt's structured evidence (src/core/evidence.js), read
// additively from the detail route — a stub `request` stands in for the HTTP round trip so this stays a
// fast unit test rather than a second full-server fixture.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';
import { createTools } from '../../src/mcp/tools.js';

const EVIDENCE = { version: 1, attemptId: 'a1', attemptAt: '2026-09-14T00:00:00.000Z', items: [
  { kind: 'report', label: '工作者报告', state: 'passed', source: 'delivery', ref: '.work/oc/mod1.md', digest: 'x', capturedAt: '2026-09-14T00:01:00.000Z', attemptId: 'a1', bound: true },
  { kind: 'project-verification', label: '项目验证记录', state: 'not_configured', source: null, ref: null, digest: null, capturedAt: null, attemptId: 'a1', bound: false, reason: '项目没有配置验证目录' },
  { kind: 'hook', label: '验证钩子', state: 'not_configured', source: null, ref: null, digest: null, capturedAt: null, attemptId: 'a1', bound: false, reason: '项目没有启用验证钩子' },
] };

function stubRequest(routes) {
  return async (base, route) => {
    if (!(route in routes)) throw new Error(`unexpected route in test stub: ${route}`);
    return routes[route];
  };
}

describe('questboard_get_quest — evidence (S2)', () => {
  it('carries the detail route\'s evidence object alongside the usual fields', async () => {
    const { config } = makeProject();
    const quest = { id: 'RUN-4', status: 'dispatched', kind: 'code', priority: 2, title: 'x', parents: [], assignee: { name: 'mod1', model: 'm', lane: 'opencode', at: '2026-09-14T00:00:00.000Z', attemptId: 'a1' }, dispatches: [] };
    const tools = createTools({
      config, base: 'http://test', author: 'coordinator', home: {},
      request: stubRequest({
        '/api/quests': { quests: [quest], live: {}, threads: {}, eligibility: { 'RUN-4': {} } },
        '/api/quests/RUN-4': { quest: { ...quest, live: null, threads: [], eligibility: { canTake: [], refused: {} }, evidence: EVIDENCE } },
      }),
    });
    const getQuest = tools.find((t) => t.name === 'questboard_get_quest');
    const result = await getQuest.handler({ id: 'RUN-4' });
    assert.deepEqual(result.evidence, EVIDENCE);
    assert.equal(result.id, 'RUN-4', 'the usual snapshot-derived fields are still present');
  });

  it('is absent (never invented) when the detail route sends an older shape with no evidence field', async () => {
    const { config } = makeProject();
    const quest = { id: 'RUN-5', status: 'posted', kind: 'code', priority: 2, title: 'x', parents: [], assignee: null, dispatches: [] };
    const tools = createTools({
      config, base: 'http://test', author: 'coordinator', home: {},
      request: stubRequest({
        '/api/quests': { quests: [quest], live: {}, threads: {}, eligibility: { 'RUN-5': {} } },
        '/api/quests/RUN-5': { quest: { ...quest, live: null, threads: [], eligibility: { canTake: [], refused: {} } } },
      }),
    });
    const getQuest = tools.find((t) => t.name === 'questboard_get_quest');
    const result = await getQuest.handler({ id: 'RUN-5' });
    assert.equal(result.evidence, undefined);
  });

  // F7: a quest that answers the first (list) read but whose second (detail) read fails — e.g. removed
  // between the two calls — must not fail the whole tool call. Every other field still comes from the first
  // read; only evidence goes to null.
  it('returns evidence: null, not a thrown error, when the detail read fails after the list read succeeded', async () => {
    const { config } = makeProject();
    const quest = { id: 'RUN-6', status: 'dispatched', kind: 'code', priority: 2, title: 'x', parents: [], assignee: { name: 'mod1', model: 'm', lane: 'opencode', at: '2026-09-14T00:00:00.000Z', attemptId: 'a1' }, dispatches: [] };
    const tools = createTools({
      config, base: 'http://test', author: 'coordinator', home: {},
      request: async (base, route) => {
        if (route === '/api/quests') return { quests: [quest], live: {}, threads: {}, eligibility: { 'RUN-6': {} } };
        if (route === '/api/quests/RUN-6') throw new Error('quest not found');
        throw new Error(`unexpected route in test stub: ${route}`);
      },
    });
    const getQuest = tools.find((t) => t.name === 'questboard_get_quest');
    const result = await getQuest.handler({ id: 'RUN-6' });
    assert.equal(result.evidence, null);
    assert.equal(result.id, 'RUN-6', 'the list-read fields are still present');
    assert.equal(result.evidenceError, '证据读取失败：quest not found');
  });
});
