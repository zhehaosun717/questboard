// Recent execution failure context (feedback 1, remaining clause). The projection is read-only history:
// an ordinary task failure must never pause a card, touch its owner-set status, or be inferred from a
// model string. These tests pin the exact-identity rules, the latest-attempt clearing policy and the
// bounded plain-text contract of the snapshot field.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { recentFailuresByCard, MAX_SUMMARY } from '../../src/core/failureContext.js';
import { buildSnapshot } from '../../src/core/snapshot.js';
import { makeProject, card } from '../helpers.js';
import { QuestStore } from '../../src/core/store.js';
import { appendJsonLine } from '../../src/core/jsonl.js';

const BASE = Date.parse('2026-09-16T00:00:00.000Z');
const at = (minutes) => new Date(BASE + minutes * 60_000).toISOString();
// Unambiguously earlier than any real now() the store stamps during a test run, for legacy fixtures
// appended directly to disk (never through the store's own dispatch/status calls).
const LEGACY_PAST = '2020-01-01T00:00:00.000Z';

// A raw legacy quest row written straight to quests.jsonl, the way a pre-terminal-fact project would have
// it on disk: no terminalFact at all, only status + dispatches + updatedAt for questEvidence to read.
function appendLegacyQuest(config, overrides = {}) {
  const record = {
    id: 'RUN-LEGACY', status: 'failed', dispatches: [], rulings: [], createdAt: LEGACY_PAST, updatedAt: LEGACY_PAST,
    revision: 1, assignee: null, title: '', brief: 'docs/briefs/RUN-4-fixture.md', kind: 'code',
    ...overrides,
  };
  appendJsonLine(path.join(config.paths.data, 'quests.jsonl'), record);
  return record;
}

// One attempt row as the store records it; `adventurerId` is the card id the attempt really ran on.
const row = (over = {}) => ({
  adventurerId: 'card-a', family: 'shared-model', lane: 'codex', model: 'shared-model', variant: 'high',
  name: 'mod1', at: at(0), by: 'owner', attemptId: 'att-1', phase: 'queued', ...over,
});

const failedFact = (over = {}) => ({
  attemptId: 'att-1', name: 'mod1', at: at(0), lane: 'codex',
  statuses: { failed: { at: at(5), detail: 'worker exited 1' } }, ...over,
});

// A quest whose default attempt ran on card-a; tests override status, fact or dispatch rows as needed.
const quest = (over = {}) => ({ id: 'RUN-1', status: 'failed', dispatches: [row()], updatedAt: at(10), lastDetail: '', ...over });

describe('recentFailuresByCard projection', () => {
  it('attributes a failure to the exact card on the attempt, never by model string', () => {
    // Two cards ran the same model through different lanes and variants; a third row with no card id
    // shares the model too. Only the two rows that name a card may produce context.
    const result = recentFailuresByCard([
      quest({ id: 'RUN-1', terminalFact: failedFact(), dispatches: [row({ adventurerId: 'card-a', lane: 'codex', variant: 'high' })] }),
      quest({ id: 'RUN-2', terminalFact: failedFact(), dispatches: [row({ adventurerId: 'card-b', lane: 'opencode', variant: 'max' })] }),
      quest({ id: 'RUN-3', terminalFact: failedFact(), dispatches: [row({ adventurerId: undefined })] }),
    ]);
    assert.deepEqual(Object.keys(result).sort(), ['card-a', 'card-b']);
    assert.equal(result['card-a'].questId, 'RUN-1');
    assert.equal(result['card-b'].questId, 'RUN-2');
    assert.equal(result['card-c'], undefined, 'a model string alone must never invent a card');
  });

  it('finds the attempt by attempt identity: a reassignment does not move an old failure', () => {
    // The fact belongs to the first attempt; the quest was later reassigned to card-b. Card-b must not
    // inherit the old failure, and "latest dispatch" is not used as a stand-in for identity.
    const result = recentFailuresByCard([
      quest({
        terminalFact: failedFact({ attemptId: 'att-old' }),
        dispatches: [
          row({ adventurerId: 'card-a', attemptId: 'att-old' }),
          row({ adventurerId: 'card-b', attemptId: 'att-new', at: at(20), variant: 'max' }),
        ],
      }),
    ]);
    assert.equal(result['card-a'].questId, 'RUN-1');
    assert.equal(result['card-b'], undefined, 'the reassigned card never wears the old attempt\'s failure');
  });

  it('leaves a quest with no provable card identity unassociated instead of guessing', () => {
    // A legacy attempt row without adventurerId, and a fact whose identity matches none of the rows.
    const noId = recentFailuresByCard([
      quest({ dispatches: [{ name: 'mod1', at: at(0), lane: 'codex', attemptId: 'att-1' }], terminalFact: failedFact() }),
    ]);
    assert.deepEqual(noId, {}, 'no card id anywhere means no context, not a guessed one');
    const noMatch = recentFailuresByCard([
      quest({ terminalFact: failedFact({ attemptId: 'att-gone', name: 'other' }), dispatches: [row({ adventurerId: 'card-a', attemptId: 'att-1' })] }),
    ]);
    assert.deepEqual(noMatch, {}, 'a fact that matches no attempt row stays unassociated');
  });

  it('blames no card when legacy rows are ambiguous across distinct candidate cards', () => {
    // Fact has no attemptId, dispatches have no attemptId, but two different cards match name/at/lane.
    const ambiguousFact = {
      name: 'mod1', at: at(0), lane: 'codex',
      statuses: { failed: { at: at(5), detail: 'ambiguous crash' } },
    };
    const ambiguousQuest = quest({
      terminalFact: ambiguousFact,
      dispatches: [
        { adventurerId: 'card-a', family: 'shared', lane: 'codex', model: 'shared', variant: 'high', name: 'mod1', at: at(0) },
        { adventurerId: 'card-b', family: 'shared', lane: 'codex', model: 'shared', variant: 'high', name: 'mod1', at: at(0) },
      ],
    });
    assert.deepEqual(recentFailuresByCard([ambiguousQuest]), {}, 'ambiguous legacy rows blame neither card');

    // Exactly one distinct card among matches is attributed correctly.
    const unambiguousQuest = quest({
      terminalFact: ambiguousFact,
      dispatches: [
        { adventurerId: 'card-a', family: 'shared', lane: 'codex', model: 'shared', variant: 'high', name: 'mod1', at: at(0) },
        { adventurerId: 'card-a', family: 'shared', lane: 'codex', model: 'shared', variant: 'high', name: 'mod1', at: at(0) },
      ],
    });
    assert.equal(recentFailuresByCard([unambiguousQuest])['card-a']?.questId, 'RUN-1');
  });

  it('clears an older failure when a later attempt on the same card delivered (latest-attempt policy)', () => {
    const older = quest({ id: 'RUN-1', terminalFact: failedFact(), dispatches: [row({ attemptId: 'att-1' })], updatedAt: at(5) });
    const delivered = quest({
      id: 'RUN-2', status: 'delivered', updatedAt: at(30),
      terminalFact: { attemptId: 'att-2', name: 'mod1', at: at(20), lane: 'codex', statuses: { delivered: { at: at(25), detail: 'ok' } } },
      dispatches: [row({ attemptId: 'att-2', at: at(20) })],
    });
    assert.deepEqual(recentFailuresByCard([older, delivered]), {}, 'the later delivery clears the card');
    // PM ruling (N3, round 6): the current status wins. This quest's status is still 'failed' (the
    // default from quest()), so even though the fact also carries a delivered entry timestamped later
    // than the failure, the card must show the failure, not the stale delivered fact. This assertion
    // used to expect {} (the delivered fact winning by timestamp alone); N3 replaced that policy.
    const both = quest({ terminalFact: failedFact({ statuses: { failed: { at: at(5), detail: 'flaky' }, delivered: { at: at(8), detail: 'ok' } } }) });
    assert.deepEqual(recentFailuresByCard([both]), { 'card-a': { questId: 'RUN-1', at: at(5), summary: 'flaky' } });
  });

  it('clears the failure note when the same attempt later ended delivered (delivered → failed → delivered)', () => {
    // Attempt delivered at at(5), failed at at(10), then re-delivered at at(15) (same attempt).
    const redelivered = quest({
      id: 'RUN-1',
      status: 'delivered',
      updatedAt: at(15),
      terminalFact: failedFact({
        statuses: {
          delivered: { at: at(5), detail: 'ok first' },
          failed: { at: at(10), detail: 'intermittent failure' },
        },
      }),
      dispatches: [row({ attemptId: 'att-1' })],
    });
    assert.deepEqual(recentFailuresByCard([redelivered]), {}, 're-delivered attempt clears the failure note');
  });

  it('clears the failure note when the quest was accepted (status done) after failure (failed → done)', () => {
    // Attempt failed at at(10), then quest was accepted done by owner at at(15).
    const accepted = quest({
      id: 'RUN-1',
      status: 'done',
      updatedAt: at(15),
      terminalFact: failedFact({
        statuses: { failed: { at: at(10), detail: 'worker crashed' } },
      }),
      dispatches: [row({ attemptId: 'att-1' })],
    });
    assert.deepEqual(recentFailuresByCard([accepted]), {}, 'accepted quest (done) clears the failure note');
  });

  it('does not clear when a failed quest is moved straight to reviewing without ever delivering (F2)', () => {
    // Attempt failed at at(10); the quest was then moved to reviewing at at(15) with no
    // delivered fact ever recorded for this attempt. That is neither a delivery nor acceptance.
    const reviewedWithoutDelivery = quest({
      id: 'RUN-1',
      status: 'reviewing',
      updatedAt: at(15),
      terminalFact: failedFact({
        statuses: { failed: { at: at(10), detail: 'worker crashed' } },
      }),
      dispatches: [row({ attemptId: 'att-1' })],
    });
    const result = recentFailuresByCard([reviewedWithoutDelivery]);
    assert.deepEqual(result['card-a'], {
      questId: 'RUN-1',
      at: at(10),
      summary: 'worker crashed',
    }, 'failed -> reviewing with no delivered fact must not clear the failure');
  });

  it('an accepted (done) quest with no delivered fact never masks another quest\'s newer failure', () => {
    // RUN-1 failed then was accepted done with no delivery ever recorded; RUN-2 is a genuinely
    // newer failure of the same card. The done acceptance must only hide its own quest's
    // failure, never invent card-wide "delivered" evidence that could outrank RUN-2.
    const acceptedNoDelivery = quest({
      id: 'RUN-1',
      status: 'done',
      updatedAt: at(15),
      terminalFact: failedFact({
        attemptId: 'att-1',
        statuses: { failed: { at: at(10), detail: 'worker crashed' } },
      }),
      dispatches: [row({ attemptId: 'att-1' })],
    });
    const newerFailure = quest({
      id: 'RUN-2',
      status: 'failed',
      updatedAt: at(20),
      terminalFact: failedFact({
        attemptId: 'att-2',
        statuses: { failed: { at: at(20), detail: 'attempt 2 failed' } },
      }),
      dispatches: [row({ attemptId: 'att-2', at: at(20) })],
    });
    const result = recentFailuresByCard([acceptedNoDelivery, newerFailure]);
    assert.deepEqual(result['card-a'], { questId: 'RUN-2', at: at(20), summary: 'attempt 2 failed' });
  });

  it('shows a failure again when a newer attempt on the card failed', () => {
    // Attempt 1 failed at at(5), delivered at at(10). Later attempt 2 failed at at(20).
    const rerun = quest({
      id: 'RUN-1',
      status: 'failed',
      updatedAt: at(20),
      terminalFact: failedFact({
        attemptId: 'att-2',
        statuses: { failed: { at: at(20), detail: 'attempt 2 failed' } },
      }),
      dispatches: [
        row({ attemptId: 'att-1', at: at(0) }),
        row({ attemptId: 'att-2', at: at(15) }),
      ],
    });
    const result = recentFailuresByCard([rerun]);
    assert.deepEqual(result['card-a'], {
      questId: 'RUN-1',
      at: at(20),
      summary: 'attempt 2 failed',
    });
  });

  it('does not clear failure on a mere ruling or status note', () => {
    // Attempt failed at at(10). At at(15), owner recorded a ruling; status stays failed.
    const ruled = quest({
      id: 'RUN-1',
      status: 'failed',
      updatedAt: at(15),
      rulings: [{ at: at(15), by: 'owner', text: 'wait for fix', question: '' }],
      terminalFact: failedFact({
        statuses: { failed: { at: at(10), detail: 'network down' } },
      }),
      dispatches: [row({ attemptId: 'att-1' })],
    });
    const result = recentFailuresByCard([ruled]);
    assert.deepEqual(result['card-a'], {
      questId: 'RUN-1',
      at: at(10),
      summary: 'network down',
    });
  });

  it('keeps the newest failure per card and prefers the failure on an exact tie', () => {
    const old = quest({ id: 'RUN-1', terminalFact: failedFact({ statuses: { failed: { at: at(5), detail: 'first' } } }) });
    const fresh = quest({ id: 'RUN-2', terminalFact: failedFact({ statuses: { failed: { at: at(15), detail: 'second' } } }) });
    const result = recentFailuresByCard([old, fresh]);
    assert.deepEqual(result['card-a'], { questId: 'RUN-2', at: at(15), summary: 'second' });
    const tieFail = quest({ id: 'RUN-3', terminalFact: failedFact({ statuses: { failed: { at: at(15), detail: 'fail' } } }) });
    const tieWin = quest({
      id: 'RUN-4', terminalFact: forceStatuses({ delivered: { at: at(15) } }),
    });
    assert.equal(recentFailuresByCard([tieFail, tieWin])['card-a'].questId, 'RUN-3', 'an exact tie keeps the failure');
  });

  it('uses the quest row only as a legacy fallback, and only when it names a card', () => {
    // N2: the legacy path is timed from the attempt (row()'s at(0)), never quest.updatedAt (at(30)).
    const legacy = quest({ id: 'RUN-1', status: 'failed', updatedAt: at(30), lastDetail: 'lane refused', dispatches: [row()] });
    assert.deepEqual(recentFailuresByCard([legacy]), { 'card-a': { questId: 'RUN-1', at: at(0), summary: 'lane refused' } });
    const withoutId = quest({ id: 'RUN-2', status: 'failed', dispatches: [{ name: 'mod1', at: at(0) }] });
    assert.deepEqual(recentFailuresByCard([withoutId]), {}, 'legacy rows without a card id stay unassociated');
    const posted = quest({ id: 'RUN-3', status: 'posted', dispatches: [row()] });
    assert.deepEqual(recentFailuresByCard([posted]), {});
    // A legacy delivered quest, dispatched later than the failure, is the clearing evidence for it.
    const delivered = quest({ id: 'RUN-4', status: 'delivered', updatedAt: at(40), dispatches: [row({ at: at(20) })] });
    assert.deepEqual(recentFailuresByCard([legacy, delivered]), {});
  });

  it('for legacy data with no terminal fact, the failure time comes from the attempt, never quest.updatedAt moved by a later ruling', () => {
    // Dispatched at at(10), failed; later at at(30) owner gave a ruling which moved updatedAt to at(30).
    const legacyRuled = quest({
      id: 'RUN-LEGACY',
      status: 'failed',
      updatedAt: at(30),
      lastDetail: 'legacy error',
      rulings: [{ at: at(30), by: 'owner', text: 'retry tomorrow' }],
      dispatches: [row({ adventurerId: 'card-a', at: at(10) })],
    });
    const result = recentFailuresByCard([legacyRuled]);
    assert.deepEqual(result['card-a'], {
      questId: 'RUN-LEGACY',
      at: at(10),
      summary: 'legacy error',
    }, 'the attempt\'s own dispatch time is used; the ruling at at(30) never comes into it');

    // A later delivered attempt on card-a at at(20) must outrank the legacy failure (dispatched at at(10)).
    const laterDelivery = quest({
      id: 'RUN-2',
      status: 'delivered',
      updatedAt: at(20),
      terminalFact: { attemptId: 'att-2', name: 'mod1', at: at(15), lane: 'codex', statuses: { delivered: { at: at(20), detail: 'ok' } } },
      dispatches: [row({ attemptId: 'att-2', at: at(15) })],
    });
    assert.deepEqual(recentFailuresByCard([legacyRuled, laterDelivery]), {}, 'delivery at at(20) clears the legacy failure dispatched at at(10)');
  });

  it('a legacy failure with no attempt time at all shows at: null (the web renders 时间未知)', () => {
    const { config } = makeProject();
    appendLegacyQuest(config, {
      id: 'RUN-LEGACY-NO-TIME', status: 'failed', updatedAt: LEGACY_PAST, createdAt: LEGACY_PAST,
      lastDetail: 'lane refused, no timestamp ever recorded',
      dispatches: [{ adventurerId: 'codex-luna', name: 'oldrun', lane: 'codex' }],
    });
    const store = new QuestStore(config);
    const failures = recentFailuresByCard(store.list());
    assert.deepEqual(failures['codex-luna'], {
      questId: 'RUN-LEGACY-NO-TIME',
      at: null,
      summary: 'lane refused, no timestamp ever recorded',
    }, 'no usable dispatch time leaves at null instead of inventing one');
  });

  it('N2a: a real store: a ruling on a legacy done quest never hides a newer fact-based failure of the same card', () => {
    const { config } = makeProject();
    appendLegacyQuest(config, {
      id: 'RUN-LEGACY-DONE', status: 'done', updatedAt: LEGACY_PAST, createdAt: LEGACY_PAST,
      dispatches: [{ adventurerId: 'codex-luna', name: 'oldrun', lane: 'codex', at: LEGACY_PAST }],
    });
    const store = new QuestStore(config);

    store.post({ package: 'RUN-20', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-20', { adventurer: card('codex-luna'), name: 'runNew' });
    const attemptId = store.get('RUN-20').assignee.attemptId;
    store.setStatus('RUN-20', 'failed', {
      detail: 'newer real failure', source: 'collector', evidence: { kind: 'collector', attemptId },
    });

    // A ruling on the legacy done quest bumps only its own updatedAt, long after RUN-20's failure.
    store.rule('RUN-LEGACY-DONE', { text: 'no action needed, legacy row already accepted' });

    const reloaded = new QuestStore(config);
    const failures = recentFailuresByCard(reloaded.list());
    assert.deepEqual(failures['codex-luna'], {
      questId: 'RUN-20',
      at: reloaded.get('RUN-20').terminalFact.statuses.failed.at,
      summary: 'newer real failure',
    }, 'the ruling on the legacy done quest must not hide the newer fact-based failure');
  });

  it('N2b: a real store: a ruling on a legacy failed quest never moves its own reported failure time off the attempt', () => {
    const { config } = makeProject();
    appendLegacyQuest(config, {
      id: 'RUN-LEGACY-FAILED', status: 'failed', updatedAt: LEGACY_PAST, createdAt: LEGACY_PAST,
      lastDetail: 'legacy lane refused',
      dispatches: [{ adventurerId: 'codex-luna', name: 'oldrun', lane: 'codex', at: LEGACY_PAST }],
    });
    const store = new QuestStore(config);
    const before = recentFailuresByCard(store.list())['codex-luna'];
    assert.equal(before.at, LEGACY_PAST, 'the failure is timed from the attempt to start with');

    store.rule('RUN-LEGACY-FAILED', { text: 'wait and retry' });

    const reloaded = new QuestStore(config);
    const after = recentFailuresByCard(reloaded.list())['codex-luna'];
    assert.deepEqual(after, before, 'the ruling must not change the reported failure time or summary at all');
  });

  it('the metadata-update variant of N2: a real store: a metadata save on a legacy done quest never hides a newer fact-based failure of the same card', () => {
    const { config } = makeProject();
    appendLegacyQuest(config, {
      id: 'RUN-LEGACY-DONE-2', status: 'done', updatedAt: LEGACY_PAST, createdAt: LEGACY_PAST,
      title: 'old title', brief: 'docs/briefs/RUN-4-fixture.md', kind: 'code',
      dispatches: [{ adventurerId: 'codex-luna', name: 'oldrun', lane: 'codex', at: LEGACY_PAST }],
    });
    const store = new QuestStore(config);

    store.post({ package: 'RUN-21', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-21', { adventurer: card('codex-luna'), name: 'runNew2' });
    const attemptId = store.get('RUN-21').assignee.attemptId;
    store.setStatus('RUN-21', 'failed', {
      detail: 'newer real failure 2', source: 'collector', evidence: { kind: 'collector', attemptId },
    });

    // A metadata save on the legacy done quest bumps only its own updatedAt, long after RUN-21's failure.
    const updated = store.updateMetadata('RUN-LEGACY-DONE-2', { title: 'renamed' });
    assert.equal(updated.quest.title, 'renamed');

    const reloaded = new QuestStore(config);
    const failures = recentFailuresByCard(reloaded.list());
    assert.deepEqual(failures['codex-luna'], {
      questId: 'RUN-21',
      at: reloaded.get('RUN-21').terminalFact.statuses.failed.at,
      summary: 'newer real failure 2',
    }, 'the metadata update on the legacy done quest must not hide the newer fact-based failure');
  });

  it('X2b: a real store: delivered -> failed -> delivered -> reviewing clears through the restored delivery', () => {
    const { config } = makeProject();
    const store = new QuestStore(config);
    store.post({ package: 'RUN-10', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-10', { adventurer: card('codex-luna'), name: 'run10' });
    const attemptId = store.get('RUN-10').assignee.attemptId;
    store.setStatus('RUN-10', 'delivered', {
      detail: 'first ok', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    store.setStatus('RUN-10', 'failed', {
      detail: 'crashed after delivery', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    const restored = store.setStatus('RUN-10', 'delivered', {
      detail: 'redelivered ok', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    assert.ok(restored.terminalFact.statuses.delivered.restoredAt, 'the restore stamps restoredAt on the delivered entry');
    store.setStatus('RUN-10', 'reviewing', { detail: '', by: 'collector' });

    const reloaded = new QuestStore(config);
    const failures = recentFailuresByCard(reloaded.list());
    assert.equal(failures['codex-luna'], undefined, 're-delivery of the same attempt clears the earlier failure even through reviewing');
  });

  it('bounds and flattens the summary text, and never needs a transport body', () => {
    const noisy = `line one\nline two\u0000\u0007\t tabbed ${'x'.repeat(300)}`;
    const result = recentFailuresByCard([
      quest({ terminalFact: failedFact({ statuses: { failed: { at: at(5), detail: noisy } } }) }),
    ]);
    const summary = result['card-a'].summary;
    assert.ok(summary.length <= MAX_SUMMARY, `summary bounded to ${MAX_SUMMARY} chars`);
    assert.equal(/[\u0000-\u001f\u007f]/.test(summary), false, 'no control characters survive');
    assert.equal(summary.includes('\n'), false);
    assert.equal(summary.startsWith('line one line two tabbed'), true, 'whitespace collapses to single spaces');
    // Executable-looking markup stays inert plain text; this module never renders or interprets it.
    const markup = recentFailuresByCard([
      quest({ terminalFact: failedFact({ statuses: { failed: { at: at(5), detail: '<script>alert(1)</script>' } } }) }),
    ]);
    assert.equal(markup['card-a'].summary, '<script>alert(1)</script>');
    const empty = recentFailuresByCard([
      quest({ terminalFact: failedFact({ statuses: { failed: { at: at(5) } } }) }),
    ]);
    assert.equal(empty['card-a'].summary, '', 'a missing detail is empty text, never invented');
  });

  it('skips evidence without a usable timestamp and empty input', () => {
    assert.deepEqual(recentFailuresByCard([]), {});
    assert.deepEqual(recentFailuresByCard(undefined), {});
    assert.deepEqual(recentFailuresByCard([
      quest({ terminalFact: failedFact({ statuses: { failed: { at: 'not-a-date', detail: 'x' } } }) }),
    ]), {}, 'undated evidence cannot be ordered, so it cannot accuse a card');
  });

  it('does not split a surrogate pair on the 200-character cut (cuts on code points)', () => {
    // 199 ASCII characters followed by a 2-code-unit emoji 🔥 (\uD83D\uDD25) and more text.
    const textWithEmoji = 'a'.repeat(199) + '🔥' + 'extra text';
    const result = recentFailuresByCard([
      quest({ terminalFact: failedFact({ statuses: { failed: { at: at(5), detail: textWithEmoji } } }) }),
    ]);
    const summary = result['card-a'].summary;
    // The cut on 200 code points includes 199 'a's and the full '🔥' without splitting it.
    assert.equal(summary, 'a'.repeat(199) + '🔥');
    // Ensure no lone surrogate: encodeURIComponent throws URIError on a malformed surrogate pair.
    assert.doesNotThrow(() => encodeURIComponent(summary));
  });

  it('builds recent failure note through a real QuestStore fixture', () => {
    const { config } = makeProject();
    const store = new QuestStore(config);
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    const attemptId = store.get('RUN-4').assignee.attemptId;
    store.setStatus('RUN-4', 'failed', {
      detail: 'worker crashed with real store',
      source: 'collector',
      evidence: { kind: 'collector', attemptId },
    });

    const reloaded = new QuestStore(config);
    const failures = recentFailuresByCard(reloaded.list());
    assert.deepEqual(failures['codex-luna'], {
      questId: 'RUN-4',
      at: reloaded.get('RUN-4').terminalFact.statuses.failed.at,
      summary: 'worker crashed with real store',
    });
    assert.deepEqual(recentFailuresByCard(store.list()), failures);
  });

  it('a ruling on an older done quest does not clear a newer failure of the same card (P6)', () => {
    const { config } = makeProject();
    const store = new QuestStore(config);

    store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-5', { adventurer: card('codex-luna'), name: 'runA' });
    const attemptA = store.get('RUN-5').assignee.attemptId;
    store.setStatus('RUN-5', 'delivered', {
      detail: 'ok', source: 'collector', evidence: { kind: 'collector', attemptId: attemptA },
    });
    store.setStatus('RUN-5', 'done', {
      source: 'collector', evidence: { kind: 'collector', attemptId: attemptA },
    });

    store.post({ package: 'RUN-6', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-6', { adventurer: card('codex-luna'), name: 'runB' });
    const attemptB = store.get('RUN-6').assignee.attemptId;
    store.setStatus('RUN-6', 'failed', {
      detail: 'newer failure on the same card', source: 'collector', evidence: { kind: 'collector', attemptId: attemptB },
    });

    // A ruling on the older, already-done quest bumps ITS updatedAt well past RUN-6's failure.
    // It must not resurrect RUN-5 as "delivered later than RUN-6's failure".
    store.rule('RUN-5', { text: 'no action needed, already accepted' });

    const reloaded = new QuestStore(config);
    const failures = recentFailuresByCard(reloaded.list());
    assert.deepEqual(failures['codex-luna'], {
      questId: 'RUN-6',
      at: reloaded.get('RUN-6').terminalFact.statuses.failed.at,
      summary: 'newer failure on the same card',
    }, 'the ruling on the older done quest must not hide the newer real failure');
  });

  it('a ruling on an older delivered quest does not clear a newer failure of the same card (P7)', () => {
    const { config } = makeProject();
    const store = new QuestStore(config);

    store.post({ package: 'RUN-7', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-7', { adventurer: card('codex-luna'), name: 'runA' });
    const attemptA = store.get('RUN-7').assignee.attemptId;
    store.setStatus('RUN-7', 'delivered', {
      detail: 'ok', source: 'collector', evidence: { kind: 'collector', attemptId: attemptA },
    });
    // RUN-7 stays delivered (not accepted done).

    store.post({ package: 'RUN-8', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-8', { adventurer: card('codex-luna'), name: 'runB' });
    const attemptB = store.get('RUN-8').assignee.attemptId;
    store.setStatus('RUN-8', 'failed', {
      detail: 'newer failure while RUN-7 sits delivered', source: 'collector', evidence: { kind: 'collector', attemptId: attemptB },
    });

    // A ruling on the still-delivered older quest bumps its updatedAt past RUN-8's failure.
    store.rule('RUN-7', { text: 'looks fine, no action' });

    const reloaded = new QuestStore(config);
    const failures = recentFailuresByCard(reloaded.list());
    assert.deepEqual(failures['codex-luna'], {
      questId: 'RUN-8',
      at: reloaded.get('RUN-8').terminalFact.statuses.failed.at,
      summary: 'newer failure while RUN-7 sits delivered',
    }, 'the ruling on the older delivered quest must not hide the newer real failure');
  });

  it('a real store: delivered -> failed -> reviewing on the same attempt keeps the failure (F3/X1)', () => {
    // The store keeps only the FIRST delivered record of an attempt: a re-delivery never
    // overwrites statuses.delivered. So an attempt that delivered and then failed still carries
    // a delivered fact. Moving it to reviewing afterwards (with no second, later delivery) must
    // not read that stale delivered fact as clearing evidence.
    const { config } = makeProject();
    const store = new QuestStore(config);

    store.post({ package: 'RUN-9', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-9', { adventurer: card('codex-luna'), name: 'run9' });
    const attemptId = store.get('RUN-9').assignee.attemptId;
    store.setStatus('RUN-9', 'delivered', {
      detail: 'ok', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    store.setStatus('RUN-9', 'failed', {
      detail: 'crashed after delivery', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    store.setStatus('RUN-9', 'reviewing', { detail: '', by: 'collector' });

    const reloaded = new QuestStore(config);
    const failures = recentFailuresByCard(reloaded.list());
    assert.deepEqual(failures['codex-luna'], {
      questId: 'RUN-9',
      at: reloaded.get('RUN-9').terminalFact.statuses.failed.at,
      summary: 'crashed after delivery',
    }, 'delivered -> failed -> reviewing with no later delivery must not clear the failure');
  });

  it('Y1: N3: a real store: failed -> delivered -> failed (same attempt) shows the current failure again', () => {
    // The current status wins (round 6 ruling): a quest back in 'failed' shows that failure whatever
    // earlier delivered fact this same attempt also recorded, however it compares by timestamp.
    const { config } = makeProject();
    const store = new QuestStore(config);
    store.post({ package: 'RUN-31', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-31', { adventurer: card('codex-luna'), name: 'runY1' });
    const attemptId = store.get('RUN-31').assignee.attemptId;
    store.setStatus('RUN-31', 'failed', {
      detail: 'first failure', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    store.setStatus('RUN-31', 'delivered', {
      detail: 'delivered after failure', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    const refailed = store.setStatus('RUN-31', 'failed', {
      detail: 'failed again', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    assert.equal(refailed.status, 'failed');
    assert.equal(refailed.terminalFact.statuses.delivered.restoredAt, undefined, 'a failed restore never stamps restoredAt on delivered (ruling 2)');

    const reloaded = new QuestStore(config);
    const failures = recentFailuresByCard(reloaded.list());
    assert.deepEqual(failures['codex-luna'], {
      questId: 'RUN-31',
      at: reloaded.get('RUN-31').terminalFact.statuses.failed.at,
      summary: 'first failure',
    }, 'N3: the current failed status wins over the earlier delivered fact');
  });

  it('Y2: N3: a real store: delivered -> failed -> delivered (restored) -> failed again still shows the current failure', () => {
    // Guards the F6 fix: the restored delivery's effective time (at, or restoredAt if later) now reads
    // later than the original failure everywhere delivered evidence is pushed, so without the N3
    // failingNow guard this would wrongly clear. The current status (failed) must still win.
    const { config } = makeProject();
    const store = new QuestStore(config);
    store.post({ package: 'RUN-32', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-32', { adventurer: card('codex-luna'), name: 'runY2' });
    const attemptId = store.get('RUN-32').assignee.attemptId;
    store.setStatus('RUN-32', 'delivered', {
      detail: 'first ok', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    store.setStatus('RUN-32', 'failed', {
      detail: 'crashed', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    const restored = store.setStatus('RUN-32', 'delivered', {
      detail: 'redelivered ok', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    assert.ok(restored.terminalFact.statuses.delivered.restoredAt, 'the restore stamps restoredAt on the delivered entry (F5/F6)');
    const refailed = store.setStatus('RUN-32', 'failed', {
      detail: 'failed again after the restore', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    assert.equal(refailed.status, 'failed');

    const reloaded = new QuestStore(config);
    const failures = recentFailuresByCard(reloaded.list());
    assert.deepEqual(failures['codex-luna'], {
      questId: 'RUN-32',
      at: reloaded.get('RUN-32').terminalFact.statuses.failed.at,
      summary: 'crashed',
    }, "N3: the current failed status wins even though the restored delivery's effective time reads later");
  });

  const Y4_CASES = [['owner_playtest', 'RUN-33'], ['needs_owner', 'RUN-34'], ['stalled', 'RUN-35']];
  for (const [targetStatus, id] of Y4_CASES) {
    it(`Y4: F6: a real store: delivered -> failed -> delivered (restored) -> ${targetStatus} still clears through the restore`, () => {
      // Before the F6 fix the general evidence push timed the delivered fact from its first `at` only,
      // ignoring `restoredAt`; a later re-delivery could then still read as older than the earlier
      // failure and the card wrongly kept showing that failure once moved to one of these non-terminal
      // statuses. With `ms: deliveredMs` on every push, the restored re-delivery correctly outranks it.
      const { config } = makeProject();
      const store = new QuestStore(config);
      store.post({ package: id, brief: 'docs/briefs/RUN-4-fixture.md' });
      store.assign(id, { adventurer: card('codex-luna'), name: `run-${targetStatus}` });
      const attemptId = store.get(id).assignee.attemptId;
      store.setStatus(id, 'delivered', {
        detail: 'first ok', source: 'collector', evidence: { kind: 'collector', attemptId },
      });
      store.setStatus(id, 'failed', {
        detail: 'crashed', source: 'collector', evidence: { kind: 'collector', attemptId },
      });
      const restored = store.setStatus(id, 'delivered', {
        detail: 'redelivered ok', source: 'collector', evidence: { kind: 'collector', attemptId },
      });
      assert.ok(restored.terminalFact.statuses.delivered.restoredAt);
      store.setStatus(id, targetStatus, { detail: '', by: 'owner' });

      const reloaded = new QuestStore(config);
      const failures = recentFailuresByCard(reloaded.list());
      assert.equal(failures['codex-luna'], undefined, `F6: the restored re-delivery clears the failure even after moving to ${targetStatus}`);
    });
  }

  it('Z1: control: delivered -> failed -> stalled with no re-delivery still shows the failure', () => {
    // No re-delivery ever happened after the failure, so the F6 fix (ms: deliveredMs on the general
    // push) must not accidentally start clearing this already-correct case: the failure is still the
    // newest evidence for the card.
    const { config } = makeProject();
    const store = new QuestStore(config);
    store.post({ package: 'RUN-36', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-36', { adventurer: card('codex-luna'), name: 'runZ1' });
    const attemptId = store.get('RUN-36').assignee.attemptId;
    store.setStatus('RUN-36', 'delivered', {
      detail: 'first ok', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    store.setStatus('RUN-36', 'failed', {
      detail: 'crashed, never redelivered', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    store.setStatus('RUN-36', 'stalled', { detail: '', by: 'owner' });

    const reloaded = new QuestStore(config);
    const failures = recentFailuresByCard(reloaded.list());
    assert.deepEqual(failures['codex-luna'], {
      questId: 'RUN-36',
      at: reloaded.get('RUN-36').terminalFact.statuses.failed.at,
      summary: 'crashed, never redelivered',
    }, 'control: no re-delivery ever happened, so the failure must still show');
  });

  it('Z2: control: failed -> delivered (first delivery ever) -> stalled clears, same as before the F6 fix', () => {
    // The delivered fact here is the attempt's first and only one, recorded after the failure with no
    // restore involved (recorded.restoredAt is never stamped). This already worked before the F6 fix
    // and must keep working after it.
    const { config } = makeProject();
    const store = new QuestStore(config);
    store.post({ package: 'RUN-37', brief: 'docs/briefs/RUN-4-fixture.md' });
    store.assign('RUN-37', { adventurer: card('codex-luna'), name: 'runZ2' });
    const attemptId = store.get('RUN-37').assignee.attemptId;
    store.setStatus('RUN-37', 'failed', {
      detail: 'crashed first', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    const delivered = store.setStatus('RUN-37', 'delivered', {
      detail: 'delivered after the failure', source: 'collector', evidence: { kind: 'collector', attemptId },
    });
    assert.equal(delivered.terminalFact.statuses.delivered.restoredAt, undefined, 'this is the first delivered fact ever, not a restore');
    store.setStatus('RUN-37', 'stalled', { detail: '', by: 'owner' });

    const reloaded = new QuestStore(config);
    const failures = recentFailuresByCard(reloaded.list());
    assert.equal(failures['codex-luna'], undefined, 'control: a first delivery after the failure clears it, as before');
  });
});

describe('snapshot recentFailures field', () => {
  const snapshotFor = (quests) => {
    const { config } = makeProject();
    return buildSnapshot({ config, store: { list: () => quests }, adventurers: [], boardStore: null, lanes: { packages: [] } });
  };

  it('stays absent on a snapshot without failures, byte for byte the old shape', () => {
    const snapshot = snapshotFor([]);
    assert.equal('recentFailures' in snapshot, false, 'no failures means no new field at all');
    assert.ok(Array.isArray(snapshot.quests) && Array.isArray(snapshot.roster));
  });

  it('carries the bounded projection under the card id when there is one', () => {
    const snapshot = snapshotFor([quest({ terminalFact: failedFact(), dispatches: [row()] })]);
    assert.deepEqual(snapshot.recentFailures, {
      'card-a': { questId: 'RUN-1', at: at(5), summary: 'worker exited 1' },
    });
  });
});

// Builds a fact whose statuses map carries exactly the entries given, on the standard attempt.
function forceStatuses(statuses) {
  return { attemptId: 'att-1', name: 'mod1', at: at(0), lane: 'codex', statuses };
}
