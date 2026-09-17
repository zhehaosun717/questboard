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
