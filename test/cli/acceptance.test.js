// Feedback 15: `questboard status <id> done --evidence-ref ... --note ...` and `get <id> --evidence` showing
// the acceptance record, run as real CLI subprocesses against a temporary server.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture, tick } from '../server/fixture.js';
import { captureAttemptReport } from '../../src/core/reportEvidence.js';

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'questboard.js');
let fx;
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { timeout: 20000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, QUESTBOARD_PROJECT: '', QUESTBOARD_URL: '' } });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code === undefined ? 1 : error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}
const atBoard = (args) => cli([...args, '--project', fx.project.root, '--url', fx.base]);

before(async () => {
  fx = await startFixture();
  fx.project.write('docs/briefs/CA-1-x.md', 'brief');
  assert.equal((await fx.api('/api/quests', 'POST', { package: 'CA-1', brief: 'docs/briefs/CA-1-x.md' })).status, 201);
  assert.equal((await fx.api('/api/quests/CA-1/assign', 'POST', { adventurer: 'oc-mimo' })).status, 200);
  await tick();
  const store = fx.server.store;
  const name = store.get('CA-1').assignee.name;
  fs.mkdirSync(path.join(fx.project.root, '.work', 'oc'), { recursive: true });
  fx.project.write(`.work/oc/${name}.md`, 'VERDICT: PASS\n');
  const report = captureAttemptReport({ config: fx.project.config, quest: store.get('CA-1') });
  store.setStatus('CA-1', 'delivered', { detail: `交付已写入 .work/oc/${name}.md`, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attemptId: store.get('CA-1').assignee.attemptId }, report });
});
after(() => fx.close());

describe('questboard status done — acceptance (feedback 15)', () => {
  it('records a coordinator acceptance naming the matched evidence, --by defaults coordinator', async () => {
    const evidence = JSON.parse((await atBoard(['get', 'CA-1', '--evidence'])).stdout);
    assert.equal(evidence.acceptance, null, 'nothing accepted yet');
    const report = evidence.items.find((item) => item.kind === 'report');
    assert.equal(report.bound, true);

    const done = await atBoard([
      'status', 'CA-1', 'done', '--detail', 'coordinator 验收',
      '--evidence-ref', `kind=report,digest=${report.digest},attemptId=${report.attemptId}`,
      '--note', '看过报告了',
    ]);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /CA-1\s+done/);

    const after = JSON.parse((await atBoard(['get', 'CA-1', '--evidence'])).stdout);
    assert.deepEqual(after.acceptance, {
      actor: 'coordinator',
      evidenceRefs: [{ kind: 'report', ref: report.ref, digest: report.digest, attemptId: report.attemptId }],
      note: '看过报告了',
    });
  });

  it('a bad --evidence-ref is refused locally, before any request reaches the server', async () => {
    fx.project.write('docs/briefs/CA-2-x.md', 'brief');
    await fx.api('/api/quests', 'POST', { package: 'CA-2', brief: 'docs/briefs/CA-2-x.md' });
    const before = fx.events().length;
    const bad = await atBoard(['status', 'CA-2', 'done', '--evidence-ref', 'nokind=x']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--evidence-ref 格式不对/);
    assert.equal(fx.events().length, before, 'refused locally, nothing was sent');
  });

  it('--evidence-ref/--note are ignored for a non-done status', async () => {
    fx.project.write('docs/briefs/CA-3-x.md', 'brief');
    await fx.api('/api/quests', 'POST', { package: 'CA-3', brief: 'docs/briefs/CA-3-x.md' });
    const res = await atBoard(['status', 'CA-3', 'needs_owner', '--note', 'irrelevant here']);
    assert.equal(res.status, 0, res.stderr);
    const quest = (await fx.api('/api/quests/CA-3')).body.quest;
    assert.equal('acceptance' in quest, false);
  });
});

describe('questboard post --review (FB2-05)', () => {
  it('posts review=mechanical with its check command and shows the review mode', async () => {
    const posted = await atBoard(['post', '--package', 'CA-9', '--brief', 'docs/briefs/CA-1-x.md', '--review', 'mechanical', '--mechanical-check', 'npm test']);
    assert.equal(posted.status, 0, posted.stderr);
    assert.match(posted.stdout, /CA-9\s+posted/);
    assert.match(posted.stdout, /复核方式：交付后自动跑机械自检并记录结论/);
    const quest = (await fx.api('/api/quests/CA-9')).body.quest;
    assert.equal(quest.review, 'mechanical');
    assert.equal(quest.mechanicalCheck, 'npm test');
  });

  it('posts review=none and shows the coordinator handoff', async () => {
    const posted = await atBoard(['post', '--package', 'CA-10', '--brief', 'docs/briefs/CA-1-x.md', '--review', 'none']);
    assert.equal(posted.status, 0, posted.stderr);
    assert.match(posted.stdout, /复核方式：交付后等 coordinator 验证/);
    const quest = (await fx.api('/api/quests/CA-10')).body.quest;
    assert.equal(quest.review, 'none');
  });

  it('refuses --review mechanical without --mechanical-check, before any request', async () => {
    const before = fx.events().length;
    const posted = await atBoard(['post', '--package', 'CA-11', '--brief', 'docs/briefs/CA-1-x.md', '--review', 'mechanical']);
    assert.equal(posted.status, 1);
    assert.match(posted.stderr, /--review mechanical 需要 --mechanical-check/);
    assert.equal(fx.events().length, before, 'refused locally, nothing was sent');
  });

  it('refuses a bogus --review value and a stray --mechanical-check', async () => {
    const bogus = await atBoard(['post', '--package', 'CA-12', '--brief', 'docs/briefs/CA-1-x.md', '--review', 'sometimes']);
    assert.equal(bogus.status, 1);
    assert.match(bogus.stderr, /--review 只能是 none、mechanical 或 model/);
    const stray = await atBoard(['post', '--package', 'CA-13', '--brief', 'docs/briefs/CA-1-x.md', '--mechanical-check', 'npm test']);
    assert.equal(stray.status, 1);
    assert.match(stray.stderr, /--mechanical-check 只在 --review mechanical 时有效/);
  });
});

describe('questboard status/cancel/resolve flag shapes (FB2-06)', () => {
  before(async () => {
    fx.project.write('docs/briefs/CA-STAT-1.md', '# CA-STAT-1');
    const posted = await fx.api('/api/quests', 'POST', { package: 'CA-STAT-1', brief: 'docs/briefs/CA-STAT-1.md' });
    assert.equal(posted.status, 201);
    fx.project.write('docs/briefs/CA-CANCEL-1.md', '# CA-CANCEL-1');
    const cancelTarget = await fx.api('/api/quests', 'POST', { package: 'CA-CANCEL-1', brief: 'docs/briefs/CA-CANCEL-1.md' });
    assert.equal(cancelTarget.status, 201);
    assert.equal((await fx.api('/api/quests/CA-CANCEL-1/assign', 'POST', { adventurer: 'oc-mimo' })).status, 200);
  });

  it('status takes the value as a positional or as --status, and refuses a bogus value with a usage example', async () => {
    const positional = await atBoard(['status', 'CA-STAT-1', 'needs_owner', '--detail', '问一句']);
    assert.equal(positional.status, 0, positional.stderr);
    const flagged = await atBoard(['status', 'CA-STAT-1', '--status', 'reviewing', '--detail', '开始看']);
    assert.equal(flagged.status, 0, flagged.stderr);
    const quest = (await fx.api('/api/quests/CA-STAT-1')).body.quest;
    assert.equal(quest.status, 'reviewing');
    const bogus = await atBoard(['status', 'CA-STAT-1', 'frobnicated']);
    assert.equal(bogus.status, 1);
    assert.match(bogus.stderr, /usage: questboard status/);
    assert.match(bogus.stderr, /例：/);
  });

  it('cancel takes --detail as the reason (--reason and --detail are equivalent)', async () => {
    const requested = await atBoard(['cancel', 'CA-CANCEL-1', '--detail', 'owner 用旧写法取消']);
    assert.equal(requested.status, 0, requested.stderr);
    assert.match(requested.stdout, /取消结果：/);
  });
});
