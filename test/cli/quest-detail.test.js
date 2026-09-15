// QB-FB-F: questboard get / show / release and the board author default, run as real CLI
// subprocesses against a temporary server (not-found, refused and dead-server cases included).
// The calls are async on purpose: spawnSync would freeze this process's event loop and the
// in-process fixture server could never answer the child.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture, tick } from '../server/fixture.js';

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
  fx = await startFixture();
  fx.project.write('docs/briefs/QD-1-read-me-once.md', '# QD-1\n\n## Files you may edit\n\n- `src/qd/a.js`\n');
  const posted = await fx.api('/api/quests', 'POST', { package: 'QD-1', brief: 'docs/briefs/QD-1-read-me-once.md' });
  assert.equal(posted.status, 201);
});
after(() => fx.close());

describe('questboard get', () => {
  it('reads one quest in concise readable lines', async () => {
    const got = await atBoard(['get', 'QD-1']);
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stdout, /^QD-1\s+posted\s+code\s/m);
    assert.match(got.stdout, /第 1 版/);
    assert.match(got.stdout, /可改文件: src\/qd\/a\.js/);
    assert.match(got.stdout, /可接手: .*codex-luna/);
  });

  it('--json prints the enriched quest for agents, and show is the same read', async () => {
    const got = await atBoard(['get', 'QD-1', '--json']);
    assert.equal(got.status, 0, got.stderr);
    const quest = JSON.parse(got.stdout);
    const direct = (await fx.api('/api/quests/QD-1')).body.quest;
    assert.deepEqual(quest, direct, 'the CLI shows the canonical enriched contract, nothing invented');
    assert.equal(quest.assignee, null);
    assert.deepEqual(quest.dispatches, []);
    assert.deepEqual(quest.threads, []);
    assert.ok(Array.isArray(quest.eligibility.canTake));
    assert.equal((await atBoard(['show', 'QD-1'])).status, 0);
  });

  it('flags never become the id, and a missing id shows usage', async () => {
    const late = await atBoard(['get', 'QD-1']);
    assert.equal(late.status, 0, late.stderr);
    const first = await cli(['get', '--project', fx.project.root, '--url', fx.base, 'QD-1']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /QD-1\s+posted/);
    const noId = await cli(['get', '--project', fx.project.root, '--url', fx.base]);
    assert.equal(noId.status, 1);
    assert.match(noId.stderr, /usage: questboard get/);
  });

  it('a missing quest and a dead server both fail loudly with clear words', async () => {
    const missing = await atBoard(['get', 'NOPE-1']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /quest not found/);
    const dead = await cli(['get', 'QD-1', '--project', fx.project.root, '--url', 'http://127.0.0.1:1']);
    assert.equal(dead.status, 1);
    assert.match(dead.stderr, /not running at http:\/\/127\.0\.0\.1:1/);
  });
});

describe('questboard release', () => {
  before(async () => {
    fx.project.write('docs/briefs/REL-1-silent-worker.md', 'x');
    await fx.api('/api/quests', 'POST', { package: 'REL-1', brief: 'docs/briefs/REL-1-silent-worker.md' });
    assert.equal((await fx.api('/api/quests/REL-1/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
    await tick();
  });

  it('demands --detail evidence before asking the server for anything', async () => {
    const noFlag = await atBoard(['release', 'REL-1']);
    assert.equal(noFlag.status, 1);
    assert.match(noFlag.stderr, /--detail/);
    const blank = await atBoard(['release', 'REL-1', '--detail', '   ']);
    assert.equal(blank.status, 1);
    assert.match(blank.stderr, /沉默不等于离开/);
    const noId = await cli(['release', '--detail', 'checked ps', '--project', fx.project.root, '--url', fx.base]);
    assert.equal(noId.status, 1);
    assert.match(noId.stderr, /usage: questboard release/);
    assert.notEqual(fx.events().at(-1).event, 'released', 'the CLI asked the server for no release at all');
  });

  it('refuses a flag token as the --detail evidence before touching the network', async () => {
    const before = fx.events().length;
    const flagAsDetail = await atBoard(['release', 'REL-1', '--detail', '--by', 'x']);
    assert.equal(flagAsDetail.status, 1);
    assert.match(flagAsDetail.stderr, /--detail/);
    // REL-1 is running here, so a request that reached the server would answer with its own refusal.
    assert.doesNotMatch(flagAsDetail.stderr, /running; cancel/, 'the server was never asked');
    const dead = await cli(['release', 'REL-1', '--detail', '--by', 'x', '--project', fx.project.root, '--url', 'http://127.0.0.1:1']);
    assert.equal(dead.status, 1);
    assert.match(dead.stderr, /--detail/);
    assert.doesNotMatch(dead.stderr, /not running at/, 'the rejection happened before opening a socket');
    assert.equal(fx.events().length, before, 'a rejected release emits no event');
  });

  it('refuses a running quest with the servers own words and frees it only after a confirmed stall', async () => {
    const tooEarly = await atBoard(['release', 'REL-1', '--detail', 'ps shows nothing']);
    assert.equal(tooEarly.status, 1);
    assert.match(tooEarly.stderr, /running; cancel it instead of releasing/);
    await fx.api('/api/quests/REL-1/status', 'POST', { status: 'stalled', detail: 'no output' });
    const done = await cli(['release', '--project', fx.project.root, '--url', fx.base, '--detail', '进程已确认退出', 'REL-1']);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /REL-1\s+stalled/);
    const quest = (await fx.api('/api/quests/REL-1')).body.quest;
    assert.equal(quest.assignee, null, 'the freed quest keeps no worker');
    assert.equal(quest.lastDetail, '进程已确认退出');
    const last = fx.events().at(-1);
    assert.deepEqual([last.event, last.detail], ['released', '进程已确认退出']);
  });
});

describe('board author default', () => {
  it('fills a missing author with coordinator at the CLI boundary only', async () => {
    assert.equal((await atBoard(['board', 'post', '--title', 'QD-1 which lane', '--body', '该用哪张卡'])).status, 0);
    const thread = fx.server.boardStore.listThreads({}).find((t) => t.title === 'QD-1 which lane');
    assert.equal(thread.author, 'coordinator');
    assert.equal((await atBoard(['board', 'reply', '--thread', thread.id, '--body', '补充一句'])).status, 0);
    const read = await fx.api(`/api/threads/${thread.id}`);
    assert.equal(read.body.messages.at(-1).author, 'coordinator');
    assert.equal((await atBoard(['board', 'post', '--title', 'QD-1 noted', '--body', 'b', '--author', 'worker-1'])).status, 0);
    assert.equal(fx.server.boardStore.listThreads({}).find((t) => t.title === 'QD-1 noted').author, 'worker-1');
    const refused = await fx.api('/api/threads', 'POST', { title: 'no-author', body: 'b' });
    assert.equal(refused.status, 400, 'the HTTP API still requires an author; the default lives in the CLI');
  });
});
