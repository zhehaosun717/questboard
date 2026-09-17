import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canDispatch, classifyEvidenceItem, eligibility, isOwnActiveAttempt, reviewUpstreamEvidence } from '../../src/core/rules.js';
import { card, quest } from '../helpers.js';

const policy = { bannedModelPatterns: ['gpt-5\\.5', '-fast(\\b|-)'], bannedAgents: ['Sisyphus'] };
const env = { treeLocked: false, briefExists: true, laneIds: new Set(['codex', 'agy', 'opencode', 'dsh']) };
const luna = card('codex-luna');
const check = (q, adventurer = luna, quests = [q], environment = env) => canDispatch({ quest: q, adventurer, quests, policy, env: environment });
const codes = (result) => result.reasons.map((r) => r.code);

describe('canDispatch', () => {
  it('allows an available card on an open quest', () => {
    assert.deepEqual(check(quest()), {
      ok: true,
      reasons: [],
      warnings: [{ code: 'variant_unconfirmed', message: '尚未确认这张卡支持 variant「high」，派遣会照常进行' }],
    });
  });

  it('refuses declared variant incompatibility, warns for unknown support, and stays quiet with no variant', () => {
    const unsupported = check(quest(), card('codex-luna', { variants: [] }));
    assert.equal(unsupported.ok, false);
    assert.deepEqual(unsupported.reasons[0], {
      code: 'variant_unsupported',
      message: '这张卡的模型不接受 variant「high」，请在名册里清空 variant 或改用支持它的卡',
    });
    const listed = check(quest(), card('codex-luna', { variants: ['low', 'medium'] }));
    assert.equal(listed.ok, false);
    assert.equal(listed.reasons.find((reason) => reason.code === 'variant_unsupported').message, '这张卡的模型不接受 variant「high」，可接受的值是：low、medium');
    const unknown = check(quest(), card('codex-luna'));
    assert.equal(unknown.ok, true);
    assert.deepEqual(unknown.warnings, [{ code: 'variant_unconfirmed', message: '尚未确认这张卡支持 variant「high」，派遣会照常进行' }]);
    assert.deepEqual(check(quest(), card('codex-luna', { variant: '' })), { ok: true, reasons: [] });
  });

  it('allows re-dispatch after bounce, failure, stall or a lane limit, but not while running', () => {
    for (const status of ['bounced', 'failed', 'stalled', 'lane_limited']) assert.equal(check(quest({ status })).ok, true, status);
    assert.ok(codes(check(quest({ status: 'dispatched' }))).includes('quest_not_open'));
  });

  it('refuses owner quests, open rulings and missing parents', () => {
    assert.ok(codes(check(quest({ kind: 'owner' }))).includes('owner_quest'));
    assert.ok(codes(check(quest({ needsOwner: 'which leachate?' }))).includes('needs_owner'));
    assert.ok(codes(check(quest({ parents: ['RUN-9'] }))).includes('parent_missing'));
  });

  it('names the card status, bans and a lane the project lacks', () => {
    for (const status of ['limited', 'broke', 'paused', 'disabled']) assert.ok(codes(check(quest(), card('codex-luna', { status }))).includes(`adventurer_${status}`), status);
    assert.ok(codes(check(quest(), card('codex-luna', { model: 'gpt-5.5' }))).includes('model_banned'));
    assert.ok(codes(check(quest(), card('oc-mimo', { agent: 'Sisyphus - ultraworker' }))).includes('agent_banned'));
    assert.ok(codes(check(quest(), card('codex-luna', { lane: 'claude' }))).includes('lane_missing'));
    assert.ok(codes(check(quest({ allowedLanes: ['agy'] }))).includes('lane_not_allowed'));
  });

  it('refuses a card whose lane server is down and shows the server address', () => {
    const downEnv = { ...env, downLanes: new Map([['opencode', 'http://127.0.0.1:6096']]) };
    const ocResult = check(quest(), card('oc-mimo'), [quest()], downEnv);
    assert.ok(codes(ocResult).includes('lane_server_down'));
    const reason = ocResult.reasons.find((r) => r.code === 'lane_server_down');
    assert.match(reason.message, /http:\/\/127\.0\.0\.1:6096/);
    const otherResult = check(quest(), luna, [quest()], downEnv);
    assert.ok(!codes(otherResult).includes('lane_server_down'));
  });

  it('enforces the parallel limit', () => {
    const running = quest({ id: 'LOOK-2F', status: 'dispatched', assignee: { adventurerId: 'codex-luna' } });
    const verdict = check(quest(), luna, [running, quest()]);
    assert.ok(codes(verdict).includes('adventurer_busy'));
    assert.equal(verdict.reasons.find((r) => r.code === 'adventurer_busy').message, '已在做 1/1 个任务（LOOK-2F dispatched），满了');
    assert.equal(check(quest(), card('codex-luna', { maxParallel: 2 }), [running, quest()]).ok, true);
  });

  it('counts a full limit against reserved slots only and names every occupier with its state', () => {
    const three = card('codex-luna', { maxParallel: 3 });
    const mine = (id, status) => quest({ id, status, assignee: { adventurerId: 'codex-luna' } });
    const candidate = quest({ id: 'RUN-14' });
    const room = check(candidate, three, [mine('RUN-10', 'dispatched'), mine('RUN-11', 'dispatched'), mine('RUN-12', 'delivered'), candidate]);
    assert.equal(room.ok, true, 'two running and one delivered leave room under a limit of three');
    const full = check(candidate, three, [mine('RUN-10', 'dispatched'), mine('RUN-11', 'dispatched'), mine('RUN-12', 'delivered'), mine('RUN-13', 'stalled'), quest({ id: 'RUN-99', status: 'dispatched', assignee: { adventurerId: 'agy-gemini' } }), candidate]);
    assert.ok(codes(full).includes('adventurer_busy'), 'three reserved slots fill the limit');
    const message = full.reasons.find((r) => r.code === 'adventurer_busy').message;
    assert.equal(message, '已在做 3/3 个任务（RUN-10 dispatched、RUN-11 dispatched、RUN-13 stalled），满了');
    assert.ok(!message.includes('RUN-12'), 'a delivered quest does not reserve a slot');
    assert.ok(!message.includes('RUN-99'), "another card's quests are not occupiers of this one");
    assert.ok(!message.includes('RUN-14'), 'the candidate quest is never listed against itself');
  });

  it('refuses a lane once its configured concurrency is reached, naming lane and limit', () => {
    const lanePolicy = { ...policy, laneConcurrency: { codex: 1 } };
    const running = quest({ id: 'LOOK-2F', status: 'dispatched', assignee: { adventurerId: 'codex-luna', lane: 'codex' } });
    const candidate = quest({ id: 'RUN-14' });
    const verdict = canDispatch({ quest: candidate, adventurer: card('codex-luna', { maxParallel: 5 }), quests: [running, candidate], policy: lanePolicy, env });
    assert.ok(codes(verdict).includes('lane_busy'));
    assert.equal(verdict.reasons.find((r) => r.code === 'lane_busy').message, '这条通道已有 1 个 worker 在跑，上限 1，等一个结束再派');
  });

  it('leaves running workers alone when the limit is lowered under them; only the new dispatch is refused', () => {
    const lanePolicy = { ...policy, laneConcurrency: { codex: 1 } };
    const first = quest({ id: 'RUN-10', status: 'dispatched', assignee: { adventurerId: 'codex-luna', lane: 'codex' } });
    const second = quest({ id: 'RUN-11', status: 'stalled', assignee: { adventurerId: 'codex-astra', lane: 'codex' } });
    const third = quest({ id: 'RUN-12' });
    assert.equal(first.status, 'dispatched', 'the two already running quests keep their state: nothing here ends a worker');
    assert.equal(second.status, 'stalled');
    const verdict = canDispatch({ quest: third, adventurer: card('codex-astra', { maxParallel: 5 }), quests: [first, second, third], policy: lanePolicy, env });
    assert.deepEqual(codes(verdict), ['lane_busy']);
    assert.equal(verdict.reasons[0].message, '这条通道已有 2 个 worker 在跑，上限 1，等一个结束再派');
  });

  it('does not count the candidate against its own lane slot, and leaves lanes without a limit unlimited', () => {
    const lanePolicy = { ...policy, laneConcurrency: { codex: 1 } };
    const mine = quest({ id: 'RUN-5', status: 'stalled', assignee: { adventurerId: 'codex-luna', lane: 'codex', name: 'run5' } });
    const verdict = canDispatch({ quest: mine, adventurer: luna, quests: [mine], policy: lanePolicy, env });
    assert.ok(!codes(verdict).includes('lane_busy'), 'the quest itself never occupies its own lane slot');
    const otherLane = quest({ id: 'RUN-6' });
    const free = canDispatch({ quest: otherLane, adventurer: card('agy-gemini'), quests: [otherLane], policy: lanePolicy, env });
    assert.equal(free.ok, true, 'a lane without a configured limit stays unlimited');
  });

  it('does not count the candidate quest against its own parallel limit', () => {
    const silent = quest({ id: 'RUN-5', status: 'stalled', assignee: { adventurerId: 'codex-luna', name: 'run5' } });
    const verdict = check(silent, luna, [silent]);
    assert.ok(codes(verdict).includes('worker_unconfirmed'));
    assert.ok(!codes(verdict).includes('adventurer_busy'), 'its reserved slot is the very slot this drop is about');
  });

  it('keeps one model family from reviewing any ancestor it wrote', () => {
    const code = quest({ id: 'RUN-3', status: 'done', dispatches: [{ adventurerId: 'oc-deepseek', family: 'deepseek-v4-pro' }] });
    const review1 = quest({ id: 'REVIEW-24', kind: 'review', status: 'done', parents: ['RUN-3'], dispatches: [{ adventurerId: 'agy-gemini', family: 'gemini-3.8-flash' }] });
    const fix = quest({ id: 'FIX-8', status: 'delivered', parents: ['REVIEW-24'], dispatches: [{ adventurerId: 'codex-luna', family: 'gpt-5.6-luna' }] });
    const review2 = quest({ id: 'REVIEW-26', kind: 'review', parents: ['FIX-8'] });
    const all = [code, review1, fix, review2];
    assert.ok(codes(check(review2, card('oc-nv-deepseek'), all)).includes('reviewer_coded_parent'));
    assert.equal(check(review2, card('agy-gemini'), all).ok, true, 'reviewing again after an earlier review is allowed');
  });

  it('queues on a declared or file-list conflict with a running quest', () => {
    const running = quest({ id: 'RUN-5', status: 'dispatched', assignee: { adventurerId: 'agy-gemini' }, files: ['Assets/Hud.RunHud.cs'] });
    const overlap = check(quest({ files: ['Assets/Hud.RunHud.cs'] }), luna, [running, quest({ files: ['Assets/Hud.RunHud.cs'] })]);
    assert.match(overlap.reasons.find((r) => r.code === 'conflict_running').message, /^排队：RUN-5 正在改同一批文件（Hud\.RunHud\.cs），一次一个$/);
    assert.ok(codes(check(quest({ conflicts: ['RUN-5'] }), luna, [{ ...running, files: [] }, quest({ conflicts: ['RUN-5'] })])).includes('conflict_running'));
    assert.ok(codes(check(quest(), luna, [{ ...running, files: [], conflicts: ['RUN-4'] }, quest()])).includes('conflict_running'));
  });

  it('binds a declared conflict on disjoint files and names it as declared, in both directions', () => {
    const runner = quest({ id: 'RUN-5', status: 'dispatched', assignee: { adventurerId: 'agy-gemini' }, files: ['Assets/Save.cs'] });
    const iDeclare = quest({ id: 'RUN-6', files: ['Assets/Hud.cs'], conflicts: ['RUN-5'] });
    const mineVerdict = check(iDeclare, luna, [runner, iDeclare]);
    const mineConflict = mineVerdict.reasons.find((r) => r.code === 'conflict_running');
    assert.ok(mineConflict, 'my own declaration binds even with disjoint files');
    assert.equal(mineConflict.message, '排队：RUN-5 与本任务声明了冲突，一次一个');
    const runnerDeclares = quest({ id: 'RUN-5', status: 'dispatched', assignee: { adventurerId: 'agy-gemini' }, files: ['Assets/Save.cs'], conflicts: ['RUN-6'] });
    const theyDeclare = quest({ id: 'RUN-6', files: ['Assets/Hud.cs'] });
    const theirsVerdict = check(theyDeclare, luna, [runnerDeclares, theyDeclare]);
    const theirsConflict = theirsVerdict.reasons.find((r) => r.code === 'conflict_running');
    assert.ok(theirsConflict, 'their declaration against me binds too');
    assert.equal(theirsConflict.message, '排队：RUN-5 与本任务声明了冲突，一次一个');
    const sharedVerdict = check(quest({ id: 'RUN-6', files: ['Assets/Save.cs'] }), luna, [runner, quest({ id: 'RUN-6', files: ['Assets/Save.cs'] })]);
    assert.match(sharedVerdict.reasons.find((r) => r.code === 'conflict_running').message, /^排队：RUN-5 正在改同一批文件（Save\.cs），一次一个$/, 'only a real overlap may claim shared files');
  });

  it('lets disjoint files through and treats stalled neighbours as running but delivered ones as free', () => {
    const runner = quest({ id: 'RUN-5', status: 'dispatched', assignee: { adventurerId: 'agy-gemini' }, files: ['Assets/Save.cs'] });
    const free = quest({ id: 'RUN-6', files: ['Assets/Hud.cs'] });
    assert.equal(check(free, luna, [runner, free]).ok, true, 'disjoint files and no declaration is no conflict');
    const silent = { ...runner, status: 'stalled' };
    const touchesStalled = quest({ id: 'RUN-6', files: ['Assets/Save.cs'] });
    assert.ok(codes(check(touchesStalled, luna, [silent, touchesStalled])).includes('conflict_running'), 'a stalled quest still reserves its files');
    const done = { ...runner, status: 'delivered' };
    assert.equal(check(touchesStalled, luna, [done, touchesStalled]).ok, true, 'a delivered quest has freed its files');
  });

  it("holds a stalled worker's slot and files until it is released", () => {
    const silent = quest({ id: 'RUN-5', status: 'stalled', assignee: { adventurerId: 'codex-luna', name: 'run5' }, files: ['Assets/Hud.cs'] });
    const verdict = check(silent, card('agy-gemini'), [silent]);
    assert.ok(codes(verdict).includes('worker_unconfirmed'));
    assert.match(verdict.reasons.find((r) => r.code === 'worker_unconfirmed').message, /run5/);
    assert.ok(codes(check(quest(), luna, [silent, quest()])).includes('adventurer_busy'), 'the stalled worker still counts against its card');
    assert.ok(codes(check(quest({ files: ['Assets/Hud.cs'] }), card('agy-gemini'), [silent, quest({ files: ['Assets/Hud.cs'] })])).includes('conflict_running'));
    const released = { ...silent, assignee: null };
    assert.equal(check(released, card('agy-gemini'), [released]).ok, true);
    assert.equal(check(quest(), luna, [released, quest()]).ok, true);
  });

  it('sends art only to cards that draw, and pauses on the lock or a missing brief', () => {
    assert.ok(codes(check(quest({ kind: 'art' }))).includes('needs_artist'));
    assert.equal(check(quest({ kind: 'art' }), card('codex-astra')).ok, true);
    assert.ok(codes(check(quest(), luna, [quest()], { ...env, treeLocked: true })).includes('tree_locked'));
    assert.ok(codes(check(quest(), luna, [quest()], { ...env, briefExists: false })).includes('brief_missing'));
  });

  it('uses the distinct brief_unusable reason, not brief_missing, when the brief exists but cannot be trusted (revision 4)', () => {
    const unusableEnv = { ...env, briefExists: false, briefUnusable: { reason: '文件过大（2.0MB，上限 2MB）' } };
    const result = check(quest(), luna, [quest()], unusableEnv);
    assert.ok(codes(result).includes('brief_unusable'));
    assert.ok(!codes(result).includes('brief_missing'), 'brief_unusable must take priority so the message never claims a present file is missing');
    const reasonObj = result.reasons.find((r) => r.code === 'brief_unusable');
    assert.match(reasonObj.message, /docs\/briefs\/RUN-4-x\.md/, 'must name the actual brief file');
    assert.match(reasonObj.message, /文件过大/, 'must pass the real cause through');
  });

  it('gives every reason a Chinese message', () => {
    const q = quest({ status: 'dispatched', needsOwner: 'x', allowedLanes: ['agy'] });
    const result = check(q, card('codex-luna', { status: 'broke', model: 'gpt-5.5' }), [q], { ...env, treeLocked: true, briefExists: false });
    assert.ok(result.reasons.length >= 6);
    for (const r of result.reasons) assert.match(r.message, /[一-鿿]/u);
  });
});

// The predicate a queued recheck uses to tell "my own attempt, still legitimately holding this quest" apart
// from "a new assignment competing for it" — used inside canDispatch via selfAttemptId, but tested here on
// its own since it is the one piece of new logic these scenarios all turn on.
describe('isOwnActiveAttempt', () => {
  it('is true only for the matching attemptId on a dispatched or stalled quest', () => {
    const mine = quest({ status: 'dispatched', assignee: { name: 'run4', attemptId: 'att-1' } });
    assert.equal(isOwnActiveAttempt(mine, 'att-1'), true);
    assert.equal(isOwnActiveAttempt(mine, 'att-2'), false, 'a different attempt is not "own"');
    assert.equal(isOwnActiveAttempt(mine, undefined), false, 'no selfAttemptId at all means a fresh assignment, never "own"');
    assert.equal(isOwnActiveAttempt(quest({ status: 'posted', assignee: null }), 'att-1'), false, 'no assignee at all is never "own"');
    assert.equal(isOwnActiveAttempt(quest({ status: 'done', assignee: { name: 'run4', attemptId: 'att-1' } }), 'att-1'), false, 'a terminal status is never "own", whatever the assignee says');
  });
});

// A queued job rechecks canDispatch again right before it spawns (dispatcher.js's recheckOpen); these prove
// canDispatch's own selfAttemptId narrows only the two reasons that exist purely to protect a slot from a
// second, competing assignment (quest_not_open, worker_unconfirmed) and nothing else — a newly posted
// needs_owner, a card paused or banned meanwhile, a changed allowedLanes, or a blocked parent/reviewer
// ancestor all still refuse the very attempt that already holds the quest, exactly as they would a stranger.
describe('canDispatch selfAttemptId (queued recheck)', () => {
  it('does not refuse its own dispatched attempt for being dispatched, or its own stalled attempt as an unconfirmed foreign worker', () => {
    const mine = quest({ status: 'dispatched', assignee: { adventurerId: 'codex-luna', name: 'run4', attemptId: 'att-1' } });
    assert.ok(codes(check(mine)).includes('quest_not_open'), 'a fresh assignment attempt (no selfAttemptId) is still refused as usual');
    assert.equal(canDispatch({ quest: mine, adventurer: luna, quests: [mine], policy, env, selfAttemptId: 'att-1' }).ok, true);

    const silentMine = quest({ status: 'stalled', assignee: { adventurerId: 'codex-luna', name: 'run4', attemptId: 'att-2' } });
    assert.ok(codes(check(silentMine)).includes('worker_unconfirmed'));
    assert.equal(canDispatch({ quest: silentMine, adventurer: luna, quests: [silentMine], policy, env, selfAttemptId: 'att-2' }).ok, true);
  });

  it('still refuses a needs_owner question newly posted while queued, even for the current attempt', () => {
    const mine = quest({ status: 'dispatched', needsOwner: '要不要换个模型', assignee: { adventurerId: 'codex-luna', name: 'run4', attemptId: 'att-3' } });
    const verdict = canDispatch({ quest: mine, adventurer: luna, quests: [mine], policy, env, selfAttemptId: 'att-3' });
    assert.ok(codes(verdict).includes('needs_owner'));
  });

  it('still refuses a card paused meanwhile or a lane no longer allowed, even for the current attempt', () => {
    const paused = quest({ status: 'dispatched', assignee: { adventurerId: 'codex-luna', name: 'run4', attemptId: 'att-4' } });
    assert.ok(codes(canDispatch({ quest: paused, adventurer: card('codex-luna', { status: 'paused' }), quests: [paused], policy, env, selfAttemptId: 'att-4' })).includes('adventurer_paused'));

    const relaned = quest({ status: 'dispatched', allowedLanes: ['agy'], assignee: { adventurerId: 'codex-luna', name: 'run4', attemptId: 'att-5' } });
    assert.ok(codes(canDispatch({ quest: relaned, adventurer: luna, quests: [relaned], policy, env, selfAttemptId: 'att-5' })).includes('lane_not_allowed'));
  });

  it('still refuses a blocked parent or a reviewer-authored-parent constraint, even for the current attempt', () => {
    const missingParent = quest({ status: 'dispatched', parents: ['RUN-9'], assignee: { adventurerId: 'codex-luna', name: 'run4', attemptId: 'att-6' } });
    assert.ok(codes(canDispatch({ quest: missingParent, adventurer: luna, quests: [missingParent], policy, env, selfAttemptId: 'att-6' })).includes('parent_missing'));

    const code = quest({ id: 'RUN-3', status: 'done', dispatches: [{ adventurerId: 'oc-deepseek', family: 'deepseek-v4-pro' }] });
    const review = quest({ id: 'REVIEW-24', kind: 'review', status: 'dispatched', parents: ['RUN-3'], assignee: { adventurerId: 'oc-nv-deepseek', name: 'r24', attemptId: 'att-7' } });
    const verdict = canDispatch({ quest: review, adventurer: card('oc-nv-deepseek'), quests: [code, review], policy, env, selfAttemptId: 'att-7' });
    assert.ok(codes(verdict).includes('reviewer_coded_parent'));
  });

  it('does not refuse the current attempt against its own reservation as if it were a competing occupier', () => {
    const mine = quest({ id: 'RUN-14', status: 'dispatched', assignee: { adventurerId: 'codex-luna', name: 'run14', attemptId: 'att-8' } });
    const verdict = canDispatch({ quest: mine, adventurer: luna, quests: [mine], policy, env, selfAttemptId: 'att-8' });
    assert.ok(!codes(verdict).includes('adventurer_busy'), 'the candidate quest is excluded from its own limit regardless of selfAttemptId');
  });
});

describe('eligibility', () => {
  it('maps every card to its verdict without mutating inputs', () => {
    const frozen = Object.freeze(quest());
    const result = eligibility({ quest: frozen, roster: [luna, card('codex-astra', { status: 'paused' })], quests: [frozen], policy, env });
    assert.equal(result['codex-luna'].ok, true);
    assert.equal(result['codex-astra'].ok, false);
  });
});

// Suggestion S3: the review-order upstream check. evidenceOf is the pure env bridge src/core/snapshot.js
// builds from src/core/evidence.js questEvidence — these tests supply small fixed evidence shapes directly,
// since rules.js never reads evidence itself.
describe('classifyEvidenceItem', () => {
  it('names the six honest states in priority order', () => {
    assert.equal(classifyEvidenceItem(undefined), 'unknown');
    assert.equal(classifyEvidenceItem({ state: 'not_configured', bound: false }), 'not_configured');
    assert.equal(classifyEvidenceItem({ state: 'missing', bound: false }), 'missing');
    assert.equal(classifyEvidenceItem({ state: 'passed', bound: false }), 'stale', 'bound:false wins over a passed state — never a stale record read as current');
    assert.equal(classifyEvidenceItem({ state: 'passed', bound: true }), 'passed');
    assert.equal(classifyEvidenceItem({ state: 'failed', bound: true }), 'failed');
    assert.equal(classifyEvidenceItem({ state: 'findings', bound: true }), 'unknown');
    assert.equal(classifyEvidenceItem({ state: 'queued', bound: true }), 'unknown');
  });
});

describe('reviewUpstreamEvidence', () => {
  const evidence = (overrides = {}) => ({
    version: 1, attemptId: 'a1', attemptAt: '2026-09-14T00:00:00.000Z',
    items: [
      { kind: 'report', state: 'missing', bound: false },
      { kind: 'project-verification', state: 'not_configured', bound: false },
      { kind: 'hook', state: 'not_configured', bound: false },
    ],
    ...overrides,
  });
  const passedReportOnly = () => evidence({ items: [
    { kind: 'report', state: 'passed', bound: true },
    { kind: 'project-verification', state: 'not_configured', bound: false },
    { kind: 'hook', state: 'not_configured', bound: false },
  ] });
  const envFor = (byId) => ({ evidenceOf: (id) => byId.get(id) || null });

  it('returns null for anything but a review quest, or when the env has no evidenceOf', () => {
    const code = quest({ id: 'PKG-1' });
    assert.equal(reviewUpstreamEvidence({ quest: code, quests: [code], policy: {}, env: envFor(new Map()) }), null);
    const review = quest({ id: 'REVIEW-1', kind: 'review', parents: ['PKG-1'] });
    assert.equal(reviewUpstreamEvidence({ quest: review, quests: [review, code], policy: {}, env: {} }), null, 'no evidenceOf at all (e.g. dispatcher.js\'s own recheck env) is silence, never a guess');
  });

  it('flags a gap when a passed self-report has no actual project test behind it, and names it in the text', () => {
    const parentEvidence = passedReportOnly();
    const code = quest({ id: 'PKG-1' });
    const review = quest({ id: 'REVIEW-1', kind: 'review', parents: ['PKG-1'] });
    const result = reviewUpstreamEvidence({ quest: review, quests: [review, code], policy: {}, env: envFor(new Map([['PKG-1', parentEvidence]])) });
    assert.equal(result.parents.length, 1);
    assert.equal(result.parents[0].gap, true);
    assert.equal(result.parents[0].states.report, 'passed');
    assert.equal(result.parents[0].states['project-verification'], 'not_configured');
    assert.match(result.parents[0].text, /上游 PKG-1 本次尝试/);
    assert.match(result.parents[0].text, /未经项目验证/);
    assert.equal(result.blocked, false, 'no reviewRequires means never blocked');
  });

  it('shows no gap once an actual project test has passed', () => {
    const parentEvidence = evidence({ items: [
      { kind: 'report', state: 'passed', bound: true },
      { kind: 'project-verification', state: 'passed', bound: true },
      { kind: 'hook', state: 'not_configured', bound: false },
    ] });
    const code = quest({ id: 'PKG-1' });
    const review = quest({ id: 'REVIEW-1', kind: 'review', parents: ['PKG-1'] });
    const result = reviewUpstreamEvidence({ quest: review, quests: [review, code], policy: {}, env: envFor(new Map([['PKG-1', parentEvidence]])) });
    assert.equal(result.parents[0].gap, false);
  });

  it('blocks on a required kind that is not passed, unless a recorded override still matches the current attempt', () => {
    const code = quest({ id: 'PKG-1' });
    const parentEvidence = passedReportOnly();
    const review = quest({ id: 'REVIEW-1', kind: 'review', parents: ['PKG-1'] });
    const policy = { reviewRequires: ['project-verification'] };
    const env = envFor(new Map([['PKG-1', parentEvidence]]));
    const blocked = reviewUpstreamEvidence({ quest: review, quests: [review, code], policy, env });
    assert.deepEqual(blocked.failingParents, ['PKG-1']);
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.override, null);

    const overridden = { ...review, reviewOverride: { reason: '手工确认过', by: 'owner', at: '2026-09-14T01:00:00.000Z', parentAttempts: { 'PKG-1': 'a1' } } };
    const withOverride = reviewUpstreamEvidence({ quest: overridden, quests: [overridden, code], policy, env });
    assert.equal(withOverride.blocked, false, 'a matching override lifts the block without touching any evidence');
    assert.equal(withOverride.override.valid, true);

    const stale = { ...review, reviewOverride: { reason: '手工确认过', by: 'owner', at: '2026-09-14T01:00:00.000Z', parentAttempts: { 'PKG-1': 'a0' } } };
    const invalidated = reviewUpstreamEvidence({ quest: stale, quests: [stale, code], policy, env });
    assert.equal(invalidated.blocked, true, 'an override recorded against a different (superseded) attempt id no longer counts');
    assert.equal(invalidated.override.valid, false);
  });

  it('never counts a review parent itself as upstream evidence', () => {
    const earlierReview = quest({ id: 'REVIEW-A', kind: 'review', status: 'done', parents: [] });
    const review = quest({ id: 'REVIEW-B', kind: 'review', parents: ['REVIEW-A'] });
    const result = reviewUpstreamEvidence({ quest: review, quests: [review, earlierReview], policy: {}, env: envFor(new Map([['REVIEW-A', passedReportOnly()]])) });
    assert.deepEqual(result.parents, []);
  });
});

describe('canDispatch — review upstream warning/refusal (S3)', () => {
  const evidence = (items) => ({ version: 1, attemptId: 'a1', attemptAt: '2026-09-14T00:00:00.000Z', items });
  const gapEvidence = evidence([
    { kind: 'report', state: 'passed', bound: true },
    { kind: 'project-verification', state: 'not_configured', bound: false },
    { kind: 'hook', state: 'not_configured', bound: false },
  ]);

  it('is silent for a non-review quest even with evidenceOf present', () => {
    const code = quest({ id: 'PKG-1' });
    const envWithEvidence = { ...env, evidenceOf: () => gapEvidence };
    assert.deepEqual(check(code, luna, [code], envWithEvidence), { ok: true, reasons: [], warnings: [{ code: 'variant_unconfirmed', message: '尚未确认这张卡支持 variant「high」，派遣会照常进行' }] });
  });

  it('warns (never refuses) by default, naming the parent and the gap', () => {
    const code = quest({ id: 'PKG-1', status: 'done' });
    const review = quest({ id: 'REVIEW-1', kind: 'review', parents: ['PKG-1'] });
    const envWithEvidence = { ...env, evidenceOf: (id) => (id === 'PKG-1' ? gapEvidence : null) };
    const verdict = canDispatch({ quest: review, adventurer: card('agy-gemini'), quests: [review, code], policy, env: envWithEvidence });
    assert.equal(verdict.ok, true);
    const warning = verdict.warnings.find((w) => w.code === 'upstream_unverified');
    assert.ok(warning, JSON.stringify(verdict.warnings));
    assert.match(warning.message, /上游 PKG-1/);
  });

  it('refuses when policy.reviewRequires names a kind the parent has not passed, in Chinese', () => {
    const code = quest({ id: 'PKG-1', status: 'done' });
    const review = quest({ id: 'REVIEW-1', kind: 'review', parents: ['PKG-1'] });
    const envWithEvidence = { ...env, evidenceOf: (id) => (id === 'PKG-1' ? gapEvidence : null) };
    const strictPolicy = { ...policy, reviewRequires: ['project-verification'] };
    const verdict = canDispatch({ quest: review, adventurer: card('agy-gemini'), quests: [review, code], policy: strictPolicy, env: envWithEvidence });
    assert.equal(verdict.ok, false);
    const refusal = verdict.reasons.find((r) => r.code === 'upstream_unverified');
    assert.ok(refusal);
    assert.match(refusal.message, /[一-鿿]/u);
  });

  it('lets a matching recorded override through as a warning instead of a refusal', () => {
    const code = quest({ id: 'PKG-1', status: 'done' });
    const review = quest({
      id: 'REVIEW-1', kind: 'review', parents: ['PKG-1'],
      reviewOverride: { reason: '已经手工看过了', by: 'owner', at: '2026-09-14T01:00:00.000Z', parentAttempts: { 'PKG-1': 'a1' } },
    });
    const envWithEvidence = { ...env, evidenceOf: (id) => (id === 'PKG-1' ? gapEvidence : null) };
    const strictPolicy = { ...policy, reviewRequires: ['project-verification'] };
    const verdict = canDispatch({ quest: review, adventurer: card('agy-gemini'), quests: [review, code], policy: strictPolicy, env: envWithEvidence });
    assert.equal(verdict.ok, true);
    const warning = verdict.warnings.find((w) => w.code === 'upstream_unverified');
    assert.match(warning.message, /已经手工看过了/);
  });

  it('never lets an evidenceOf-less env (e.g. dispatcher.js) silently pass a required-and-failing check as ok — it stays quiet, not fabricated', () => {
    const code = quest({ id: 'PKG-1', status: 'done' });
    const review = quest({ id: 'REVIEW-1', kind: 'review', parents: ['PKG-1'] });
    const strictPolicy = { ...policy, reviewRequires: ['project-verification'] };
    const verdict = canDispatch({ quest: review, adventurer: card('agy-gemini'), quests: [review, code], policy: strictPolicy, env });
    assert.equal(verdict.ok, true, 'no evidenceOf means this check cannot run at all — a different gate must guard the real dispatch path');
    assert.ok(!(verdict.warnings || []).some((w) => w.code === 'upstream_unverified'));
  });
});
