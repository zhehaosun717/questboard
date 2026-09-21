import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { QuestStore, sameAttempt, validateAnnotationSnapshot } from '../../src/core/store.js';
import { appendJsonLine, readJsonLines } from '../../src/core/jsonl.js';
import { eventsAfter, readEvents } from '../../src/core/events.js';
import { canDispatch } from '../../src/core/rules.js';
import { makeProject, card } from '../helpers.js';

let project;
let store;
const events = () => readJsonLines(project.config.paths.events);
const collectorStatus = (id, status, options = {}) => store.setStatus(id, status, {
  ...options,
  source: 'collector',
  evidence: { kind: 'collector', attemptId: store.get(id)?.assignee?.attemptId },
});

beforeEach(() => {
  project = makeProject();
  store = new QuestStore(project.config);
});

describe('QuestStore', () => {
  it('posts with a title from the brief and emits posted', () => {
    const { quest } = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-the-way-back.md', conflicts: 'RUN-3', allowedLanes: 'codex,agy' });
    assert.equal(quest.title, 'the way back');
    assert.deepEqual(quest.conflicts, ['RUN-3']);
    assert.deepEqual(quest.allowedLanes, ['codex', 'agy']);
    assert.equal(events()[0].event, 'posted');
  });

  it('rejects bad fields, naming the project lanes and brief dirs', () => {
    const { errors } = store.post({ package: 'run4', brief: '../x.md', kind: 'poem', allowedLanes: 'ftp', priority: 9, parents: 'nope' });
    assert.ok(errors.package && errors.kind && errors.priority && errors.parents);
    assert.match(errors.allowedLanes, /this project defines codex, claude, agy, dsh, opencode/);
    assert.match(store.post({ package: 'RUN-4', brief: '../x.md' }).errors.brief, /docs\/briefs/);
  });

  it('rejects a malformed annotation snapshot reference with plain Chinese messages (F2)', () => {
    const good = {
      page: 'robot8',
      title: 'T',
      count: 1,
      capturedAt: '2026-09-16T12:00:00.000Z',
      digest: 'a'.repeat(64),
      path: '.questboard-data/dispatch-briefs/RUN-4/RUN-4-attempt-1.md',
    };
    assert.throws(() => validateAnnotationSnapshot(project.config, 'RUN-4', { ...good, page: 'NOT A PAGE' }), /批注快照的页面编号无效/);
    assert.throws(() => validateAnnotationSnapshot(project.config, 'RUN-4', { ...good, path: '../x.md' }), /批注快照路径必须在项目根目录之内/);
    assert.throws(() => validateAnnotationSnapshot(project.config, 'RUN-4', { ...good, path: '/abs/x.md' }), /批注快照路径必须是相对路径/);
    assert.throws(() => validateAnnotationSnapshot(project.config, 'RUN-4', { ...good, count: -1 }), /批注快照的批注数量必须是不小于 0 的整数/);
    assert.throws(() => validateAnnotationSnapshot(project.config, 'RUN-4', { ...good, digest: 'nope' }), /摘要必须是 SHA-256/);
    assert.throws(() => validateAnnotationSnapshot(project.config, 'RUN-4', { ...good, path: 'docs/other/x.md' }), /必须在这次委托的派遣简报目录之内/);
    assert.equal(validateAnnotationSnapshot(project.config, 'RUN-4', good).page, 'robot8');
  });

  it('refuses a new post naming a parent that is not on the board yet, self, or a cycle — before persisting', () => {
    const missing = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', parents: 'RUN-9' });
    assert.match(missing.errors.parents, /RUN-9 not found; post it first/);
    assert.equal(store.get('RUN-4'), null, 'an unusable task is never written');
    assert.match(store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', parents: 'RUN-4' }).errors.parents, /cannot be its own parent/);
    store.post({ package: 'RUN-3', brief: 'docs/briefs/RUN-3-x.md' });
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', parents: 'RUN-3' });
    assert.match(store.post({ package: 'RUN-3', brief: 'docs/briefs/RUN-3-x.md', parents: 'RUN-4' }).errors.parents, /cycle back to RUN-3/);
    // A real, already-posted parent is accepted.
    assert.deepEqual(store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md', parents: 'RUN-3' }).quest.parents, ['RUN-3']);
  });

  it('accepts dispatchable briefs only in dispatchDirs, owner briefs also in ownerDirs', () => {
    for (const brief of ['.env', 'docs/briefs/../../.env', 'docs/briefs/sub/x.md', 'docs/design/RUN-7.md']) {
      assert.ok(store.post({ package: 'RUN-7', brief }).errors.brief, brief);
    }
    assert.equal(store.post({ package: 'ARC-3', kind: 'owner', brief: 'docs/design/ARC-3.md' }).quest.brief, 'docs/design/ARC-3.md');
  });

  it('refuses a brief path that exists only as a dangling junction, already at POST (F4)', (t) => {
    const junctionPath = path.join(project.root, 'docs', 'briefs', 'RUN-31-x.md');
    const missingTarget = path.join(project.root, '..', `qb-post-missing-${path.basename(project.root)}`);
    fs.mkdirSync(path.dirname(junctionPath), { recursive: true });
    fs.rmSync(missingTarget, { recursive: true, force: true });
    try { fs.symlinkSync(missingTarget, junctionPath, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { t.skip('junction creation refused on this machine'); return; }
      throw error;
    }
    assert.equal(fs.existsSync(missingTarget), false, 'test setup: the junction target stays missing');
    const { errors } = store.post({ package: 'RUN-31', brief: 'docs/briefs/RUN-31-x.md' });
    assert.equal(errors.brief, '简报路径是一个指向不存在位置的联接点：docs/briefs/RUN-31-x.md');
    assert.equal(store.get('RUN-31'), null, 'a quest whose brief is a dangling link is never posted');
    assert.equal(events().length, 0, 'nothing is persisted for the refused post');
  });

  it('appendCheckResult records each round on the attempt and emits check_failed on a miss (FB2-05)', () => {
    const { config, write } = makeProject();
    write('docs/briefs/CR-1-x.md', '# CR-1');
    const store = new QuestStore(config);
    store.post({ package: 'CR-1', brief: 'docs/briefs/CR-1-x.md' });
    const assigned = store.assign('CR-1', { adventurer: card('codex-luna'), name: 'cr1' });
    const attempt = assigned.assignee;
    const events = () => readJsonLines(config.paths.events);
    const first = store.appendCheckResult('CR-1', attempt, { ok: false, exitCode: 1, summary: 'FAIL src/x.test.js' });
    assert.equal(first.assignee.checkResults.length, 1);
    assert.equal(first.assignee.checkResults[0].round, 1);
    assert.equal(first.assignee.checkResults[0].ok, false);
    assert.equal(first.assignee.checkResults[0].exitCode, 1);
    assert.equal(first.dispatches.at(-1).checkResults[0].summary, 'FAIL src/x.test.js');
    const failed = events().filter((e) => e.event === 'check_failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].detail, /FAIL src\/x\.test\.js/);
    const second = store.appendCheckResult('CR-1', attempt, { ok: true, exitCode: 0, summary: 'clean' });
    assert.equal(second.assignee.checkResults.length, 2);
    assert.equal(second.assignee.checkResults[1].round, 2);
    assert.equal(events().filter((e) => e.event === 'check_failed').length, 1, 'a pass emits nothing');
    assert.throws(() => store.appendCheckResult('CR-1', { ...attempt, attemptId: 'stale' }, { ok: true, exitCode: 0, summary: 'x' }), /已经不是当前记录/);
  });

  it('statusAt stamps when the status last changed and survives untouched saves (FB2-04)', () => {
    const { config, write } = makeProject();
    write('docs/briefs/ST-1-x.md', '# ST-1');
    const store = new QuestStore(config);
    const posted = store.post({ package: 'ST-1', brief: 'docs/briefs/ST-1-x.md' }).quest;
    assert.ok(posted.statusAt, 'a fresh post knows since when it is posted');
    assert.equal(posted.statusAt, posted.updatedAt);
    store.assign('ST-1', { adventurer: card('codex-luna'), name: 'st1' });
    const dispatched = store.get('ST-1');
    assert.equal(dispatched.status, 'dispatched');
    assert.ok(dispatched.statusAt > posted.statusAt || dispatched.statusAt === dispatched.updatedAt, 'status change re-stamps');
    assert.equal(dispatched.statusAt, dispatched.updatedAt);
    // a save that does not change the status keeps the stamp
    store.setStatus('ST-1', 'stalled', { detail: 'x', by: 'owner', ack: true });
    const stalled = store.get('ST-1');
    assert.equal(stalled.statusAt, stalled.updatedAt);
    const before = stalled.statusAt;
    store.rule('ST-1', { text: '问一下', by: 'owner' });
    assert.equal(store.get('ST-1').statusAt, before, 'an unrelated save keeps the stamp');
  });
  it('post --supersedes marks the old quest superseded, naming its replacement, in both directions (FB2-03)', () => {
    const { config, write } = makeProject();
    write('docs/briefs/ART-BLOCK-2-x.md', 'old');
    write('docs/briefs/ART-BLOCK-3-x.md', 'new');
    const store = new QuestStore(config);
    store.post({ package: 'ART-BLOCK-2', brief: 'docs/briefs/ART-BLOCK-2-x.md' });
    const result = store.post({ package: 'ART-BLOCK-3', brief: 'docs/briefs/ART-BLOCK-3-x.md', supersedes: 'ART-BLOCK-2' });
    assert.ok(!result.errors, JSON.stringify(result.errors));
    const old = store.get('ART-BLOCK-2');
    assert.equal(old.status, 'superseded');
    assert.equal(old.supersededBy, 'ART-BLOCK-3');
    assert.equal(old.lastDetail, '被 ART-BLOCK-3 取代');
    assert.deepEqual(store.get('ART-BLOCK-3').supersedes, ['ART-BLOCK-2']);
    const events = readEvents(config.paths.events);
    assert.ok(events.some((e) => e.event === 'status_superseded' && e.package === 'ART-BLOCK-2' && /被 ART-BLOCK-3 取代/.test(e.detail)));
    // and the supersession survives a restart replay
    const replayed = new QuestStore(config);
    assert.equal(replayed.get('ART-BLOCK-2').supersededBy, 'ART-BLOCK-3');
  });

  it('refuses supersedes that names nothing on the board, the quest itself, or a quest still held', () => {
    const { config, write } = makeProject();
    write('docs/briefs/ART-BLOCK-2-x.md', 'old');
    write('docs/briefs/ART-BLOCK-3-x.md', 'new');
    const store = new QuestStore(config);
    store.post({ package: 'ART-BLOCK-2', brief: 'docs/briefs/ART-BLOCK-2-x.md' });
    const ghost = store.post({ package: 'ART-BLOCK-3', brief: 'docs/briefs/ART-BLOCK-3-x.md', supersedes: 'NOPE-9' });
    assert.ok(ghost.errors.supersedes, 'unknown supersede target is refused');
    const self = store.post({ package: 'ART-BLOCK-3', brief: 'docs/briefs/ART-BLOCK-3-x.md', supersedes: 'ART-BLOCK-3' });
    assert.ok(self.errors.supersedes, 'self-supersede is refused');
    store.assign('ART-BLOCK-2', { adventurer: card('codex-luna'), name: 'ab2' });
    const held = store.post({ package: 'ART-BLOCK-3', brief: 'docs/briefs/ART-BLOCK-3-x.md', supersedes: 'ART-BLOCK-2' });
    assert.ok(held.errors.supersedes, 'a quest still held by a worker cannot be superseded');
  });

  it('stores hold, needs and an explicit files override from post (FB2-03)', () => {
    const { config, write } = makeProject();
    write('docs/briefs/CAP-1-x.md', '# CAP-1');
    const store = new QuestStore(config);
    const result = store.post({
      package: 'CAP-1', brief: 'docs/briefs/CAP-1-x.md',
      hold: '等设计稿', needs: ['runs-node', 'web'], files: ['src/a.js', 'src/b.js'],
    });
    assert.ok(!result.errors, JSON.stringify(result.errors));
    const quest = store.get('CAP-1');
    assert.equal(quest.hold, '等设计稿');
    assert.deepEqual(quest.needs, ['runs-node', 'web']);
    assert.deepEqual(quest.filesOverride, ['src/a.js', 'src/b.js']);
  });
  it('accepts needs_coordinator and owner_ruled as quest statuses, emits status_ events, and replays them after a restart (FB2-02)', () => {
    const { config, write } = makeProject();
    write('docs/briefs/NC-1-x.md', 'NC-1');
    const store = new QuestStore(config);
    store.post({ package: 'NC-1', brief: 'docs/briefs/NC-1-x.md' });
    const held = store.setStatus('NC-1', 'needs_coordinator', { detail: '批注里点名要 coordinator', by: 'owner' });
    assert.equal(held.status, 'needs_coordinator');
    const ruled = store.setStatus('NC-1', 'owner_ruled', { detail: '通过 2 / 不行 0 / 需要修改 1', by: 'owner' });
    assert.equal(ruled.status, 'owner_ruled');
    const events = readEvents(config.paths.events);
    assert.ok(events.some((e) => e.event === 'status_needs_coordinator'), JSON.stringify(events.map((e) => e.event)));
    assert.ok(events.some((e) => e.event === 'status_owner_ruled'));
    const replayed = new QuestStore(config);
    assert.equal(replayed.get('NC-1').status, 'owner_ruled', 'the new statuses survive a restart replay');
  });
  it('holds a quest for a ruling and releases it on the ruling', () => {
    const { quest } = store.post({ package: 'ARC-3', brief: 'docs/briefs/ARC-3-x.md', needsOwner: '三个点选哪个' });
    assert.equal(quest.status, 'needs_owner');
    const ruled = store.rule('ARC-3', { text: '选第二个' });
    assert.equal(ruled.status, 'posted');
    assert.equal(ruled.rulings[0].question, '三个点选哪个');
    assert.equal(quest.status, 'needs_owner', 'earlier snapshot is not mutated');
  });

  // Suggestion S3: recordReviewOverride never marks any evidence as passed — it only records why a review
  // whose upstream check refuses is being dispatched anyway, bound to the parents' attempt ids the caller
  // (src/server/questRoutes.js) computed from live evidence at the moment it was recorded.
  it('records a review override with a review_override event, and refuses on a non-review quest or an empty reason', () => {
    store.post({ package: 'RUN-9', brief: 'docs/briefs/RUN-9-x.md' });
    store.post({ package: 'REVIEW-9', kind: 'review', brief: 'docs/briefs/REVIEW-9-x.md', parents: ['RUN-9'] });
    const next = store.recordReviewOverride('REVIEW-9', { reason: ' 手工确认过 ', by: 'owner', parentAttempts: { 'RUN-9': 'a1' } });
    assert.deepEqual(next.reviewOverride, { reason: '手工确认过', by: 'owner', at: next.reviewOverride.at, parentAttempts: { 'RUN-9': 'a1' } });
    assert.equal(events().at(-1).event, 'review_override');
    assert.equal(events().at(-1).detail, '手工确认过');

    assert.throws(() => store.recordReviewOverride('RUN-9', { reason: 'x', parentAttempts: {} }), /不是审核委托/);
    assert.throws(() => store.recordReviewOverride('REVIEW-9', { reason: '   ', parentAttempts: {} }), /例外原因不能为空/);
    assert.equal(store.recordReviewOverride('NOPE-1', { reason: 'x' }), null);
  });

  it('assigns with an assigned event, adopts with dispatched, and refuses a re-post while running', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    const running = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.equal(running.assignee.family, 'gpt-5.6-luna');
    assert.equal(events().at(-1).event, 'assigned');
    assert.ok(store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' }).errors.package);
    store.post({ package: 'RUN-3', brief: 'docs/briefs/RUN-3-x.md' });
    const adopted = store.assign('RUN-3', { adventurer: card('codex-luna'), name: 'run3', event: 'dispatched', adopted: true });
    assert.equal(adopted.assignee.adopted, true);
    assert.equal(events().at(-1).event, 'dispatched');
  });

  it('numbers events and bumps the revision on every change, continuing after a restart', () => {
    const { quest } = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    assert.equal(quest.revision, 1);
    const running = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4', requestKey: 'k1' });
    assert.equal(running.revision, 2);
    assert.equal(running.assignee.requestKey, 'k1');
    assert.equal(collectorStatus('RUN-4', 'delivered').revision, 3);
    assert.deepEqual(events().map((e) => e.seq), [1, 2, 3]);
    const reopened = new QuestStore(project.config);
    assert.equal(reopened.get('RUN-4').revision, 3);
    reopened.setStatus('RUN-4', 'done', { source: 'collector', evidence: { kind: 'collector', attemptId: reopened.get('RUN-4').assignee?.attemptId } });
    assert.equal(events().at(-1).seq, 4);
  });

  it('numbers legacy event lines by position so cursors stay lossless', () => {
    fs.mkdirSync(path.dirname(project.config.paths.events), { recursive: true });
    fs.writeFileSync(project.config.paths.events, '{"at":"2026-09-01T00:00:00Z","event":"posted","package":"OLD-1"}\n{"at":"2026-09-01T00:00:01Z","event":"done","package":"OLD-1"}\n');
    const fresh = new QuestStore(project.config);
    fresh.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    assert.deepEqual(readEvents(project.config.paths.events).map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(eventsAfter(project.config.paths.events, { after: 2 }).map((e) => e.package), ['RUN-4']);
    assert.deepEqual(eventsAfter(project.config.paths.events, { after: 0, limit: 1, pkg: 'OLD-1' }).map((e) => e.event), ['posted']);
  });

  it('keeps the worker through a stall and frees it only on release', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.throws(() => store.release('RUN-4', {}), /running/);
    assert.equal(store.setStatus('RUN-4', 'stalled', { detail: 'no output' }).assignee.name, 'run4');
    const freed = store.release('RUN-4', { by: 'owner', detail: 'process gone', source: 'ui', ack: true });
    assert.deepEqual([freed.assignee, freed.status], [null, 'stalled']);
    assert.deepEqual([events().at(-1).event, events().at(-1).name, events().at(-1).detail], ['released', 'run4', 'process gone']);
    assert.throws(() => store.release('RUN-4', {}), /no worker/);
    assert.equal(store.setStatus('RUN-4', 'failed', { detail: 'exit 3' }).assignee, null, 'an exit still clears the worker');
  });

  it('names the internal limit cancellation source in invalid-source failures', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.throws(() => store.requestCancellation('RUN-4', { source: 'other', reason: 'stop' }), /取消来源只能是 ui、cli、mcp 或 limit/);
  });

  it('keeps the assignee in the event when a status clears it, and replays after restart', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.equal(collectorStatus('RUN-4', 'failed', { detail: 'exit 3' }).assignee, null);
    assert.equal(events().at(-1).model, 'gpt-5.6-luna');
    assert.throws(() => store.setStatus('RUN-4', 'exploded'));
    assert.equal(new QuestStore(project.config).get('RUN-4').status, 'failed');
  });

  it('mints a fresh attemptId on every assign/adopt, distinct even for a same-named re-adopt', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    const first = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.equal(typeof first.assignee.attemptId, 'string');
    assert.ok(first.assignee.attemptId.length > 0);
    assert.equal(events().at(-1).attemptId, first.assignee.attemptId, 'the event carries the same attempt identity');
    assert.equal(first.dispatches.at(-1).attemptId, first.assignee.attemptId, 'and so does the dispatch history');
    // A same-named re-adopt (the worker restarted under the same name) still gets its own identity.
    const readopted = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4', event: 'dispatched', adopted: true });
    assert.notEqual(readopted.assignee.attemptId, first.assignee.attemptId);
  });

  it('assign() starts an attempt at phase "queued"; adopt() starts one at "launching" since it is already running by hand', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    const assigned = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.equal(assigned.assignee.phase, 'queued');
    const adopted = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4', event: 'dispatched', adopted: true });
    assert.equal(adopted.assignee.phase, 'launching', 'an adopted worker was never queued by this board at all');
  });

  it('recordPhase durably persists phase/session onto the current attempt, and refuses once a different attempt is current', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    const assigned = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    const attempt = { attemptId: assigned.assignee.attemptId, name: 'run4', lane: 'codex', at: assigned.assignee.at };
    const withPhase = store.recordPhase('RUN-4', attempt, { phase: 'launching' });
    assert.equal(withPhase.assignee.phase, 'launching');
    const withSession = store.recordPhase('RUN-4', attempt, { session: { id: 'ses_1', saveTo: 'x', unknown: false } });
    assert.equal(withSession.assignee.phase, 'launching', 'setting session alone does not clobber the already-recorded phase');
    assert.deepEqual(withSession.assignee.session, { id: 'ses_1', saveTo: 'x', unknown: false });
    // Durable, not just in-memory: a fresh store reading the same quests.jsonl from scratch sees it too.
    assert.deepEqual(new QuestStore(project.config).get('RUN-4').assignee, withSession.assignee);
    // Once a new attempt replaces this one, the old attempt's phase can no longer be written — the caller
    // (executePlan via dispatcher.js) must treat this refusal exactly like a real persistence failure and
    // not spawn the step it would have announced.
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4_2' });
    assert.throws(() => store.recordPhase('RUN-4', attempt, { phase: 'launching' }), /不是当前记录/);
  });

  it('does not re-emit a repeated terminal transition, but keeps a differing repeat as a note, and a new attempt delivers independently', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    const first = collectorStatus('RUN-4', 'delivered', { detail: 'report A' });
    const countAfterFirst = events().length;
    const exactRepeat = collectorStatus('RUN-4', 'delivered', { detail: 'report A' });
    assert.equal(events().length, countAfterFirst, 'an identical repeat is a full no-op, not a second event');
    assert.equal(exactRepeat.revision, first.revision);

    const noted = collectorStatus('RUN-4', 'delivered', { detail: 'a later duplicate poll saw slightly different text' });
    assert.equal(events().at(-1).event, 'status_note', 'new information from a repeat is kept, but not as a second delivered');
    assert.equal(noted.lastDetail, 'report A', 'the first terminal evidence is preserved untouched');
    assert.equal(events().filter((e) => e.event === 'delivered').length, 1, 'still only one delivered event so far');

    // A genuinely new attempt (a fresh assign) delivers its own, independent event once it completes.
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4_2' });
    collectorStatus('RUN-4', 'delivered', { detail: 'report B' });
    assert.equal(events().filter((e) => e.event === 'delivered').length, 2, 'the second attempt emits its own delivered, independently');
  });

  it('F5: restoring delivered after it moved on (delivered -> failed -> delivered) stamps restoredAt without moving the original at, and fires no new event', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    const delivered = collectorStatus('RUN-4', 'delivered', { detail: 'ok first' });
    const firstDeliveredAt = delivered.terminalFact.statuses.delivered.at;
    assert.equal(delivered.terminalFact.statuses.delivered.restoredAt, undefined, 'a first delivery carries no restoredAt yet');

    collectorStatus('RUN-4', 'failed', { detail: 'crashed after delivery' });
    const countAfterFailed = events().length;

    const restored = collectorStatus('RUN-4', 'delivered', { detail: 'redelivered ok' });
    assert.equal(restored.status, 'delivered', 'the status moves back to delivered');
    assert.equal(restored.terminalFact.statuses.delivered.at, firstDeliveredAt, 'the original at is never rewritten');
    assert.ok(restored.terminalFact.statuses.delivered.restoredAt, 'the later delivery is stamped as restoredAt');
    assert.notEqual(restored.terminalFact.statuses.delivered.restoredAt, firstDeliveredAt, 'restoredAt records the later time, not the first one');
    // failed evidence is untouched by the restore.
    assert.equal(restored.terminalFact.statuses.failed.detail, 'crashed after delivery');

    assert.equal(events().length, countAfterFailed + 1, 'the restore appends exactly one event');
    assert.equal(events().at(-1).event, 'status_note', 'no second delivered event is fired for the restore');
    assert.equal(events().filter((e) => e.event === 'delivered').length, 1, 'still only the one original delivered event');

    // Durable: a fresh store reading the same quests.jsonl sees the same restoredAt stamp.
    const reloaded = new QuestStore(project.config);
    assert.deepEqual(reloaded.get('RUN-4').terminalFact.statuses.delivered, restored.terminalFact.statuses.delivered);
  });

  it('N3 ruling (round 6): restoring failed (delivered -> failed -> delivered -> failed) never stamps restoredAt on the failed entry', () => {
    // The failureContext N3 ruling relies on the store keeping this minimal: only a restored 'delivered'
    // ever gets a restoredAt stamp, so a repeated failure of the same attempt has no later time to read
    // off the fact, and questEvidence must fall back to the current status instead.
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    collectorStatus('RUN-4', 'delivered', { detail: 'ok first' });
    collectorStatus('RUN-4', 'failed', { detail: 'crashed' });
    collectorStatus('RUN-4', 'delivered', { detail: 'redelivered ok' });
    const refailed = collectorStatus('RUN-4', 'failed', { detail: 'crashed again' });
    assert.equal(refailed.status, 'failed');
    assert.equal(refailed.terminalFact.statuses.failed.restoredAt, undefined, 'a failed/bounced restore is never stamped with restoredAt');
    assert.equal(refailed.terminalFact.statuses.failed.detail, 'crashed', 'the fact keeps the first failed evidence; new text is a status_note, not a rewrite');
  });

  it('applies the same dedup to a repeated failed/bounced, each independently of the others', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    collectorStatus('RUN-4', 'failed', { detail: 'exit 3' });
    const before = events().length;
    store.setStatus('RUN-4', 'failed', { detail: 'exit 3' });
    assert.equal(events().length, before, 'an identical repeated failed is a no-op');
    assert.equal(events().filter((e) => e.event === 'failed').length, 1);
  });

  it('keeps a stalled-and-owned attempt through a re-post that also raises a question', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    store.setStatus('RUN-4', 'stalled', { detail: 'no output' });
    const reposted = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', needsOwner: '要不要换个模型' }).quest;
    assert.equal(reposted.status, 'stalled', 'a stalled-but-owned attempt keeps holding its slot through a re-post');
    assert.equal(reposted.assignee.name, 'run4', 'its worker is not silently dropped');
    assert.equal(reposted.needsOwner, '要不要换个模型', 'the question is still recorded for the owner to see');
  });

  it('keeps a legacy assignee (no attemptId) readable on replay, without inventing one', () => {
    const legacyAssignee = { adventurerId: 'codex-luna', lane: 'codex', model: 'gpt-5.6-luna', variant: 'high', name: 'old2', at: '2026-09-01T00:00:00.000Z', by: 'owner' };
    appendJsonLine(path.join(project.config.paths.data, 'quests.jsonl'), {
      id: 'OLD-2', status: 'dispatched', dispatches: [legacyAssignee], rulings: [], createdAt: legacyAssignee.at, updatedAt: legacyAssignee.at, revision: 1, assignee: legacyAssignee,
    });
    const replayed = new QuestStore(project.config);
    assert.equal(replayed.get('OLD-2').assignee.attemptId, undefined, 'replay must not fabricate an attemptId for a row that never had one');
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2', at: legacyAssignee.at }), true, 'name+at is the conservative fallback identity');
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2', at: '2026-09-02T00:00:00.000Z' }), false, 'a different at is a different attempt even with no attemptId to compare');
    assert.equal(sameAttempt(legacyAssignee, { name: 'different', at: legacyAssignee.at }), false, 'adopted or not, a different name is never the same attempt');
  });

  it('compares lane too in the legacy name+at fallback, when both sides carry one', () => {
    const legacyAssignee = { adventurerId: 'codex-luna', lane: 'codex', name: 'old2', at: '2026-09-01T00:00:00.000Z' };
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2', lane: 'codex', at: legacyAssignee.at }), true, 'matching lane, name and at is still the same attempt');
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2', lane: 'agy', at: legacyAssignee.at }), false, 'a different lane is never the same attempt, even with the same name and at');
    // Neither side (or only one) supplying a lane falls back to the original name+at comparison — the
    // stricter check only ever narrows identity, it never invents a mismatch from data that isn't there.
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2', at: legacyAssignee.at }), true, 'no lane supplied on the other side does not manufacture a mismatch');
    assert.equal(sameAttempt({ name: 'old2', at: legacyAssignee.at }, { name: 'old2', lane: 'agy', at: legacyAssignee.at }), true, 'no lane on this side either does not manufacture a mismatch');
    // attemptId, when both sides have one, still wins outright — lane is only consulted in the fallback.
    assert.equal(sameAttempt({ ...legacyAssignee, lane: 'agy', attemptId: 'a1' }, { name: 'old2', lane: 'codex', at: legacyAssignee.at, attemptId: 'a1' }), true, 'a matching attemptId is identity regardless of lane');
  });

  it('never treats a bare name match as proof of identity when either side has no `at` to compare — too weak to gate a mutation', () => {
    const legacyAssignee = { adventurerId: 'codex-luna', lane: 'codex', name: 'old2', at: '2026-09-01T00:00:00.000Z' };
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2' }), false, 'the other side never recorded an `at` at all — name alone is not enough');
    assert.equal(sameAttempt({ name: 'old2' }, { name: 'old2', at: legacyAssignee.at }), false, 'same, with the missing `at` on this side instead');
    assert.equal(sameAttempt({ name: 'old2' }, { name: 'old2' }), false, 'neither side has one');
  });

  it('writes to disk before touching in-memory state, so a failed save leaves memory exactly where disk still is', () => {
    store.post({ package: 'RUN-9', brief: 'docs/briefs/RUN-9-x.md' });
    store.assign('RUN-9', { adventurer: card('codex-luna'), name: 'run9' });
    const before = store.get('RUN-9');
    const questsPath = path.join(project.config.paths.data, 'quests.jsonl');
    const backup = fs.readFileSync(questsPath);
    fs.rmSync(questsPath);
    fs.mkdirSync(questsPath); // appendJsonLine now throws EISDIR on the write-ahead
    assert.throws(() => collectorStatus('RUN-9', 'failed', { detail: 'boom' }), /EISDIR/);
    assert.deepEqual(store.get('RUN-9'), before, 'in-memory state must not have moved ahead of what was actually persisted');
    fs.rmdirSync(questsPath);
    fs.writeFileSync(questsPath, backup);
    // A fresh reload from disk agrees with the untouched in-memory state — nothing was silently lost either.
    assert.deepEqual(new QuestStore(project.config).get('RUN-9'), before);
  });

  describe('acceptance (feedback 15)', () => {
    it('stores a validated acceptance additively on done, and never on any other status', () => {
      store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
      store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
      collectorStatus('RUN-4', 'delivered');
      const acceptance = { actor: 'owner', evidenceRefs: [{ kind: 'report', ref: 'x', digest: 'd1', attemptId: 'a1' }], note: '看过了' };
      const done = store.setStatus('RUN-4', 'done', { detail: 'owner 验收：看过了', by: 'ui', acceptance });
      assert.deepEqual(done.acceptance, acceptance);
      // A stall carrying the same shaped object must not pick it up — only done ever stores it.
      store.post({ package: 'RUN-9', brief: 'docs/briefs/RUN-9-not-posted.md' });
      store.assign('RUN-9', { adventurer: card('codex-luna'), name: 'run9' });
      const stalled = store.setStatus('RUN-9', 'stalled', { detail: 'no output', acceptance });
      assert.equal(stalled.acceptance, undefined);
    });

    it('refuses a malformed acceptance without touching the quest', () => {
      store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
      store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
      collectorStatus('RUN-4', 'delivered');
      assert.throws(() => store.setStatus('RUN-4', 'done', { acceptance: { actor: 'nobody' } }), /owner 或 coordinator/);
      assert.equal(store.get('RUN-4').status, 'delivered', 'a refused acceptance must not still move the quest to done');
    });

    it('leaves a legacy done quest with no acceptance field untouched', () => {
      store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
      store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
      collectorStatus('RUN-4', 'delivered');
      const legacy = store.setStatus('RUN-4', 'done', { detail: 'owner 验收' });
      assert.equal('acceptance' in legacy, false);
    });

    it('never transitions to done by itself: a delivered quest with a PASS report stays delivered until setStatus(done) is called', () => {
      const { quest } = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
      assert.equal(quest.status, 'posted');
      store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
      const report = { source: 'delivery', ref: '.work/oc/run4.md', digest: 'd1', capturedAt: new Date().toISOString(), attemptId: store.get('RUN-4').assignee.attemptId, verdict: { verdict: 'PASS' } };
      const delivered = collectorStatus('RUN-4', 'delivered', { report });
      assert.equal(delivered.status, 'delivered');
      assert.equal(store.get('RUN-4').status, 'delivered', 'a PASS report alone never advances the quest to done');
    });
  });

  describe('updateMetadata', () => {
    it('corrects only the fields passed, bumps the revision, and records the actor and changed fields on metadata_update', () => {
      const { quest } = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', title: 'old title' });
      const { quest: updated } = store.updateMetadata('RUN-4', { title: 'new title' }, { by: 'owner' });
      assert.equal(updated.title, 'new title');
      assert.equal(updated.revision, quest.revision + 1);
      const last = events().at(-1);
      assert.equal(last.event, 'metadata_update');
      assert.equal(last.by, 'owner');
      assert.deepEqual(last.changedFields, ['title']);
      assert.deepEqual(last.changes, { title: { from: 'old title', to: 'new title' } });
      assert.equal(new QuestStore(project.config).get('RUN-4').title, 'new title', 'durable across a restart');
    });

    it('is a no-op — no event, no revision bump — when nothing actually changes', () => {
      const { quest } = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', title: 'same' });
      const before = events().length;
      const { quest: result } = store.updateMetadata('RUN-4', { title: 'same' }, { by: 'owner' });
      assert.equal(result.revision, quest.revision);
      assert.equal(events().length, before);
    });

    it('leaves the revision and events unchanged when the candidate is invalid', () => {
      store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
      const before = store.get('RUN-4');
      const beforeEvents = events().length;
      const { errors } = store.updateMetadata('RUN-4', { parents: 'RUN-9' }, { by: 'owner' });
      assert.match(errors.parents, /RUN-9 not found/);
      assert.deepEqual(store.get('RUN-4'), before);
      assert.equal(events().length, beforeEvents);
    });

    it('refuses outright while the quest holds a worker\'s slot, without touching it', () => {
      store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
      store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
      const before = store.get('RUN-4');
      assert.throws(() => store.updateMetadata('RUN-4', { title: 'new' }), /先释放再改/);
      try { store.updateMetadata('RUN-4', { title: 'new' }); } catch (error) { assert.equal(error.code, 'holds_slot'); }
      assert.deepEqual(store.get('RUN-4'), before);
      store.setStatus('RUN-4', 'stalled', { detail: 'no output' });
      assert.throws(() => store.updateMetadata('RUN-4', { title: 'new' }), /先释放再改/, 'a stalled quest still holding its assignee is also refused');
    });

    it('refuses a stale ifRevision with the current revision, and accepts a matching one', () => {
      const { quest } = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
      try {
        store.updateMetadata('RUN-4', { title: 'new' }, { ifRevision: quest.revision + 1 });
        assert.fail('expected a stale_revision throw');
      } catch (error) {
        assert.equal(error.code, 'stale_revision');
        assert.equal(error.revision, quest.revision);
      }
      const updated = store.updateMetadata('RUN-4', { title: 'new' }, { ifRevision: quest.revision }).quest;
      assert.equal(updated.title, 'new');
    });

    it('rejects a missing/self/cyclic parent the same as post, before persisting', () => {
      store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
      store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md' });
      assert.match(store.updateMetadata('RUN-4', { parents: 'RUN-9' }).errors.parents, /RUN-9 not found/);
      assert.match(store.updateMetadata('RUN-4', { parents: 'RUN-4' }).errors.parents, /cannot be its own parent/);
      store.updateMetadata('RUN-5', { parents: 'RUN-4' });
      assert.match(store.updateMetadata('RUN-4', { parents: 'RUN-5' }).errors.parents, /cycle back to RUN-4/);
    });

    it('returns null for a quest that does not exist', () => {
      assert.equal(store.updateMetadata('NOPE-1', { title: 'x' }), null);
    });

    it('repairs a legacy quest\'s missing parent while an unrelated field edit leaves it exactly as broken as before', () => {
      const legacyAssignee = null;
      appendJsonLine(path.join(project.config.paths.data, 'quests.jsonl'), {
        id: 'FIX-1', kind: 'code', status: 'posted', brief: 'docs/briefs/FIX-1-x.md', title: 'old',
        parents: ['GHOST-1'], conflicts: [], allowedLanes: [], needsOwner: '', assignee: legacyAssignee, dispatches: [],
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', revision: 1,
      });
      const reopened = new QuestStore(project.config);
      assert.equal(reopened.get('FIX-1').parents[0], 'GHOST-1', 'legacy broken quest is still readable');
      const untouched = reopened.updateMetadata('FIX-1', { title: 'new title' }, { by: 'owner' });
      assert.equal(untouched.quest.title, 'new title');
      assert.deepEqual(untouched.quest.parents, ['GHOST-1'], 'a field this edit never mentioned is not silently re-validated or dropped');
      reopened.post({ package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' });
      const repaired = reopened.updateMetadata('FIX-1', { parents: 'RUN-1' }, { by: 'owner' });
      assert.deepEqual(repaired.quest.parents, ['RUN-1'], 'the owner can explicitly repair the parent once a real one exists');
    });

    it('an explicit conflict removal frees only that declared block; a real file overlap still refuses dispatch', () => {
      const a = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', conflicts: 'RUN-5' }).quest;
      store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md' });
      store.assign('RUN-5', { adventurer: card('agy-gemini'), name: 'run5' });
      const luna = card('codex-luna');
      const withFiles = (quest, files) => ({ ...quest, files });
      const running5 = withFiles(store.get('RUN-5'), ['shared.js']);
      const declared = canDispatch({ quest: withFiles(a, ['shared.js']), adventurer: luna, quests: [withFiles(a, ['shared.js']), running5], policy: {}, env: {} });
      assert.ok(declared.reasons.some((r) => r.code === 'conflict_running' && r.message.includes('被标成不能同时做')), 'the declared conflict is refused as declared');
      const cleared = store.updateMetadata('RUN-4', { conflicts: '' }, { by: 'owner' }).quest;
      assert.deepEqual(cleared.conflicts, []);
      const stillOverlap = canDispatch({ quest: withFiles(cleared, ['shared.js']), adventurer: luna, quests: [withFiles(cleared, ['shared.js']), running5], policy: {}, env: {} });
      assert.ok(stillOverlap.reasons.some((r) => r.code === 'conflict_running' && r.message.includes('正在改同一批文件')), 'unrelated file overlap does not disappear just because the explicit conflict was cleared');
    });

    it('rejects a privileged or unknown field with a per-field error, and leaves the quest exactly as it was', () => {
      store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
      store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
      collectorStatus('RUN-4', 'delivered', { detail: 'd' });
      const before = store.get('RUN-4');
      const beforeEvents = events().length;
      const r = store.updateMetadata('RUN-4', {
        title: 'ok', status: 'done', kind: 'owner', priority: 1, assignee: null, dispatches: [],
        revision: 999, id: 'HACKED-1', reviewPage: 'x', bogusField: 'y',
      }, { by: 'owner' });
      assert.match(r.errors.status, /unknown field/);
      assert.match(r.errors.kind, /unknown field/);
      assert.match(r.errors.bogusField, /unknown field/);
      assert.deepEqual(store.get('RUN-4'), before, 'a candidate with any unknown field is refused whole, nothing is applied — not even the valid title');
      assert.equal(events().length, beforeEvents);
    });
  });

  describe('review ancestry protection', () => {
    // The exact chain rules.js's reviewer_coded_parent exists to stop: RUN-4's author must never end up able
    // to review RUN-4's own review. Every leg of the bypass a coordinator could try is checked before and
    // after — updateMetadata, the re-post upsert, and the two-step kind-switch that empties METADATA_FIELDS'
    // own protection by leaving kind through code and coming back.
    function setup() {
      store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
      store.post({ package: 'RUN-6', brief: 'docs/briefs/RUN-6-x.md' });
      const luna = card('codex-luna');
      store.assign('RUN-4', { adventurer: luna, name: 'w' });
      collectorStatus('RUN-4', 'delivered', { detail: 'd' });
      store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md', kind: 'review', parents: ['RUN-4'] });
      return luna;
    }
    const mayReview = (luna) => canDispatch({ quest: store.get('RUN-5'), adventurer: luna, quests: store.list(), policy: {}, env: { laneIds: new Set(['codex', 'agy']) } });

    it('refuses to clear a review\'s parent through updateMetadata, before and after the attempt', () => {
      const luna = setup();
      assert.equal(mayReview(luna).ok, false, 'refused before any edit is attempted');
      const cleared = store.updateMetadata('RUN-5', { parents: '' }, { by: 'owner' });
      assert.match(cleared.errors.parents, /RUN-5 is a posted review/);
      assert.match(cleared.errors.parents, /new package id/, 'must say a new package id is needed, not a same-id repost');
      assert.match(cleared.errors.parents, /cancelling RUN-5 does not unlock RUN-5/, 'must say cancelling does not unlock, never an instruction to cancel first');
      assert.deepEqual(store.get('RUN-5').parents, ['RUN-4'], 'the parent is untouched');
      assert.equal(mayReview(luna).ok, false, 'still refused after the attempt');
      assert.ok(mayReview(luna).reasons.some((r) => r.code === 'reviewer_coded_parent'));
    });

    it('refuses to reparent a review onto a different quest through updateMetadata', () => {
      const luna = setup();
      const reparented = store.updateMetadata('RUN-5', { parents: 'RUN-6' }, { by: 'owner' });
      assert.match(reparented.errors.parents, /RUN-5 is a posted review/);
      assert.deepEqual(store.get('RUN-5').parents, ['RUN-4']);
      assert.equal(mayReview(luna).ok, false);
    });

    it('refuses the same clear/reparent through the re-post upsert path, not only through updateMetadata', () => {
      const luna = setup();
      const cleared = store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md', kind: 'review', parents: '' });
      assert.match(cleared.errors.parents, /RUN-5 is a posted review/);
      assert.deepEqual(store.get('RUN-5').parents, ['RUN-4']);
      const reparented = store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md', kind: 'review', parents: 'RUN-6' });
      assert.match(reparented.errors.parents, /RUN-5 is a posted review/);
      assert.equal(mayReview(luna).ok, false);
    });

    it('closes the multi-call bypass: re-posting a review as kind code, then removing parents, then reposting as review', () => {
      const luna = setup();
      const toCode = store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md', kind: 'code', parents: '' });
      assert.match(toCode.errors.kind, /RUN-5 is a posted review/, 'the kind change itself is refused, before parents are ever touched');
      assert.equal(store.get('RUN-5').kind, 'review');
      assert.deepEqual(store.get('RUN-5').parents, ['RUN-4']);
      // Even if kind had somehow moved, closing the loop the other direction is refused too: parents on an
      // existing review can never come back from a post that also claims kind: 'review'.
      const backToReview = store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md', kind: 'review', parents: '' });
      assert.match(backToReview.errors.parents, /RUN-5 is a posted review/);
      assert.equal(mayReview(luna).ok, false);
      assert.ok(mayReview(luna).reasons.some((r) => r.code === 'reviewer_coded_parent'));
    });

    it('allows resending the same parent as a true no-op, through both updateMetadata and re-post', () => {
      setup();
      const revision = store.get('RUN-5').revision;
      const same1 = store.updateMetadata('RUN-5', { parents: 'RUN-4' }, { by: 'owner' });
      assert.deepEqual(same1.quest.parents, ['RUN-4']);
      assert.equal(same1.quest.revision, revision, 'a true no-op never bumps the revision');
      const same2 = store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md', kind: 'review', parents: 'RUN-4' });
      assert.deepEqual(same2.quest.parents, ['RUN-4']);
    });

    it('keeps a legacy broken review readable and its other fields correctable, but still refuses to rewrite its target — even onto a real quest', () => {
      appendJsonLine(path.join(project.config.paths.data, 'quests.jsonl'), {
        id: 'REVIEW-1', kind: 'review', status: 'posted', brief: 'docs/briefs/REVIEW-1-x.md', title: 'legacy review',
        parents: ['GHOST-1'], conflicts: [], allowedLanes: [], needsOwner: '', assignee: null, dispatches: [],
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', revision: 1,
      });
      const reopened = new QuestStore(project.config);
      assert.deepEqual(reopened.get('REVIEW-1').parents, ['GHOST-1'], 'legacy broken review is still readable');
      const titled = reopened.updateMetadata('REVIEW-1', { title: 'renamed' }, { by: 'owner' });
      assert.equal(titled.quest.title, 'renamed');
      assert.deepEqual(titled.quest.parents, ['GHOST-1'], 'an unrelated field edit never touches the broken target');
      reopened.post({ package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' });
      const repair = reopened.updateMetadata('REVIEW-1', { parents: 'RUN-1' }, { by: 'owner' });
      assert.match(repair.errors.parents, /REVIEW-1 is a posted review/, 'not even a real, valid replacement is a silent rewrite — cancel and repost instead');
    });

    it('leaves ordinary, non-review parent repair working exactly as before', () => {
      appendJsonLine(path.join(project.config.paths.data, 'quests.jsonl'), {
        id: 'FIX-2', kind: 'code', status: 'posted', brief: 'docs/briefs/FIX-2-x.md', title: 'old',
        parents: ['GHOST-1'], conflicts: [], allowedLanes: [], needsOwner: '', assignee: null, dispatches: [],
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', revision: 1,
      });
      const reopened = new QuestStore(project.config);
      reopened.post({ package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' });
      assert.deepEqual(reopened.updateMetadata('FIX-2', { parents: 'RUN-1' }, { by: 'owner' }).quest.parents, ['RUN-1'], 'a code (non-review) quest\'s parent is still freely repairable');
    });

    it('closes the re-post bypass of holds_slot for identity fields while stalled, without blocking a needsOwner-only re-post', () => {
      store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', title: 'original' });
      store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md' });
      store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
      store.setStatus('RUN-4', 'stalled', { detail: 'silence' });
      const blocked = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', title: 'while stalled', parents: 'RUN-5', conflicts: 'RUN-5' });
      assert.ok(blocked.errors.title && blocked.errors.parents && blocked.errors.conflicts, 'every changed identity field is named');
      assert.match(blocked.errors.title, /先释放再改/);
      const untouched = store.get('RUN-4');
      assert.equal(untouched.title, 'original');
      assert.deepEqual(untouched.parents, []);
      assert.equal(untouched.status, 'stalled');
      assert.ok(untouched.assignee, 'ownership is not freed by the refused re-post');
      const allowed = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', needsOwner: 'switch model?' });
      assert.equal(allowed.quest.status, 'stalled', 'a needsOwner-only re-post still works exactly as before');
      assert.equal(allowed.quest.assignee.name, 'run4');
      assert.equal(allowed.quest.needsOwner, 'switch model?');
    });
  });
});
