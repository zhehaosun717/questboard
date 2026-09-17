// Requirement 1 (revision 3): an oversized or unreadable brief must never quietly become an empty, "no
// files" result for a quest that matters to dispatch safety. These tests fail on 47f86d9 (which has no
// brief-size cap or read-failure handling at all — withFileSets/fileSetFor simply crash or return a real
// file set) and must pass after this revision.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withFileSets, MAX_BRIEF_BYTES } from '../../src/core/briefs.js';
import { briefExists, briefUnusable } from '../../src/core/snapshot.js';
import { canDispatch } from '../../src/core/rules.js';
import { makeProject, card } from '../helpers.js';

const FILES = '# T\n\n## Files you may edit\n- `src/shared.js`\n';
const adv = card('codex-luna');

function conflictQuests({ runningStatus = 'dispatched' } = {}) {
  return [
    { id: 'RUN-1', kind: 'code', status: runningStatus, assignee: { adventurerId: 'other' }, brief: 'docs/briefs/RUN-1-running.md', conflicts: [], parents: [] },
    { id: 'RUN-2', kind: 'code', status: 'posted', assignee: null, brief: 'docs/briefs/RUN-2-candidate.md', conflicts: [], parents: [] },
  ];
}

function check(quest, quests, config) {
  const env = { treeLocked: false, briefExists: briefExists(config, quest), briefUnusable: briefUnusable(config, quest), laneIds: new Set(['codex']) };
  return canDispatch({ quest, adventurer: adv, quests, policy: {}, env });
}

describe('brief fail-closed conflicts (requirement 1)', () => {
  it('refuses a candidate dispatch when the RUNNING quest\'s brief is oversized (dispatched)', () => {
    const { config, write } = makeProject();
    const pad = 'x'.repeat(MAX_BRIEF_BYTES + 1024);
    write('docs/briefs/RUN-1-running.md', `${FILES}\n${pad}\n`);
    write('docs/briefs/RUN-2-candidate.md', FILES);
    const withFiles = withFileSets(config, conflictQuests());
    const candidate = withFiles.find((q) => q.id === 'RUN-2');
    const verdict = check(candidate, withFiles, config);
    assert.equal(verdict.ok, false, 'must not silently allow a dispatch that might collide with an unknown-file running quest');
    assert.ok(verdict.reasons.some((r) => r.code === 'conflict_running'), 'must name the specific held quest as a conflict, not just refuse for an unrelated reason');
  });

  it('refuses a candidate dispatch when the RUNNING quest\'s brief is oversized (stalled)', () => {
    const { config, write } = makeProject();
    const pad = 'x'.repeat(MAX_BRIEF_BYTES + 1024);
    write('docs/briefs/RUN-1-running.md', `${FILES}\n${pad}\n`);
    write('docs/briefs/RUN-2-candidate.md', FILES);
    const withFiles = withFileSets(config, conflictQuests({ runningStatus: 'stalled' }));
    const candidate = withFiles.find((q) => q.id === 'RUN-2');
    const verdict = check(candidate, withFiles, config);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((r) => r.code === 'conflict_running'));
  });

  it('refuses a candidate dispatch when the running quest\'s brief throws on read (EBUSY)', () => {
    const { config, write } = makeProject();
    const runningFile = write('docs/briefs/RUN-1-running.md', FILES);
    write('docs/briefs/RUN-2-candidate.md', FILES);
    const orig = fs.readFileSync;
    fs.readFileSync = (target, enc) => {
      if (String(target) === runningFile) { const err = new Error('busy'); err.code = 'EBUSY'; throw err; }
      return orig(target, enc);
    };
    try {
      const withFiles = withFileSets(config, conflictQuests());
      const candidate = withFiles.find((q) => q.id === 'RUN-2');
      const verdict = check(candidate, withFiles, config);
      assert.equal(verdict.ok, false, 'an EBUSY read must fail closed, not silently produce an empty file set');
      assert.ok(verdict.reasons.some((r) => r.code === 'conflict_running'));
    } finally {
      fs.readFileSync = orig;
    }
  });

  it('refuses the candidate outright when its OWN brief is oversized, via briefExists/brief_unusable (revision 4: distinct from brief_missing)', () => {
    const { config, write } = makeProject();
    const pad = 'x'.repeat(MAX_BRIEF_BYTES + 1024);
    write('docs/briefs/RUN-1-running.md', FILES);
    write('docs/briefs/RUN-2-candidate.md', `${FILES}\n${pad}\n`);
    const withFiles = withFileSets(config, conflictQuests());
    const candidate = withFiles.find((q) => q.id === 'RUN-2');
    assert.equal(briefExists(config, candidate), false, 'briefExists must fail for an oversized current brief, not just check existsSync');
    const verdict = check(candidate, withFiles, config);
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.reasons.some((r) => r.code === 'brief_missing'), 'an oversized brief physically exists; brief_missing would claim otherwise');
    const unusable = verdict.reasons.find((r) => r.code === 'brief_unusable');
    assert.ok(unusable, 'a distinct reason code must name the brief exists but cannot be trusted');
    assert.match(unusable.message, /RUN-2-candidate\.md/, 'must name the actual file');
    assert.match(unusable.message, /2\.0MB/, 'must name the actual cause (too large), not claim the file is missing');
  });

  it('a genuinely missing brief (never written) still refuses via brief_missing, unchanged', () => {
    const { config, write } = makeProject();
    write('docs/briefs/RUN-1-running.md', FILES);
    // RUN-2-candidate.md is never written at all.
    const withFiles = withFileSets(config, conflictQuests());
    const candidate = withFiles.find((q) => q.id === 'RUN-2');
    assert.equal(briefExists(config, candidate), false);
    const verdict = check(candidate, withFiles, config);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((r) => r.code === 'brief_missing'), 'a brief that was never written is still brief_missing, not brief_unusable');
    assert.ok(!verdict.reasons.some((r) => r.code === 'brief_unusable'));
  });

  it('still allows a normal dispatch when both briefs are small and readable (control)', () => {
    const { config, write } = makeProject();
    write('docs/briefs/RUN-1-running.md', FILES);
    write('docs/briefs/RUN-2-candidate.md', FILES);
    const withFiles = withFileSets(config, conflictQuests());
    const candidate = withFiles.find((q) => q.id === 'RUN-2');
    const verdict = check(candidate, withFiles, config);
    assert.equal(verdict.ok, false, 'a genuine shared file must still conflict');
    const conflict = verdict.reasons.find((r) => r.code === 'conflict_running');
    assert.ok(conflict, 'must still detect the real shared file src/shared.js');
  });

  it('never blames an unrelated healthy running quest for a conflict caused by a different unknown-file quest', () => {
    const { config, write } = makeProject();
    const pad = 'x'.repeat(MAX_BRIEF_BYTES + 1024);
    write('docs/briefs/RUN-1-running.md', `${FILES}\n${pad}\n`); // unknown
    write('docs/briefs/RUN-3-healthy.md', '# T\n\n## Files you may edit\n- `src/unrelated.js`\n'); // known, disjoint files
    write('docs/briefs/RUN-2-candidate.md', FILES);
    const quests = [
      { id: 'RUN-1', kind: 'code', status: 'dispatched', assignee: { adventurerId: 'a' }, brief: 'docs/briefs/RUN-1-running.md', conflicts: [], parents: [] },
      { id: 'RUN-3', kind: 'code', status: 'dispatched', assignee: { adventurerId: 'b' }, brief: 'docs/briefs/RUN-3-healthy.md', conflicts: [], parents: [] },
      { id: 'RUN-2', kind: 'code', status: 'posted', assignee: null, brief: 'docs/briefs/RUN-2-candidate.md', conflicts: [], parents: [] },
    ];
    const withFiles = withFileSets(config, quests);
    const healthy = withFiles.find((q) => q.id === 'RUN-3');
    assert.deepEqual(healthy.files, ['src/unrelated.js'], 'a healthy running quest\'s own file set must be untouched by an unrelated quest\'s unknown status');
  });

  it('does not throw building a full snapshot payload with an oversized or unreadable brief in the mix (no whole-board 500)', () => {
    const { config, write } = makeProject();
    const pad = 'x'.repeat(MAX_BRIEF_BYTES + 1024);
    write('docs/briefs/RUN-1-running.md', `${FILES}\n${pad}\n`);
    write('docs/briefs/RUN-2-candidate.md', FILES);
    assert.doesNotThrow(() => withFileSets(config, conflictQuests()));
  });
});

// B3 (revision 4): the conflict-only token must live in a separate internal field (conflictKeys), never in
// the public .files list, and the conflict_running message for an unknown-brief conflict must say plainly
// that the held quest's brief could not be confirmed — never claim "正在改同一批文件" (which asserts
// knowledge the board does not have).
describe('the unknown-brief conflict token stays out of quest.files (requirement B3)', () => {
  it('keeps the candidate\'s real files clean and puts the token in conflictKeys instead', () => {
    const { config, write } = makeProject();
    const pad = 'x'.repeat(MAX_BRIEF_BYTES + 1024);
    write('docs/briefs/RUN-1-running.md', `${FILES}\n${pad}\n`);
    write('docs/briefs/RUN-2-candidate.md', FILES);
    const withFiles = withFileSets(config, conflictQuests());
    const candidate = withFiles.find((q) => q.id === 'RUN-2');
    assert.deepEqual(candidate.files, ['src/shared.js'], 'files must contain only the candidate\'s own real files, never a token');
    assert.ok(Array.isArray(candidate.conflictKeys) && candidate.conflictKeys.length === 1, 'the conflict-only key must live in conflictKeys');
    assert.ok(!candidate.conflictKeys[0].includes('/'), 'a conflictKeys entry must never look like a real path');

    const held = withFiles.find((q) => q.id === 'RUN-1');
    assert.deepEqual(held.files, [], 'the held quest\'s own (unknown) files stay empty, never carrying a token either');
    assert.match(held.briefUnknownReason, /文件过大/, 'the human reason lives on the held quest itself, for rules.js to read');
  });

  it('gives the conflict_running reason for an unknown-brief match a truthful message, not "正在改同一批文件"', () => {
    const { config, write } = makeProject();
    const pad = 'x'.repeat(MAX_BRIEF_BYTES + 1024);
    write('docs/briefs/RUN-1-running.md', `${FILES}\n${pad}\n`);
    write('docs/briefs/RUN-2-candidate.md', FILES);
    const withFiles = withFileSets(config, conflictQuests());
    const candidate = withFiles.find((q) => q.id === 'RUN-2');
    const verdict = check(candidate, withFiles, config);
    const conflict = verdict.reasons.find((r) => r.code === 'conflict_running');
    assert.ok(conflict, 'must still refuse as a conflict');
    assert.match(conflict.message, /RUN-1 的简报现在读不了/);
    assert.match(conflict.message, /文件过大/, 'must name the actual cause');
    assert.ok(!conflict.message.includes('正在改同一批文件'), 'must never claim to know the two briefs touch the same files');
  });
});
