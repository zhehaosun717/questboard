// Suggestion S3: review-order warning/refusal end to end — a delivered quest with a PASS report but no
// project verification, judged as a review's upstream evidence (src/core/rules.js reviewUpstreamEvidence,
// src/core/evidence.js questEvidence). Default policy only ever warns; policy.reviewRequires can refuse,
// unless a recorded override (POST .../review-override) still matches the parent's current attempt.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture, tick } from './fixture.js';
import { captureAttemptReport } from '../../src/core/reportEvidence.js';

// Assigns oc-mimo to `id`, waits for the fake runner, writes a PASS report at the delivery path the lane
// expects, captures it and moves the quest to delivered with that reference bound — the same recipe
// quest-detail.test.js's RP-1 case uses, so the evidence shape here matches what EvidenceSection shows.
async function deliverWithPassReport(fx, id) {
  assert.equal((await fx.api(`/api/quests/${id}/assign`, 'POST', { adventurer: 'oc-mimo' })).status, 200);
  await tick();
  const store = fx.server.store;
  const name = store.get(id).assignee.name;
  fs.mkdirSync(path.join(fx.project.root, '.work', 'oc'), { recursive: true });
  fx.project.write(`.work/oc/${name}.md`, '# 报告\n\n没问题。\n\nVERDICT: PASS\n');
  const report = captureAttemptReport({ config: fx.project.config, quest: store.get(id) });
  store.setStatus(id, 'delivered', {
    detail: `交付已写入 .work/oc/${name}.md`, by: 'lanes', report, source: 'collector',
    evidence: { kind: 'collector', attemptId: store.get(id).assignee.attemptId },
  });
}

describe('review-order warning (default policy: warns, never refuses)', () => {
  let fx;
  before(async () => {
    fx = await startFixture({ projectOverrides: { verification: { progressDirs: ['.work/full'] } } });
    fx.project.write('docs/briefs/RUN-1-x.md', 'RUN-1');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' })).status, 201);
    await deliverWithPassReport(fx, 'RUN-1');
  });
  after(() => fx.close());

  it('shows the upstream_unverified warning before the drop, naming the gap in Chinese, and still allows it', async () => {
    const before = (await fx.api('/api/quests')).body;
    const verdict = before.reviewEligibility['RUN-1']['agy-gemini'];
    assert.equal(verdict.ok, true);
    const warning = verdict.warnings.find((w) => w.code === 'upstream_unverified');
    assert.ok(warning, JSON.stringify(verdict.warnings));
    assert.match(warning.message, /上游 RUN-1 最近一次派遣/);
    assert.match(warning.message, /项目验证记录缺失/);
    assert.match(warning.message, /未经项目验证/);

    const dropped = await fx.api('/api/quests/RUN-1/review', 'POST', { adventurer: 'agy-gemini' });
    assert.equal(dropped.status, 201, dropped.text);
    assert.equal(dropped.body.review.status, 'dispatched');

    const detail = await fx.api('/api/quests/REVIEW-RUN-1');
    assert.equal(detail.body.quest.upstreamReview.blocked, false);
    assert.equal(detail.body.quest.upstreamReview.parents[0].gap, true);
  });
});

describe('review-order refusal (policy.reviewRequires) and the recorded override', () => {
  let fx;
  before(async () => {
    fx = await startFixture({ projectOverrides: { policy: { reviewRequires: ['project-verification'] }, verification: { progressDirs: ['.work/full'] } } });
    fx.project.write('docs/briefs/RUN-1-x.md', 'RUN-1');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' })).status, 201);
    await deliverWithPassReport(fx, 'RUN-1');
  });
  after(() => fx.close());

  it('refuses the combined drop with the upstream text and writes nothing', async () => {
    const before = (await fx.api('/api/quests')).body;
    const verdict = before.reviewEligibility['RUN-1']['agy-gemini'];
    assert.equal(verdict.ok, false);
    const refusal = verdict.reasons.find((r) => r.code === 'upstream_unverified');
    assert.ok(refusal);
    assert.match(refusal.message, /项目验证记录缺失/);

    const dropped = await fx.api('/api/quests/RUN-1/review', 'POST', { adventurer: 'agy-gemini' });
    assert.equal(dropped.status, 409);
    assert.ok(dropped.body.reasons.some((r) => r.code === 'upstream_unverified'));
    assert.equal((await fx.api('/api/quests')).body.quests.some((q) => q.id === 'REVIEW-RUN-1'), false, 'a refused drop posts no review');
  });

  it('still lets a review be posted without a card, blocked but visible on its own detail', async () => {
    const posted = await fx.api('/api/quests/RUN-1/review', 'POST', { note: '看一下' });
    assert.equal(posted.status, 201, posted.text);
    const detail = await fx.api('/api/quests/REVIEW-RUN-1');
    const upstream = detail.body.quest.upstreamReview;
    assert.deepEqual(upstream.required, ['project-verification']);
    assert.deepEqual(upstream.failingParents, ['RUN-1']);
    assert.equal(upstream.blocked, true);
    assert.equal(upstream.override, null);
    // The board's own general eligibility (not the hypothetical reviewEligibility) refuses every card too,
    // since REVIEW-RUN-1 now exists as a real quest with kind 'review'.
    const snap = (await fx.api('/api/quests')).body;
    assert.equal(snap.eligibility['REVIEW-RUN-1']['agy-gemini'].ok, false);
  });

  it('requires a non-empty reason, and refuses on anything but a review quest', async () => {
    assert.equal((await fx.api('/api/quests/REVIEW-RUN-1/review-override', 'POST', { reason: '   ' })).status, 400);
    assert.equal((await fx.api('/api/quests/RUN-1/review-override', 'POST', { reason: '手工确认过' })).status, 409);
  });

  it('a recorded override lifts the block into a warning that names it, without touching any evidence', async () => {
    const overridden = await fx.api('/api/quests/REVIEW-RUN-1/review-override', 'POST', { reason: '手工确认过测试通过', by: 'owner' });
    assert.equal(overridden.status, 200, overridden.text);
    assert.equal(overridden.body.quest.reviewOverride.reason, '手工确认过测试通过');
    assert.ok(fx.events().some((e) => e.event === 'review_override' && e.package === 'REVIEW-RUN-1' && e.detail === '手工确认过测试通过'));

    const detail = await fx.api('/api/quests/REVIEW-RUN-1');
    assert.equal(detail.body.quest.upstreamReview.blocked, false);
    assert.equal(detail.body.quest.upstreamReview.override.valid, true);
    // Evidence itself is untouched: the parent's own states still show the gap, never a fabricated pass.
    assert.equal(detail.body.quest.upstreamReview.parents[0].states['project-verification'], 'missing');

    const snap = (await fx.api('/api/quests')).body;
    const verdict = snap.eligibility['REVIEW-RUN-1']['agy-gemini'];
    assert.equal(verdict.ok, true);
    assert.ok(verdict.warnings.some((w) => w.code === 'upstream_unverified' && w.message.includes('已记录例外')));
  });

  it('a later re-dispatch of the parent visibly invalidates the recorded override', async () => {
    assert.equal((await fx.api('/api/quests/RUN-1/status', 'POST', { status: 'bounced', detail: '退回重跑', by: 'owner' })).status, 200);
    await deliverWithPassReport(fx, 'RUN-1');

    const detail = await fx.api('/api/quests/REVIEW-RUN-1');
    const upstream = detail.body.quest.upstreamReview;
    assert.equal(upstream.override.valid, false, 'the override was recorded against the earlier attempt id');
    assert.equal(upstream.blocked, true);

    const snap = (await fx.api('/api/quests')).body;
    const verdict = snap.eligibility['REVIEW-RUN-1']['agy-gemini'];
    assert.equal(verdict.ok, false);
    const refusal = verdict.reasons.find((r) => r.code === 'upstream_unverified');
    assert.match(refusal.message, /记录的例外已失效/);
  });
});

// F1 (round-1 blocker): dispatcher.assign builds its own env with no evidenceOf, so a plain assign on an
// already-posted review quest skipped the upstream check entirely — the preview refused while assign let it
// through. questRoutes.js's assign branch now judges a review quest with the exact env buildSnapshot's own
// eligibility loop uses, before ever calling dispatcher.assign, so the two agree.
describe('F1: the plain assign route enforces the same policy the preview already shows', () => {
  let fx;
  before(async () => {
    fx = await startFixture({ projectOverrides: { policy: { reviewRequires: ['project-verification'] }, verification: { progressDirs: ['.work/full'] } } });
    fx.project.write('docs/briefs/RUN-1-x.md', 'RUN-1');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' })).status, 201);
    await deliverWithPassReport(fx, 'RUN-1');
    const posted = await fx.api('/api/quests/RUN-1/review', 'POST', { note: '看一下' });
    assert.equal(posted.status, 201, posted.text);
  });
  after(() => fx.close());

  it('refuses with 409 and the exact reasons the preview shows, and posts nothing new', async () => {
    const preview = (await fx.api('/api/quests')).body.eligibility['REVIEW-RUN-1']['agy-gemini'];
    assert.equal(preview.ok, false);
    assert.ok(preview.reasons.some((r) => r.code === 'upstream_unverified'), JSON.stringify(preview.reasons));

    const assigned = await fx.api('/api/quests/REVIEW-RUN-1/assign', 'POST', { adventurer: 'agy-gemini' });
    assert.equal(assigned.status, 409, assigned.text);
    assert.equal(assigned.body.error, 'refused');
    assert.deepEqual(assigned.body.reasons, preview.reasons);

    const after = (await fx.api('/api/quests/REVIEW-RUN-1')).body.quest;
    assert.equal(after.status, 'posted', 'a refused assign never dispatches the review');
    assert.equal(after.assignee, null);
  });

  it('allows the same card once a recorded override is valid, and actually dispatches it', async () => {
    assert.equal((await fx.api('/api/quests/REVIEW-RUN-1/review-override', 'POST', { reason: '手工确认过测试通过' })).status, 200);
    const preview = (await fx.api('/api/quests')).body.eligibility['REVIEW-RUN-1']['agy-gemini'];
    assert.equal(preview.ok, true, JSON.stringify(preview));

    const assigned = await fx.api('/api/quests/REVIEW-RUN-1/assign', 'POST', { adventurer: 'agy-gemini' });
    assert.equal(assigned.status, 200, assigned.text);
    assert.equal(assigned.body.quest.status, 'dispatched');
    assert.equal(assigned.body.quest.assignee.adventurerId, 'agy-gemini');
  });
});

// R2-F1 (round-2 blocker): the F1 pre-check above ran before dispatcher.assign ever got a chance to answer
// repeated(requestKey) or staleRevision(ifRevision), so a retried request on a review quest — the exact case
// request keys and ifRevision exist for — was judged as a fresh assign and refused with `quest_not_open`
// instead of MAIN's 200 {repeated:true} or {error:'stale'}. The route now mirrors dispatcher.assign's own
// order: a requestKey already recorded on the quest, or a stale ifRevision, skips the pre-check entirely and
// lets dispatcher.assign answer; otherwise only an upstream_unverified reason is refused here.
describe('R2-F1: idempotent replay and stale revision bypass the upstream pre-check', () => {
  it('replays a review assign by requestKey as 200 {repeated:true} under the default policy', async () => {
    const fx = await startFixture({ projectOverrides: { verification: { progressDirs: ['.work/full'] } } });
    fx.project.write('docs/briefs/RUN-1-x.md', 'RUN-1');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' })).status, 201);
    await deliverWithPassReport(fx, 'RUN-1');
    const posted = await fx.api('/api/quests/RUN-1/review', 'POST', { note: '看一下' });
    assert.equal(posted.status, 201, posted.text);

    const first = await fx.api('/api/quests/REVIEW-RUN-1/assign', 'POST', { adventurer: 'agy-gemini', requestKey: 'rk-default-1' });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.quest.status, 'dispatched');

    const replay = await fx.api('/api/quests/REVIEW-RUN-1/assign', 'POST', { adventurer: 'agy-gemini', requestKey: 'rk-default-1' });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.body.repeated, true);
    await fx.close();
  });

  it('replays a review assign by requestKey as 200 {repeated:true} under a strict policy, even once a later re-dispatch of the parent would refuse a fresh assign', async () => {
    const fx = await startFixture({ projectOverrides: { policy: { reviewRequires: ['project-verification'] }, verification: { progressDirs: ['.work/full'] } } });
    fx.project.write('docs/briefs/RUN-1-x.md', 'RUN-1');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' })).status, 201);
    await deliverWithPassReport(fx, 'RUN-1');
    const posted = await fx.api('/api/quests/RUN-1/review', 'POST', { note: '看一下' });
    assert.equal(posted.status, 201, posted.text);
    assert.equal((await fx.api('/api/quests/REVIEW-RUN-1/review-override', 'POST', { reason: '手工确认过测试通过' })).status, 200);

    const first = await fx.api('/api/quests/REVIEW-RUN-1/assign', 'POST', { adventurer: 'agy-gemini', requestKey: 'rk-strict-1' });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.quest.status, 'dispatched');

    // Invalidate the recorded override by re-dispatching the parent: a fresh assign would now be refused
    // again, but the replay must still be answered as a replay, never re-judged against the stale override.
    assert.equal((await fx.api('/api/quests/RUN-1/status', 'POST', { status: 'bounced', detail: '退回重跑', by: 'owner' })).status, 200);
    await deliverWithPassReport(fx, 'RUN-1');

    const replay = await fx.api('/api/quests/REVIEW-RUN-1/assign', 'POST', { adventurer: 'agy-gemini', requestKey: 'rk-strict-1' });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.body.repeated, true);
    await fx.close();
  });

  it('answers a stale ifRevision on a blocked review with {error:"stale"}, not the upstream refusal', async () => {
    const fx = await startFixture({ projectOverrides: { policy: { reviewRequires: ['project-verification'] }, verification: { progressDirs: ['.work/full'] } } });
    fx.project.write('docs/briefs/RUN-1-x.md', 'RUN-1');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' })).status, 201);
    await deliverWithPassReport(fx, 'RUN-1');
    const posted = await fx.api('/api/quests/RUN-1/review', 'POST', { note: '看一下' });
    assert.equal(posted.status, 201, posted.text);
    const revision = (await fx.api('/api/quests/REVIEW-RUN-1')).body.quest.revision;

    const stale = await fx.api('/api/quests/REVIEW-RUN-1/assign', 'POST', { adventurer: 'agy-gemini', ifRevision: revision + 1 });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.error, 'stale');
    assert.equal(stale.body.revision, revision);

    const after = (await fx.api('/api/quests/REVIEW-RUN-1')).body.quest;
    assert.equal(after.status, 'posted', 'a stale-revision answer never dispatches the review');
    assert.equal(after.assignee, null);
    await fx.close();
  });

  it('still refuses a blocked review with 409 upstream_unverified when the requestKey has never been dispatched', async () => {
    const fx = await startFixture({ projectOverrides: { policy: { reviewRequires: ['project-verification'] }, verification: { progressDirs: ['.work/full'] } } });
    fx.project.write('docs/briefs/RUN-1-x.md', 'RUN-1');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' })).status, 201);
    await deliverWithPassReport(fx, 'RUN-1');
    const posted = await fx.api('/api/quests/RUN-1/review', 'POST', { note: '看一下' });
    assert.equal(posted.status, 201, posted.text);

    const blocked = await fx.api('/api/quests/REVIEW-RUN-1/assign', 'POST', { adventurer: 'agy-gemini', requestKey: 'rk-never-dispatched' });
    assert.equal(blocked.status, 409, blocked.text);
    assert.equal(blocked.body.error, 'refused');
    assert.ok(blocked.body.reasons.length > 0 && blocked.body.reasons.every((r) => r.code === 'upstream_unverified'), JSON.stringify(blocked.body.reasons));

    const after = (await fx.api('/api/quests/REVIEW-RUN-1')).body.quest;
    assert.equal(after.status, 'posted');
    assert.equal(after.assignee, null);
    await fx.close();
  });
});
