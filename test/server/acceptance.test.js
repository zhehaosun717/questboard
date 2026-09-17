// Feedback 15: an acceptance record on the done transition — actor and the current-attempt evidence it
// named, validated against src/core/evidence.js's own items (src/core/acceptance.js) so a stale or fabricated
// ref is refused, and never automatic (a review's own PASS report never advances the parent by itself).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture, tick } from './fixture.js';
import { captureAttemptReport } from '../../src/core/reportEvidence.js';

let fx;
before(async () => { fx = await startFixture(); });
after(() => fx.close());

async function deliverWithReport(id, text = 'VERDICT: PASS\n') {
  const brief = `docs/briefs/${id}-x.md`;
  fx.project.write(brief, 'brief');
  assert.equal((await fx.api('/api/quests', 'POST', { package: id, brief })).status, 201);
  assert.equal((await fx.api(`/api/quests/${id}/assign`, 'POST', { adventurer: 'oc-mimo' })).status, 200);
  await tick();
  const store = fx.server.store;
  const name = store.get(id).assignee.name;
  fs.mkdirSync(path.join(fx.project.root, '.work', 'oc'), { recursive: true });
  fx.project.write(`.work/oc/${name}.md`, text);
  const report = captureAttemptReport({ config: fx.project.config, quest: store.get(id) });
  const attemptId = store.get(id).assignee.attemptId;
  store.setStatus(id, 'delivered', {
    detail: `交付已写入 .work/oc/${name}.md`, by: 'lanes', report, source: 'collector',
    evidence: { kind: 'collector', attemptId },
  });
  return { attemptId };
}

describe('POST /api/quests/:id/status — acceptance (feedback 15)', () => {
  it('owner accepts on the board with two matching evidence refs and a note; the record names owner and the refs', async () => {
    const { attemptId } = await deliverWithReport('ACC-1');
    const items = (await fx.api('/api/quests/ACC-1')).body.quest.evidence.items;
    const reportItem = items.find((i) => i.kind === 'report');
    assert.equal(reportItem.bound, true);
    const projectVerificationItem = items.find((i) => i.kind === 'project-verification');
    // Not configured in this fixture project, so it is honestly unbound — refusing to select it proves the
    // panel-side rule (only bound items are selectable) holds server-side too.
    assert.equal(projectVerificationItem.bound, false);

    const res = await fx.api('/api/quests/ACC-1/status', 'POST', {
      status: 'done', detail: 'owner 验收：看过了', by: 'owner',
      acceptance: { actor: 'owner', evidenceRefs: [{ kind: 'report', digest: reportItem.digest, attemptId }], note: '看过了' },
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.quest.acceptance, {
      actor: 'owner',
      evidenceRefs: [{ kind: 'report', ref: reportItem.ref, digest: reportItem.digest, attemptId }],
      note: '看过了',
    });
    // Read side: GET /api/quests/:id agrees.
    assert.deepEqual((await fx.api('/api/quests/ACC-1')).body.quest.acceptance, res.body.quest.acceptance);
  });

  it('a board click can never claim coordinator, and the refusal leaves the quest untouched', async () => {
    await deliverWithReport('ACC-2');
    const res = await fx.api('/api/quests/ACC-2/status', 'POST', {
      status: 'done', detail: 'x', by: 'owner', acceptance: { actor: 'coordinator' },
    });
    assert.equal(res.status, 409);
    assert.match(res.body.reasons[0].message, /看板点击不能记成 coordinator 验收/);
    assert.equal((await fx.api('/api/quests/ACC-2')).body.quest.status, 'delivered');
  });

  it('the CLI/MCP path (by defaults to coordinator) may record a coordinator acceptance', async () => {
    await deliverWithReport('ACC-3');
    const res = await fx.api(
      '/api/quests/ACC-3/status', 'POST',
      { status: 'done', detail: 'coordinator 验收', acceptance: { actor: 'coordinator', evidenceRefs: [] } },
      { 'x-questboard-source': 'cli' },
    );
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.quest.acceptance.actor, 'coordinator');
  });

  it('a mismatched evidence ref is refused with a Chinese reason naming the kind, and nothing is stored', async () => {
    await deliverWithReport('ACC-4');
    const res = await fx.api('/api/quests/ACC-4/status', 'POST', {
      status: 'done', detail: 'x', by: 'owner',
      acceptance: { actor: 'owner', evidenceRefs: [{ kind: 'report', digest: 'not-the-real-digest', attemptId: 'whatever' }] },
    });
    assert.equal(res.status, 409);
    assert.match(res.body.reasons[0].message, /证据引用对不上.*report/);
    assert.equal((await fx.api('/api/quests/ACC-4')).body.quest.status, 'delivered');
  });

  it('never automatic: a review that reports PASS never by itself advances its parent past reviewing, let alone to done', async () => {
    await deliverWithReport('ACC-5');
    const requested = await fx.api('/api/quests/ACC-5/review', 'POST', { adventurer: 'codex-luna', note: '' });
    assert.equal(requested.status, 201, requested.text);
    assert.equal(requested.body.quest.status, 'reviewing');
    const reviewId = requested.body.review.id;
    await tick();
    const store = fx.server.store;
    const reviewName = store.get(reviewId).assignee.name;
    fs.mkdirSync(path.join(fx.project.root, '.work', 'codex'), { recursive: true });
    fx.project.write(`.work/codex/${reviewName}.md`, 'VERDICT: PASS\n');
    const reviewReport = captureAttemptReport({ config: fx.project.config, quest: store.get(reviewId) });
    store.setStatus(reviewId, 'delivered', {
      detail: 'x', by: 'lanes', report: reviewReport, source: 'collector',
      evidence: { kind: 'collector', attemptId: store.get(reviewId).assignee.attemptId },
    });
    assert.equal((await fx.api(`/api/quests/${reviewId}`)).body.quest.report.verdict.verdict, 'PASS');
    const parent = (await fx.api('/api/quests/ACC-5')).body.quest;
    assert.equal(parent.status, 'reviewing', "the review's own PASS report never moves the parent by itself");
    assert.equal(parent.acceptance, undefined);
  });

  it('a legacy done quest (no acceptance in the request) stores and reads back with no acceptance field at all', async () => {
    await deliverWithReport('ACC-6');
    const res = await fx.api('/api/quests/ACC-6/status', 'POST', { status: 'done', detail: 'owner 验收', by: 'owner' });
    assert.equal(res.status, 200);
    assert.equal('acceptance' in res.body.quest, false);
    assert.equal('acceptance' in (await fx.api('/api/quests/ACC-6')).body.quest, false);
  });
});
