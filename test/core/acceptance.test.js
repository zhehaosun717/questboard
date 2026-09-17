// Feedback 15: an additive acceptance record captured on the done transition. validateAcceptanceShape is the
// pure shape check src/core/store.js uses directly (it never sees questEvidence()'s own data); buildAcceptance
// adds the actor === by check and the match against real evidence for the server route that does.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAcceptance, validateAcceptanceShape } from '../../src/core/acceptance.js';

const item = (overrides = {}) => ({
  kind: 'report', label: '工作者报告', state: 'passed', source: 'delivery', ref: '.work/oc/mod1.md',
  digest: 'abc123', capturedAt: '2026-09-16T00:00:00.000Z', attemptId: 'a1', bound: true, ...overrides,
});

describe('validateAcceptanceShape', () => {
  it('returns undefined for no input, and refuses a non-object, a bad actor, an oversized note or refs array', () => {
    assert.equal(validateAcceptanceShape(undefined), undefined);
    assert.equal(validateAcceptanceShape(null), undefined);
    assert.throws(() => validateAcceptanceShape('owner'), /对象/);
    assert.throws(() => validateAcceptanceShape({ actor: 'nobody' }), /owner 或 coordinator/);
    assert.throws(() => validateAcceptanceShape({ actor: 'owner', evidenceRefs: 'nope' }), /数组/);
    assert.throws(() => validateAcceptanceShape({ actor: 'owner', evidenceRefs: [{}] }), /kind/);
    const tooMany = Array.from({ length: 9 }, () => ({ kind: 'report' }));
    assert.throws(() => validateAcceptanceShape({ actor: 'owner', evidenceRefs: tooMany }), /最多/);
  });

  it('normalizes a valid record and caps the note at 2000 characters', () => {
    const record = validateAcceptanceShape({ actor: 'owner', evidenceRefs: [{ kind: 'report', ref: 'x', digest: 'd1', attemptId: 'a1' }], note: 'x'.repeat(2500) });
    assert.equal(record.actor, 'owner');
    assert.deepEqual(record.evidenceRefs, [{ kind: 'report', ref: 'x', digest: 'd1', attemptId: 'a1' }]);
    assert.equal(record.note.length, 2000);
  });

  it('omits an empty note rather than storing a blank string', () => {
    const record = validateAcceptanceShape({ actor: 'owner', note: '   ' });
    assert.equal('note' in record, false);
  });
});

describe('buildAcceptance', () => {
  it('refuses an actor that does not equal the request identity — a board click can never claim coordinator', () => {
    assert.throws(
      () => buildAcceptance({ actor: 'coordinator' }, { by: 'owner', evidenceItems: [] }),
      /看板点击不能记成 coordinator 验收/,
    );
  });

  it('allows a matching actor with no evidence refs at all', () => {
    const record = buildAcceptance({ actor: 'owner' }, { by: 'owner', evidenceItems: [item()] });
    assert.deepEqual(record, { actor: 'owner', evidenceRefs: [] });
  });

  it('matches a ref against a bound item by kind, digest and attemptId, and returns the item\'s own fields', () => {
    const record = buildAcceptance(
      { actor: 'coordinator', evidenceRefs: [{ kind: 'report', digest: 'abc123', attemptId: 'a1' }] },
      { by: 'coordinator', evidenceItems: [item()] },
    );
    assert.deepEqual(record.evidenceRefs, [{ kind: 'report', ref: '.work/oc/mod1.md', digest: 'abc123', attemptId: 'a1' }]);
  });

  it('refuses a ref that names the wrong digest, the wrong attemptId, or an unbound item, naming the kind', () => {
    const items = [item(), item({ kind: 'hook', digest: 'h1', bound: false, attemptId: 'a1' })];
    assert.throws(
      () => buildAcceptance({ actor: 'coordinator', evidenceRefs: [{ kind: 'report', digest: 'WRONG', attemptId: 'a1' }] }, { by: 'coordinator', evidenceItems: items }),
      /证据引用对不上.*report/,
    );
    assert.throws(
      () => buildAcceptance({ actor: 'coordinator', evidenceRefs: [{ kind: 'report', digest: 'abc123', attemptId: 'STALE' }] }, { by: 'coordinator', evidenceItems: items }),
      /证据引用对不上/,
    );
    assert.throws(
      () => buildAcceptance({ actor: 'coordinator', evidenceRefs: [{ kind: 'hook', digest: 'h1', attemptId: 'a1' }] }, { by: 'coordinator', evidenceItems: items }),
      /证据引用对不上.*hook/,
    );
  });

  it('returns undefined for no input', () => {
    assert.equal(buildAcceptance(undefined, { by: 'owner', evidenceItems: [] }), undefined);
  });
});
