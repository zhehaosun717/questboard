// questboard update — a revision-guarded correction of a posted quest's own descriptive fields, run as a
// real CLI subprocess against a temporary server (see quest-detail.test.js for why this is async, not sync).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../server/fixture.js';

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
  fx.project.write('docs/briefs/UPD-1-x.md', 'UPD-1 — x');
  const posted = await fx.api('/api/quests', 'POST', { package: 'UPD-1', brief: 'docs/briefs/UPD-1-x.md', title: 'old title' });
  assert.equal(posted.status, 201);
});
after(() => fx.close());

describe('questboard update', () => {
  it('sends only the flags given, and prints the corrected quest', async () => {
    const done = await atBoard(['update', 'UPD-1', '--title', 'new title', '--by', 'owner']);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /^UPD-1\s+posted\s+code\s+new title/m);
    const direct = (await fx.api('/api/quests/UPD-1')).body.quest;
    assert.equal(direct.title, 'new title');
    assert.equal(fx.events().at(-1).by, 'owner');
  });

  it('defaults --by to owner, distinct from the coordinator default other commands use', async () => {
    await atBoard(['update', 'UPD-1', '--title', 'still another title']);
    assert.equal(fx.events().at(-1).by, 'owner');
  });

  it('surfaces the server\'s own refusal text for an invalid candidate, without sending a bare flag as the id', async () => {
    const bad = await atBoard(['update', 'UPD-1', '--parents', 'GHOST-1']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /GHOST-1 not found/);
    const noId = await cli(['update', '--title', 'x', '--project', fx.project.root, '--url', fx.base]);
    assert.equal(noId.status, 1);
    assert.match(noId.stderr, /usage: questboard update/);
  });

  it('surfaces a stale-revision refusal from the server', async () => {
    const revision = (await fx.api('/api/quests/UPD-1')).body.quest.revision;
    const stale = await atBoard(['update', 'UPD-1', '--title', 'x', '--if-revision', String(revision - 1)]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /stale/);
  });

  it('surfaces the server\'s review-ancestry refusal for a posted review, and lets ordinary parent repair through', async () => {
    fx.project.write('docs/briefs/RA-4-x.md', 'RA-4 — x');
    fx.project.write('docs/briefs/RA-5-x.md', 'RA-5 — x');
    await fx.api('/api/quests', 'POST', { package: 'RA-4', brief: 'docs/briefs/RA-4-x.md' });
    await fx.api('/api/quests', 'POST', { package: 'RA-5', kind: 'review', brief: 'docs/briefs/RA-5-x.md', parents: 'RA-4' });
    const cleared = await atBoard(['update', 'RA-5', '--parents', '']);
    assert.equal(cleared.status, 1);
    assert.match(cleared.stderr, /RA-5 is a posted review/);
    const stillLinked = (await fx.api('/api/quests/RA-5')).body.quest;
    assert.deepEqual(stillLinked.parents, ['RA-4']);
    // An ordinary (non-review) quest's parent is still freely repairable through the same command.
    const ok = await atBoard(['update', 'UPD-1', '--parents', 'RA-4']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual((await fx.api('/api/quests/UPD-1')).body.quest.parents, ['RA-4']);
  });
});

describe('questboard batch (FB2-04 item 5)', () => {
  it('marks every listed quest with the batch roster and the waitingOn target', async () => {
    for (const id of ['BAT-1', 'BAT-2', 'BAT-3']) {
      fx.project.write(`docs/briefs/${id}-x.md`, `${id} — x`);
      const posted = await fx.api('/api/quests', 'POST', { package: id, brief: `docs/briefs/${id}-x.md` });
      assert.equal(posted.status, 201);
    }
    const done = await atBoard(['batch', 'BAT-1,BAT-2', '--waiting-on', 'BAT-3']);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /^BAT-1\s/m);
    assert.match(done.stdout, /^BAT-2\s/m);
    assert.match(done.stdout, /等 BAT-3/);
    for (const [id, mates] of [['BAT-1', ['BAT-2']], ['BAT-2', ['BAT-1']]]) {
      const quest = (await fx.api(`/api/quests/${id}`)).body.quest;
      assert.deepEqual(quest.batch, ['BAT-1', 'BAT-2']);
      assert.equal(quest.waitingOn, 'BAT-3');
    }
    const bat3 = (await fx.api('/api/quests/BAT-3')).body.quest;
    assert.equal(bat3.batch, undefined, 'the waitingOn target is not part of the batch unless listed');
  });

  it('refuses a single-card batch and says why', async () => {
    const bad = await atBoard(['batch', 'BAT-1']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr + bad.stdout, /一批至少两张/);
  });
});
