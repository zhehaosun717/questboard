import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canDispatch, eligibility } from '../../src/core/rules.js';
import { card, quest } from '../helpers.js';

const policy = { bannedModelPatterns: ['gpt-5\\.5', '-fast(\\b|-)'], bannedAgents: ['Sisyphus'] };
const env = { treeLocked: false, briefExists: true, laneIds: new Set(['codex', 'agy', 'opencode', 'dsh']) };
const luna = card('codex-luna');
const check = (q, adventurer = luna, quests = [q], environment = env) => canDispatch({ quest: q, adventurer, quests, policy, env: environment });
const codes = (result) => result.reasons.map((r) => r.code);

describe('canDispatch', () => {
  it('allows an available card on an open quest', () => {
    assert.deepEqual(check(quest()), { ok: true, reasons: [] });
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

  it('enforces the parallel limit', () => {
    const running = quest({ id: 'LOOK-2F', status: 'dispatched', assignee: { adventurerId: 'codex-luna' } });
    assert.ok(codes(check(quest(), luna, [running, quest()])).includes('adventurer_busy'));
    assert.equal(check(quest(), card('codex-luna', { maxParallel: 2 }), [running, quest()]).ok, true);
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

  it('sends art only to cards that draw, and pauses on the lock or a missing brief', () => {
    assert.ok(codes(check(quest({ kind: 'art' }))).includes('needs_artist'));
    assert.equal(check(quest({ kind: 'art' }), card('codex-astra')).ok, true);
    assert.ok(codes(check(quest(), luna, [quest()], { ...env, treeLocked: true })).includes('tree_locked'));
    assert.ok(codes(check(quest(), luna, [quest()], { ...env, briefExists: false })).includes('brief_missing'));
  });

  it('gives every reason a Chinese message', () => {
    const q = quest({ status: 'dispatched', needsOwner: 'x', allowedLanes: ['agy'] });
    const result = check(q, card('codex-luna', { status: 'broke', model: 'gpt-5.5' }), [q], { ...env, treeLocked: true, briefExists: false });
    assert.ok(result.reasons.length >= 6);
    for (const r of result.reasons) assert.match(r.message, /[一-鿿]/u);
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
