// FB2-13 item 2: POST /api/quests/:id/integrate — applies the latest worktree patch to the main tree,
// removes the copy, emits integrate. Real git fixture on purpose.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture, tick } from './fixture.js';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const waitFor = async (predicate, what, timeoutMs = 8000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

let fx;
before(async () => {
  fx = await startFixture({ projectOverrides: { policy: { worktrees: { enabled: true } } } });
  git(fx.project.root, ['init', '-q']);
  git(fx.project.root, ['config', 'core.autocrlf', 'false']);
  git(fx.project.root, ['add', '.']);
  git(fx.project.root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  fx.project.write('docs/briefs/INT-1-x.md', '# INT-1');
  assert.equal((await fx.api('/api/quests', 'POST', { package: 'INT-1', brief: 'docs/briefs/INT-1-x.md' })).status, 201);
  assert.equal((await fx.api('/api/quests/INT-1/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
  await tick();
});
after(() => fx.close());

describe('POST /api/quests/:id/integrate (FB2-13 item 2)', () => {
  it('applies the patch, removes the copy, emits integrate; unknown quest is 404', async () => {
    const quest = fx.server.store.get('INT-1');
    const worktree = quest.assignee.worktree;
    assert.ok(worktree, 'the snapshot carries the worktree record');
    const copy = worktree.path;
    // The worker edits the copy only: a new file plus a change to a tracked one.
    fx.project.write('src/kept.js', 'export const kept = 1;\n');
    git(fx.project.root, ['add', 'src/kept.js']);
    git(fx.project.root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'add kept']);
    // careful: the copy was made at the FIRST commit, before src/kept.js existed
    fs.mkdirSync(path.join(copy, 'src'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'src', 'feature.js'), 'export const feature = true;\n');
    // Editing the copied brief or config is dispatch scaffolding, never part of the patch.
    fs.writeFileSync(path.join(copy, 'docs', 'briefs', 'INT-1-x.md'), '# INT-1 edited\n');
    fx.holder.lanes = { packages: [{ name: quest.assignee.name, package: 'INT-1', lane: quest.assignee.lane, model: quest.assignee.model, state: 'delivered', dispatchedAt: quest.assignee.at, lastText: 'done' }] };
    fx.server.questRoutes.applyLanes();
    await waitFor(() => fx.server.store.get('INT-1').status === 'delivered', 'delivered');
    const ok = await fx.api('/api/quests/INT-1/integrate', 'POST', { by: 'owner' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.integrated.files, ['src/feature.js'], 'only the worker edit lands; the copied brief/config stay out');
    assert.equal(fs.readFileSync(path.join(fx.project.root, 'src', 'feature.js'), 'utf8'), 'export const feature = true;\n');
    assert.ok(!fs.existsSync(copy), 'the copy is gone');
    assert.ok(fx.events().some((event) => event.event === 'integrate' && event.package === 'INT-1'), 'integrate event recorded');
    assert.equal((await fx.api('/api/quests/NOPE-9/integrate', 'POST', { by: 'owner' })).status, 404);
  });
});
