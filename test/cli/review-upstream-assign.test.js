// Suggestion S3: `questboard assign` on a review quest prints the same upstream warning/refusal text the
// board's own drop preview shows, before ever calling the server's assign route (never fabricates a pass by
// staying silent, never proceeds past a refusal it already knows about).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture, tick } from '../server/fixture.js';
import { captureAttemptReport } from '../../src/core/reportEvidence.js';
import fs from 'node:fs';

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'questboard.js');
let fx;
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { timeout: 20000, env: { ...process.env, QUESTBOARD_PROJECT: '', QUESTBOARD_URL: '' } });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code === undefined ? 1 : error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}
const atBoard = (args) => cli([...args, '--project', fx.project.root, '--url', fx.base]);

before(async () => {
  fx = await startFixture({ projectOverrides: { policy: { reviewRequires: ['project-verification'] }, verification: { progressDirs: ['.work/full'] } } });
  fx.project.write('docs/briefs/RUN-1-x.md', 'RUN-1');
  assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' })).status, 201);
  assert.equal((await fx.api('/api/quests/RUN-1/assign', 'POST', { adventurer: 'oc-mimo' })).status, 200);
  await tick();
  const store = fx.server.store;
  const name = store.get('RUN-1').assignee.name;
  fs.mkdirSync(path.join(fx.project.root, '.work', 'oc'), { recursive: true });
  fx.project.write(`.work/oc/${name}.md`, 'VERDICT: PASS\n');
  const report = captureAttemptReport({ config: fx.project.config, quest: store.get('RUN-1') });
  store.setStatus('RUN-1', 'delivered', { detail: 'done', by: 'lanes', report, source: 'collector', evidence: { kind: 'collector', attemptId: store.get('RUN-1').assignee.attemptId } });
  const posted = await fx.api('/api/quests/RUN-1/review', 'POST', { note: '看一下' });
  assert.equal(posted.status, 201, posted.text);
});
after(() => fx.close());

describe('questboard assign — review upstream text', () => {
  it('refuses locally with the upstream_unverified text, never calling assign at all', async () => {
    const done = await atBoard(['assign', 'REVIEW-RUN-1', '--adventurer', 'agy-gemini']);
    assert.equal(done.status, 1, done.stdout + done.stderr);
    assert.match(done.stderr, /拒绝派遣/);
    assert.match(done.stderr, /upstream_unverified/);
    assert.match(done.stderr, /项目测试缺失/);
    const quest = (await fx.api('/api/quests/REVIEW-RUN-1')).body.quest;
    assert.equal(quest.assignee, null, 'the refused local check never reached the server\'s assign route');
  });

  it('prints the warning and actually assigns once a recorded override lifts the block', async () => {
    assert.equal((await fx.api('/api/quests/REVIEW-RUN-1/review-override', 'POST', { reason: '手工确认过' })).status, 200);
    const done = await atBoard(['assign', 'REVIEW-RUN-1', '--adventurer', 'agy-gemini']);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /警告：.*（upstream_unverified）/);
    assert.match(done.stdout, /已记录例外/);
    const quest = (await fx.api('/api/quests/REVIEW-RUN-1')).body.quest;
    assert.equal(quest.assignee.adventurerId, 'agy-gemini');
  });

  // F4: once the server enforces the policy itself (F1), a failed local detail fetch is harmless — assign
  // still gets refused server-side if it should be — but staying silent about the failed pre-check would
  // read as "checked, nothing to warn about". An unreachable --url fails both the detail GET and the
  // eventual assign POST, so this proves the note prints without needing to fabricate a partial-failure server.
  it('F4: notes in Chinese that the local pre-check could not read the quest, when the detail fetch fails', async () => {
    const done = await cli(['assign', 'REVIEW-RUN-1', '--adventurer', 'agy-gemini', '--project', fx.project.root, '--url', 'http://127.0.0.1:1']);
    assert.equal(done.status, 1, done.stdout + done.stderr);
    assert.match(done.stdout, /没能读取委托详情/);
  });
});
