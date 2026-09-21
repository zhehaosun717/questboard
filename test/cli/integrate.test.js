// FB2-13 item 2: questboard integrate <id> as a real CLI subprocess against a real git project — merges
// the patch into the main tree and prints what landed; the refusal path names why.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture, tick } from '../server/fixture.js';

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'questboard.js');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { timeout: 20000, env: { ...process.env, QUESTBOARD_PROJECT: '', QUESTBOARD_URL: '' } });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code === undefined ? 1 : error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

let fx;
const atBoard = (args) => cli([...args, '--project', fx.project.root, '--url', fx.base]);
before(async () => {
  fx = await startFixture({ projectOverrides: { policy: { worktrees: { enabled: true } } } });
  git(fx.project.root, ['init', '-q']);
  git(fx.project.root, ['config', 'core.autocrlf', 'false']);
  git(fx.project.root, ['add', '.']);
  git(fx.project.root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  fx.project.write('docs/briefs/CLI-1-x.md', '# CLI-1');
  fx.project.write('docs/briefs/CLI-2-x.md', '# CLI-2');
  assert.equal((await fx.api('/api/quests', 'POST', { package: 'CLI-1', brief: 'docs/briefs/CLI-1-x.md' })).status, 201);
  assert.equal((await fx.api('/api/quests', 'POST', { package: 'CLI-2', brief: 'docs/briefs/CLI-2-x.md' })).status, 201);
  assert.equal((await fx.api('/api/quests/CLI-1/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
  await tick();
});
after(() => fx.close());

describe('questboard integrate (FB2-13 item 2)', () => {
  it('merges the worktree patch and prints the landed files', async () => {
    const quest = fx.server.store.get('CLI-1');
    const copy = quest.assignee.worktree.path;
    fs.writeFileSync(path.join(copy, 'feature.ts'), 'export const x = 1;\n');
    fx.holder.lanes = { packages: [{ name: quest.assignee.name, package: 'CLI-1', lane: quest.assignee.lane, model: quest.assignee.model, state: 'delivered', dispatchedAt: quest.assignee.at, lastText: 'done' }] };
    fx.server.questRoutes.applyLanes();
    const start = Date.now();
    while (fx.server.store.get('CLI-1').status !== 'delivered') {
      if (Date.now() - start > 8000) throw new Error('timed out waiting for delivered');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const result = await atBoard(['integrate', 'CLI-1', '--by', 'owner']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /已合入 1 个文件：feature\.ts/);
    assert.equal(fs.readFileSync(path.join(fx.project.root, 'feature.ts'), 'utf8'), 'export const x = 1;\n');
    assert.ok(!fs.existsSync(copy), 'the copy is removed');
  });

  it('nothing to integrate exits nonzero and names why', async () => {
    const result = await atBoard(['integrate', 'CLI-2']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /没有可合入的 patch/);
  });
});
