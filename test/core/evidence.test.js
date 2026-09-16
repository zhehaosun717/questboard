// Suggestion S2: questEvidence() binds report/project-verification/hook evidence to the quest's CURRENT
// attempt, marks anything else bound:false with a Chinese reason, and is honest about what was never
// configured versus what was configured but never produced.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject } from '../helpers.js';
import { captureAttemptReport } from '../../src/core/reportEvidence.js';
import { latestProgress } from '../../src/lanes/progress.js';
import { questEvidence, EVIDENCE_VERSION } from '../../src/core/evidence.js';

const attempt = (overrides = {}) => ({ name: 'mod1', lane: 'opencode', at: '2026-09-14T00:00:00.000Z', attemptId: 'a1', ...overrides });

describe('questEvidence — shape and attempt identity', () => {
  it('carries the current attempt identity and orders items report, project-verification, hook', () => {
    const project = makeProject();
    const quest = { id: 'EV-1', assignee: attempt() };
    const evidence = questEvidence({ config: project.config, quest, verification: null });
    assert.equal(evidence.version, EVIDENCE_VERSION);
    assert.equal(evidence.attemptId, 'a1');
    assert.equal(evidence.attemptAt, '2026-09-14T00:00:00.000Z');
    assert.deepEqual(evidence.items.map((item) => item.kind), ['report', 'project-verification', 'hook']);
  });

  it('reports null identity for a quest that was never dispatched', () => {
    const project = makeProject();
    const evidence = questEvidence({ config: project.config, quest: { id: 'EV-2' }, verification: null });
    assert.equal(evidence.attemptId, null);
    assert.equal(evidence.attemptAt, null);
    assert.equal(evidence.attemptName, null);
  });

  it('carries the current attempt worker name alongside the id and time (F6)', () => {
    const project = makeProject();
    const evidence = questEvidence({ config: project.config, quest: { id: 'EV-2b', assignee: attempt({ name: 'mod7' }) }, verification: null });
    assert.equal(evidence.attemptName, 'mod7');
  });
});

describe('questEvidence — report item', () => {
  it('reads the captured report state and reference', () => {
    const project = makeProject();
    const quest = { id: 'EV-3', assignee: attempt() };
    project.write('.work/oc/mod1.md', '# 战报\n\n正文。\n\nVERDICT: PASS\n');
    const capture = captureAttemptReport({ config: project.config, quest });
    const evidence = questEvidence({ config: project.config, quest: { ...quest, attemptReport: capture } });
    const report = evidence.items[0];
    assert.equal(report.state, 'passed');
    assert.equal(report.source, 'delivery');
    assert.equal(report.ref, '.work/oc/mod1.md');
    assert.equal(report.digest, capture.digest);
    assert.equal(report.bound, true);
    assert.equal(report.attemptId, 'a1');
  });

  it('maps FAIL and PASS WITH FINDINGS, and keeps a truncated read unknown with its reason', () => {
    const project = makeProject();
    const failQuest = { id: 'EV-4', assignee: attempt({ name: 'fail1' }) };
    project.write('.work/oc/fail1.md', 'VERDICT: FAIL\n');
    const failCapture = captureAttemptReport({ config: project.config, quest: failQuest });
    assert.equal(questEvidence({ config: project.config, quest: { ...failQuest, attemptReport: failCapture } }).items[0].state, 'failed');

    const findingsQuest = { id: 'EV-5', assignee: attempt({ name: 'find1' }) };
    project.write('.work/oc/find1.md', '发现两个小问题。\n\nVERDICT: PASS WITH FINDINGS\n');
    const findingsCapture = captureAttemptReport({ config: project.config, quest: findingsQuest });
    assert.equal(questEvidence({ config: project.config, quest: { ...findingsQuest, attemptReport: findingsCapture } }).items[0].state, 'findings');

    const unknownQuest = { id: 'EV-6', assignee: attempt({ name: 'codex1', lane: 'codex' }) };
    project.write('.work/codex/codex1.out', 'VERDICT: PASS\n');
    const unknownCapture = captureAttemptReport({ config: project.config, quest: unknownQuest });
    const unknownEvidence = questEvidence({ config: project.config, quest: { ...unknownQuest, attemptReport: unknownCapture } }).items[0];
    assert.equal(unknownEvidence.state, 'unknown');
    assert.match(unknownEvidence.reason, /运行记录/);
  });

  it('is missing before any dispatch, and missing again (never inherited) once a newer attempt replaces the captured one', () => {
    const project = makeProject();
    const undispatched = questEvidence({ config: project.config, quest: { id: 'EV-7' } }).items[0];
    assert.equal(undispatched.state, 'missing');
    assert.equal(undispatched.reason, '没有本次尝试的报告');

    const quest = { id: 'EV-8', assignee: attempt() };
    project.write('.work/oc/mod1.md', 'VERDICT: PASS\n');
    const capture = captureAttemptReport({ config: project.config, quest });
    const stale = { ...quest, attemptReport: capture, assignee: attempt({ attemptId: 'a2', at: '2026-09-15T00:00:00.000Z' }) };
    const evidence = questEvidence({ config: project.config, quest: stale });
    assert.equal(evidence.items[0].state, 'missing');
    assert.equal(evidence.items[0].attemptId, 'a2', 'the identity is still the CURRENT attempt, even though it has no report');
  });
});

describe('questEvidence — project-verification item', () => {
  it('is not_configured with no progressDirs at all', () => {
    const project = makeProject();
    const evidence = questEvidence({ config: project.config, quest: { id: 'EV-9', assignee: attempt() }, verification: null });
    assert.deepEqual([evidence.items[1].state, evidence.items[1].bound], ['not_configured', false]);
    assert.match(evidence.items[1].reason, /没有配置验证目录/);
  });

  it('is missing when configured but nothing was ever written', () => {
    const project = makeProject({ verification: { progressDirs: ['.work/full'] } });
    const evidence = questEvidence({ config: project.config, quest: { id: 'EV-10', assignee: attempt() }, verification: null });
    assert.deepEqual([evidence.items[1].state, evidence.items[1].bound], ['missing', false]);
    assert.match(evidence.items[1].reason, /没有找到验证记录文件/);
  });

  it('binds a progress.txt newer than the attempt, and reports passed/failed from its own content', () => {
    const project = makeProject({ verification: { progressDirs: ['.work/full'] } });
    const file = project.write('.work/full/progress.txt', 'compile exit 0\nedit exit 0\nDONE\n');
    fs.utimesSync(file, new Date('2026-09-14T01:00:00.000Z'), new Date('2026-09-14T01:00:00.000Z'));
    const verification = latestProgress(project.config.verification.progressDirs);
    const quest = { id: 'EV-11', assignee: attempt() };
    const evidence = questEvidence({ config: project.config, quest, verification });
    const item = evidence.items[1];
    assert.equal(item.bound, true);
    assert.equal(item.state, 'passed');
    assert.equal(item.ref, '.work/full/progress.txt');
    assert.ok(item.digest);
    assert.equal(item.reason, undefined);
  });

  it('marks a progress.txt older than the attempt bound:false with the stale reason, never styled as passed', () => {
    const project = makeProject({ verification: { progressDirs: ['.work/full'] } });
    const file = project.write('.work/full/progress.txt', 'compile exit 0\nDONE\n');
    fs.utimesSync(file, new Date('2026-09-13T00:00:00.000Z'), new Date('2026-09-13T00:00:00.000Z'));
    const verification = latestProgress(project.config.verification.progressDirs);
    const quest = { id: 'EV-12', assignee: attempt({ at: '2026-09-14T00:00:00.000Z' }) };
    const evidence = questEvidence({ config: project.config, quest, verification });
    const item = evidence.items[1];
    assert.equal(item.bound, false);
    assert.equal(item.reason, '这是上一次尝试之前的记录，不算本次证据');
  });

  it('reports failed on a compile error step or a failing NUnit total', () => {
    const project = makeProject({ verification: { progressDirs: ['.work/full'] } });
    project.write('.work/full/progress.txt', 'compile errorCS 2\n');
    const verification = latestProgress(project.config.verification.progressDirs);
    const quest = { id: 'EV-13', assignee: attempt() };
    assert.equal(questEvidence({ config: project.config, quest, verification }).items[1].state, 'failed');
  });

  it('gives a dedicated never-dispatched reason, not the stale-record text, when there is no attempt at all (F6)', () => {
    const project = makeProject({ verification: { progressDirs: ['.work/full'] } });
    const file = project.write('.work/full/progress.txt', 'compile exit 0\nDONE\n');
    fs.utimesSync(file, new Date('2026-09-14T01:00:00.000Z'), new Date('2026-09-14T01:00:00.000Z'));
    const verification = latestProgress(project.config.verification.progressDirs);
    const evidence = questEvidence({ config: project.config, quest: { id: 'EV-20' }, verification });
    const item = evidence.items[1];
    assert.equal(item.bound, false);
    assert.equal(item.reason, '还没有派遣，无法绑定');
  });
});

describe('questEvidence — project-verification binds only to the project-wide latest dispatch (F2)', () => {
  it('is bound:false for an earlier attempt once a later dispatch (of any quest) supersedes it, even with a fresh file', () => {
    const project = makeProject({ verification: { progressDirs: ['.work/full'] } });
    const file = project.write('.work/full/progress.txt', 'compile exit 0\nDONE\n');
    fs.utimesSync(file, new Date('2026-09-14T00:00:10.000Z'), new Date('2026-09-14T00:00:10.000Z'));
    const verification = latestProgress(project.config.verification.progressDirs);
    const earlier = attempt({ name: 'sa1', attemptId: 'sa-1', at: '2026-09-14T00:00:00.000Z' });
    const laterDispatchAt = Date.parse('2026-09-14T00:00:05.000Z');
    const evidence = questEvidence({ config: project.config, quest: { id: 'SA-1', assignee: earlier }, verification, latestDispatchAt: laterDispatchAt });
    const item = evidence.items[1];
    assert.equal(item.bound, false, 'a later dispatch of another quest supersedes this one, even though the file is newer than THIS attempt');
    assert.equal(item.reason, '这是上一次尝试之前的记录，不算本次证据');
  });

  it('is bound:true for the attempt that IS the project-wide latest, with a file newer than it', () => {
    const project = makeProject({ verification: { progressDirs: ['.work/full'] } });
    const file = project.write('.work/full/progress.txt', 'compile exit 0\nDONE\n');
    fs.utimesSync(file, new Date('2026-09-14T00:00:10.000Z'), new Date('2026-09-14T00:00:10.000Z'));
    const verification = latestProgress(project.config.verification.progressDirs);
    const later = attempt({ name: 'sb1', attemptId: 'sb-1', at: '2026-09-14T00:00:05.000Z' });
    const latestDispatchAt = Date.parse('2026-09-14T00:00:05.000Z');
    const evidence = questEvidence({ config: project.config, quest: { id: 'SB-1', assignee: later }, verification, latestDispatchAt });
    const item = evidence.items[1];
    assert.equal(item.bound, true);
    assert.equal(item.state, 'passed');
  });
});

describe('questEvidence — project-verification NUnit mtimes take part in binding (F3)', () => {
  it('ignores a stale NUnit failure total even though progress.txt itself is fresh', () => {
    const project = makeProject({ verification: { progressDirs: ['.work/full'] } });
    const progress = project.write('.work/full/progress.txt', 'compile exit 0\n');
    fs.utimesSync(progress, new Date('2026-09-14T01:00:00.000Z'), new Date('2026-09-14T01:00:00.000Z'));
    const play = project.write('.work/full/play.xml', '<test-run total="5" passed="0" failed="5"></test-run>');
    fs.utimesSync(play, new Date('2026-09-10T00:00:00.000Z'), new Date('2026-09-10T00:00:00.000Z'));
    const verification = latestProgress(project.config.verification.progressDirs);
    const quest = { id: 'EV-21', assignee: attempt({ at: '2026-09-14T00:00:00.000Z' }) };
    const evidence = questEvidence({ config: project.config, quest, verification });
    const item = evidence.items[1];
    assert.equal(item.bound, true);
    assert.equal(item.state, 'unknown', 'the stale failing NUnit total must never decide the state');
  });

  it('reports failed from a fresh NUnit failure total even when progress.txt itself has no DONE line', () => {
    const project = makeProject({ verification: { progressDirs: ['.work/full'] } });
    const progress = project.write('.work/full/progress.txt', 'compile exit 0\n');
    fs.utimesSync(progress, new Date('2026-09-14T01:00:00.000Z'), new Date('2026-09-14T01:00:00.000Z'));
    const play = project.write('.work/full/play.xml', '<test-run total="5" passed="3" failed="2"></test-run>');
    fs.utimesSync(play, new Date('2026-09-14T01:00:00.000Z'), new Date('2026-09-14T01:00:00.000Z'));
    const verification = latestProgress(project.config.verification.progressDirs);
    const quest = { id: 'EV-22', assignee: attempt({ at: '2026-09-14T00:00:00.000Z' }) };
    const evidence = questEvidence({ config: project.config, quest, verification });
    assert.equal(evidence.items[1].state, 'failed');
  });
});

describe('questEvidence — hook item (reserved slot, S1)', () => {
  it('is not_configured when no hooks exist on the attempt', () => {
    const project = makeProject();
    const evidence = questEvidence({ config: project.config, quest: { id: 'EV-14', assignee: attempt() } });
    assert.deepEqual([evidence.items[2].state, evidence.items[2].bound], ['not_configured', false]);
    assert.match(evidence.items[2].reason, /没有启用验证钩子/);
  });

  it('shows a valid, attempt-bound hook record with its own fields', () => {
    const project = makeProject();
    const hooks = [{ state: 'passed', commandRef: 'npm test', startedAt: '2026-09-14T00:00:00.000Z', endedAt: '2026-09-14T00:01:00.000Z', exitCode: 0, logPath: 'hooks/a1.log', logDigest: 'a'.repeat(64), attemptId: 'a1' }];
    const evidence = questEvidence({ config: project.config, quest: { id: 'EV-15', assignee: attempt({ hooks }) } });
    const item = evidence.items[2];
    assert.equal(item.state, 'passed');
    assert.equal(item.bound, true);
    assert.equal(item.commandRef, 'npm test');
    assert.equal(item.logPath, 'hooks/a1.log');
    assert.equal(item.logDigest, 'a'.repeat(64));
    assert.equal(item.source, 'npm test');
    assert.equal(item.ref, 'hooks/a1.log');
  });

  it('marks a hook record from a different attempt bound:false', () => {
    const project = makeProject();
    const hooks = [{ state: 'passed', commandRef: 'npm test', startedAt: null, endedAt: null, exitCode: 0, logPath: null, logDigest: null, attemptId: 'a0' }];
    const evidence = questEvidence({ config: project.config, quest: { id: 'EV-16', assignee: attempt({ hooks }) } });
    assert.equal(evidence.items[2].bound, false);
    assert.match(evidence.items[2].reason, /上一次尝试的钩子记录/);
  });

  it('refuses an absolute logPath and a path that escapes the data directory', () => {
    const project = makeProject();
    for (const logPath of [path.join(project.root, 'outside.log'), '../outside.log', '..\\outside.log']) {
      const hooks = [{ state: 'passed', commandRef: 'npm test', startedAt: null, endedAt: null, exitCode: 0, logPath, logDigest: null, attemptId: 'a1' }];
      const evidence = questEvidence({ config: project.config, quest: { id: 'EV-17', assignee: attempt({ hooks }) } });
      assert.equal(evidence.items[2].state, 'unknown', logPath);
      assert.match(evidence.items[2].reason, /格式不对/, logPath);
    }
  });

  it('refuses a drive-relative or colon-containing logPath (F5)', () => {
    const project = makeProject();
    for (const logPath of ['C:x.log', 'hooks:a1.log', 'C:\\hooks\\a1.log', 'a\\b:c.log']) {
      const hooks = [{ state: 'passed', commandRef: 'npm test', startedAt: null, endedAt: null, exitCode: 0, logPath, logDigest: null, attemptId: 'a1' }];
      const evidence = questEvidence({ config: project.config, quest: { id: 'EV-24', assignee: attempt({ hooks }) } });
      assert.equal(evidence.items[2].state, 'unknown', logPath);
      assert.match(evidence.items[2].reason, /格式不对/, logPath);
    }
  });

  it('refuses a multi-line commandRef, even under 300 characters (F5)', () => {
    const project = makeProject();
    const hooks = [{ state: 'passed', commandRef: 'line1\nline2\nFAILED 3 tests\n', startedAt: null, endedAt: null, exitCode: 0, logPath: null, logDigest: null, attemptId: 'a1' }];
    const evidence = questEvidence({ config: project.config, quest: { id: 'EV-25', assignee: attempt({ hooks }) } });
    assert.equal(evidence.items[2].state, 'unknown');
  });

  it('still accepts a single-line commandRef with spaces (unchanged)', () => {
    const project = makeProject();
    const hooks = [{ state: 'passed', commandRef: 'npm test -- --ci', startedAt: null, endedAt: null, exitCode: 0, logPath: null, logDigest: null, attemptId: 'a1' }];
    const evidence = questEvidence({ config: project.config, quest: { id: 'EV-26', assignee: attempt({ hooks }) } });
    assert.equal(evidence.items[2].state, 'passed');
    assert.equal(evidence.items[2].commandRef, 'npm test -- --ci');
  });

  it('refuses a record with an unlisted field (the anti-smuggling guard) and an unknown state', () => {
    const project = makeProject();
    const smuggled = [{ state: 'passed', commandRef: 'npm test', startedAt: null, endedAt: null, exitCode: 0, logPath: null, logDigest: null, attemptId: 'a1', stdout: 'huge transcript' }];
    assert.equal(questEvidence({ config: project.config, quest: { id: 'EV-18', assignee: attempt({ hooks: smuggled }) } }).items[2].state, 'unknown');

    const badState = [{ state: 'succeeded', commandRef: 'npm test', startedAt: null, endedAt: null, exitCode: 0, logPath: null, logDigest: null, attemptId: 'a1' }];
    assert.equal(questEvidence({ config: project.config, quest: { id: 'EV-19', assignee: attempt({ hooks: badState }) } }).items[2].state, 'unknown');
  });
});
