// FB2-10 item 4: a stalled card's 查看启动日志 reads the dispatch step log (<dataDir>/dispatch/<name>.log),
// capped at the last 100 lines of the last 64 KiB, never the whole file.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture } from './fixture.js';

let fx;
before(async () => {
  fx = await startFixture();
  fx.project.write('docs/briefs/DL-1-x.md', '# DL-1');
  assert.equal((await fx.api('/api/quests', 'POST', { package: 'DL-1', brief: 'docs/briefs/DL-1-x.md' })).status, 201);
  assert.equal((await fx.api('/api/quests/DL-1/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
});
after(() => fx.close());

describe('GET /api/quests/:id/dispatch-log (FB2-10 item 4)', () => {
  it('returns the last 100 lines and flags truncation', async () => {
    const quest = (await fx.api('/api/quests')).body.quests.find((q) => q.id === 'DL-1');
    const dir = path.join(fx.project.config.paths.data, 'dispatch');
    fs.mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: 150 }, (_, i) => 'step log line ' + (i + 1));
    fs.writeFileSync(path.join(dir, quest.assignee.name + '.log'), lines.join('\n') + '\n');
    const res = await fx.api('/api/quests/DL-1/dispatch-log');
    assert.equal(res.status, 200);
    assert.equal(res.body.lines.length, 100);
    assert.equal(res.body.lines.at(-1), 'step log line 150');
    assert.equal(res.body.truncated, true);
  });

  it('404 with a reason when the attempt has no log file, and for an unknown quest', async () => {
    const res = await fx.api('/api/quests/DL-1/dispatch-log');
    // previous test wrote the log; remove it to prove the loud miss
    const quest = (await fx.api('/api/quests')).body.quests.find((q) => q.id === 'DL-1');
    const file = path.join(fx.project.config.paths.data, 'dispatch', quest.assignee.name + '.log');
    fs.rmSync(file);
    const missing = await fx.api('/api/quests/DL-1/dispatch-log');
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /没有启动日志/);
    assert.equal((await fx.api('/api/quests/NOPE-9/dispatch-log')).status, 404);
    void res;
  });
});
