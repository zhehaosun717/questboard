// questboard assign — with no --adventurer the CLI falls back to the 派遣规则 defaultCard (feedback 38), says which
// card it picked and why, and an explicit card always wins. --by owner on purpose: FB2-12 item 3 limits the
// coordinator's own assign to the machine-check fast track, and these cases are the owner dispatching. Run as a real CLI subprocess against a
// temporary server (see quest-detail.test.js for why this is async, not sync).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../server/fixture.js';
import { LANES } from '../helpers.js';

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
  fx = await startFixture({ projectOverrides: { policy: { defaultCard: 'oc-mimo' } } });
  for (const id of ['AS-1', 'AS-2', 'AS-3']) fx.project.write(`docs/briefs/${id}-x.md`, `${id} — x`);
  for (const id of ['AS-1', 'AS-2', 'AS-3']) {
    const posted = await fx.api('/api/quests', 'POST', { package: id, brief: `docs/briefs/${id}-x.md` });
    assert.equal(posted.status, 201, `${id} should post`);
  }
});
after(() => fx.close());

describe('questboard assign default card', () => {
  it('uses the 派遣规则 default card when no --adventurer is given, and says which card and why', async () => {
    const done = await atBoard(['assign', 'AS-1', '--by', 'owner']);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /没指定卡，用派遣规则里的默认卡「oc-mimo」/);
    const quest = (await fx.api('/api/quests/AS-1')).body.quest;
    assert.equal(quest.assignee.model, 'xiaomi/mimo-v2.5-pro', 'the default card真正拿到了这个任务');
  });

  it('an explicit --adventurer always wins over the preference', async () => {
    const done = await atBoard(['assign', 'AS-2', '--adventurer', 'codex-luna', '--by', 'owner']);
    assert.equal(done.status, 0, done.stderr);
    assert.ok(!done.stdout.includes('没指定卡'), 'no preference notice when the owner named a card themselves');
    const quest = (await fx.api('/api/quests/AS-2')).body.quest;
    assert.equal(quest.assignee.model, 'gpt-5.6-luna');
  });

  it('with neither a card flag nor a configured default card the old refusal path stays', async () => {
    fx.project.write('questboard.config.json', JSON.stringify({ name: 'Test Game', lanes: LANES, briefs: { ownerDirs: ['docs/design'] } }, null, 2));
    const done = await atBoard(['assign', 'AS-3', '--by', 'owner']);
    assert.equal(done.status, 1);
    assert.ok(!done.stdout.includes('没指定卡'));
  });

  it('a default card that is not in the roster fails with the same Chinese sentence the header shows', async () => {
    fx.project.write('questboard.config.json', JSON.stringify({ name: 'Test Game', lanes: LANES, briefs: { ownerDirs: ['docs/design'] }, policy: { defaultCard: 'ghost-card' } }, null, 2));
    const done = await atBoard(['assign', 'AS-3', '--by', 'owner']);
    assert.equal(done.status, 1);
    assert.match(done.stdout, /没指定卡，用派遣规则里的默认卡「ghost-card」/);
    assert.match(done.stderr, /默认卡「ghost-card」不在名册里，去「派遣规则」改掉，或先把卡补进名册。/);
    assert.ok(!`${done.stdout}${done.stderr}`.includes('no adventurer'), 'the server’s bare English refusal must not reach the owner');
  });
});
