// Recent execution failure context (feedback 1, remaining clause). The projection is read-only history:
// an ordinary task failure must never pause a card, touch its owner-set status, or be inferred from a
// model string. These tests pin the exact-identity rules, the latest-attempt clearing policy and the
// bounded plain-text contract of the snapshot field.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recentFailuresByCard, MAX_SUMMARY } from '../../src/core/failureContext.js';
import { buildSnapshot } from '../../src/core/snapshot.js';
import { makeProject } from '../helpers.js';

const BASE = Date.parse('2026-09-16T00:00:00.000Z');
const at = (minutes) => new Date(BASE + minutes * 60_000).toISOString();

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

  it('clears an older failure when a later attempt on the same card delivered (latest-attempt policy)', () => {
    const older = quest({ id: 'RUN-1', terminalFact: failedFact(), dispatches: [row({ attemptId: 'att-1' })], updatedAt: at(5) });
    const delivered = quest({
      id: 'RUN-2', status: 'delivered', updatedAt: at(30),
      terminalFact: { attemptId: 'att-2', name: 'mod1', at: at(20), lane: 'codex', statuses: { delivered: { at: at(25), detail: 'ok' } } },
      dispatches: [row({ attemptId: 'att-2', at: at(20) })],
    });
    assert.deepEqual(recentFailuresByCard([older, delivered]), {}, 'the later delivery clears the card');
    // Same quest, both statuses recorded on the same attempt: the newer delivery still wins.
    const both = quest({ terminalFact: failedFact({ statuses: { failed: { at: at(5), detail: 'flaky' }, delivered: { at: at(8), detail: 'ok' } } }) });
    assert.deepEqual(recentFailuresByCard([both]), {});
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
    const legacy = quest({ id: 'RUN-1', status: 'failed', updatedAt: at(30), lastDetail: 'lane refused', dispatches: [row()] });
    assert.deepEqual(recentFailuresByCard([legacy]), { 'card-a': { questId: 'RUN-1', at: at(30), summary: 'lane refused' } });
    const withoutId = quest({ id: 'RUN-2', status: 'failed', dispatches: [{ name: 'mod1', at: at(0) }] });
    assert.deepEqual(recentFailuresByCard([withoutId]), {}, 'legacy rows without a card id stay unassociated');
    const posted = quest({ id: 'RUN-3', status: 'posted', dispatches: [row()] });
    assert.deepEqual(recentFailuresByCard([posted]), {});
    // A legacy delivered quest is the clearing evidence for an older legacy failure.
    const delivered = quest({ id: 'RUN-4', status: 'delivered', updatedAt: at(40), dispatches: [row()] });
    assert.deepEqual(recentFailuresByCard([legacy, delivered]), {});
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
