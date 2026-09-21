// F1 (round-1 blocker): questboard_assign is a thin wrapper over POST /api/quests/:id/assign (the real
// `request` from src/cli/client.js throws a readable error carrying the server's `reasons` on any non-2xx
// reply) — so once the server enforces the upstream-order policy on that route, the MCP tool refuses too,
// with no change needed to tools.js itself. This proves the wiring against a real fixture server, not a stub.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture, tick } from '../server/fixture.js';
import { captureAttemptReport } from '../../src/core/reportEvidence.js';
import { createTools } from '../../src/mcp/tools.js';
import { request } from '../../src/cli/client.js';

async function deliverWithPassReport(fx, id) {
  assert.equal((await fx.api(`/api/quests/${id}/assign`, 'POST', { adventurer: 'oc-mimo' })).status, 200);
  await tick();
  const store = fx.server.store;
  const name = store.get(id).assignee.name;
  fs.mkdirSync(path.join(fx.project.root, '.work', 'oc'), { recursive: true });
  fx.project.write(`.work/oc/${name}.md`, 'VERDICT: PASS\n');
  const report = captureAttemptReport({ config: fx.project.config, quest: store.get(id) });
  store.setStatus(id, 'delivered', {
    detail: 'done', by: 'lanes', report, source: 'collector',
    evidence: { kind: 'collector', attemptId: store.get(id).assignee.attemptId },
  });
}

describe('questboard_assign — F1 upstream-order refusal (real server, real request)', () => {
  let fx;
  let tools;
  before(async () => {
    fx = await startFixture({ projectOverrides: { policy: { reviewRequires: ['project-verification'] }, verification: { progressDirs: ['.work/full'] } } });
    fx.project.write('docs/briefs/RUN-1-x.md', 'RUN-1');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' })).status, 201);
    await deliverWithPassReport(fx, 'RUN-1');
    const posted = await fx.api('/api/quests/RUN-1/review', 'POST', { note: '看一下' });
    assert.equal(posted.status, 201, posted.text);
    // author 'owner' on purpose: FB2-12 item 3 limits the coordinator's own assign to the machine-check
    // fast track, and this file is about the review upstream policy, i.e. the owner dispatching.
    tools = createTools({ config: fx.project.config, base: fx.base, author: 'owner', home: fx.home, request });
  });
  after(() => fx.close());

  it('throws a readable error carrying the upstream_unverified reason, and posts nothing new', async () => {
    const assign = tools.find((t) => t.name === 'questboard_assign');
    await assert.rejects(
      () => assign.handler({ id: 'REVIEW-RUN-1', adventurer: 'agy-gemini' }),
      (error) => {
        // src/cli/client.js's request() renders `reasons` as one line per message (never the code) — the
        // same text the board's own drop preview and the route test's `reasons` array both carry.
        assert.match(error.message, /^refused/);
        assert.match(error.message, /项目验证记录缺失/);
        return true;
      },
    );
    const quest = (await fx.api('/api/quests/REVIEW-RUN-1')).body.quest;
    assert.equal(quest.status, 'posted', 'the refused MCP assign never dispatched the review');
    assert.equal(quest.assignee, null);
  });

  it('succeeds once a recorded override lifts the block', async () => {
    assert.equal((await fx.api('/api/quests/REVIEW-RUN-1/review-override', 'POST', { reason: '手工确认过测试通过' })).status, 200);
    const assign = tools.find((t) => t.name === 'questboard_assign');
    const result = await assign.handler({ id: 'REVIEW-RUN-1', adventurer: 'agy-gemini' });
    assert.equal(result.status, 'dispatched');
    const quest = (await fx.api('/api/quests/REVIEW-RUN-1')).body.quest;
    assert.equal(quest.assignee.adventurerId, 'agy-gemini');
  });
});
