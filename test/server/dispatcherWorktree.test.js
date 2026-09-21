// FB2-13 (条目 29): worktree dispatch. When policy.worktrees.enabled and the project is a git repo, each
// attempt gets its own detached worktree; the wrapper's cwd is the copy; the copied questboard.config.json
// has its registry rewritten to the MAIN project's absolute registry (the wrapper resolves config
// cwd-relative, and the copy only holds tracked files); the brief is copied in at the same relative path.
// Disabled means byte-identical old behaviour. Real git on purpose — the fixture is a real repository.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { createCollector } from '../../src/lanes/collector.js';
import { appendJsonLine } from '../../src/core/jsonl.js';
import { makeProject, card } from '../helpers.js';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function gitProject({ worktrees = { enabled: true } } = {}) {
  const { root, config, write } = makeProject({ policy: { worktrees } });
  write('src/app.js', 'export const v = 1;\n');
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return { root, config, write };
}

function runnersSpy() {
  const calls = [];
  return {
    calls,
    runners: {
      run: async (step, context) => { calls.push({ step, context }); return { code: 0 }; },
      session: async (step, context) => { calls.push({ step, context }); return { code: 0, session: 'ses_x' }; },
    },
  };
}

describe('dispatcher worktree dispatch (FB2-13 item 1)', () => {
  it('creates a detached worktree per attempt and runs the steps inside it', async () => {
    const { root, config, write } = gitProject();
    const store = new QuestStore(config);
    const { calls, runners } = runnersSpy();
    const dispatcher = createDispatcher({ config, store, runners });
    write('docs/briefs/WT-1-x.md', '# WT-1');
    store.post({ package: 'WT-1', brief: 'docs/briefs/WT-1-x.md', by: 'owner' });
    assert.equal(dispatcher.assign('WT-1', card('codex-luna'), 'owner').status, 200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const quest = store.get('WT-1');
    const worktree = quest.assignee.worktree;
    assert.ok(worktree, 'attempt carries the worktree record');
    const dir = path.join(root, '.qb-worktrees', quest.assignee.name);
    assert.equal(worktree.path, dir);
    assert.equal(worktree.base, git(root, ['rev-parse', 'HEAD']), 'base is the HEAD sha at dispatch time');
    assert.ok(fs.existsSync(path.join(dir, 'src', 'app.js')), 'tracked files are checked out in the copy');
    assert.ok(fs.existsSync(path.join(dir, 'questboard.config.json')), 'the config is copied into the copy');
    const copiedConfig = JSON.parse(fs.readFileSync(path.join(dir, 'questboard.config.json'), 'utf8'));
    assert.equal(copiedConfig.registry, config.paths.registry, 'registry points at the MAIN project registry, absolutely');
    assert.ok(fs.existsSync(path.join(dir, 'docs', 'briefs', 'WT-1-x.md')), 'the brief is copied in at the same relative path');
    assert.equal(calls.at(-1).context.cwd, dir, 'the run step spawns inside the copy');
    assert.deepEqual(quest.dispatches.at(-1).worktree, worktree, 'dispatch history mirrors the record');
  });

  it('a redo attempt gets a fresh copy, never the old one (art reruns too, item 3)', async () => {
    const { root, config, write } = gitProject();
    const store = new QuestStore(config);
    const { runners } = runnersSpy();
    const dispatcher = createDispatcher({ config, store, runners });
    write('docs/briefs/WT-2-x.md', '# WT-2');
    store.post({ package: 'WT-2', brief: 'docs/briefs/WT-2-x.md', by: 'owner' });
    dispatcher.assign('WT-2', card('codex-luna'), 'owner');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const first = store.get('WT-2').assignee.worktree.path;
    store.setStatus('WT-2', 'failed', { detail: 'redo', by: 'owner', ack: true });
    dispatcher.assign('WT-2', card('codex-luna'), 'owner');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = store.get('WT-2').assignee.worktree.path;
    assert.notEqual(first, second);
    assert.ok(fs.existsSync(first) && fs.existsSync(second), 'both copies exist on disk');
  });

  it('enabled on a non-git project settles the attempt as failed with the reason named, nothing spawned', async () => {
    const { config, write } = makeProject({ policy: { worktrees: { enabled: true } } });
    const store = new QuestStore(config);
    const { calls, runners } = runnersSpy();
    const dispatcher = createDispatcher({ config, store, runners });
    write('docs/briefs/WT-3-x.md', '# WT-3');
    store.post({ package: 'WT-3', brief: 'docs/briefs/WT-3-x.md', by: 'owner' });
    const result = dispatcher.assign('WT-3', card('codex-luna'), 'owner');
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error, 'worktree_failed_after_assign');
    assert.equal(result.body.settled, true);
    const quest = store.get('WT-3');
    assert.equal(quest.status, 'failed');
    assert.match(quest.lastDetail, /git|worktree/);
    assert.equal(calls.length, 0, 'no step ever spawned');
  });

  it('disabled (default) changes nothing: no worktree record, steps run in the project root', async () => {
    const { root, config, write } = gitProject({ worktrees: { enabled: false } });
    const store = new QuestStore(config);
    const { calls, runners } = runnersSpy();
    const dispatcher = createDispatcher({ config, store, runners });
    write('docs/briefs/WT-4-x.md', '# WT-4');
    store.post({ package: 'WT-4', brief: 'docs/briefs/WT-4-x.md', by: 'owner' });
    assert.equal(dispatcher.assign('WT-4', card('codex-luna'), 'owner').status, 200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const quest = store.get('WT-4');
    assert.equal(quest.assignee.worktree, undefined);
    assert.equal(calls.at(-1).context.cwd, root);
  });

  it('the collector reads artifacts from the copy; the registry row stays main-side', async () => {
    const { root, config, write } = gitProject();
    const store = new QuestStore(config);
    const { runners } = runnersSpy();
    const dispatcher = createDispatcher({ config, store, runners });
    write('docs/briefs/WT-5-x.md', '# WT-5');
    store.post({ package: 'WT-5', brief: 'docs/briefs/WT-5-x.md', by: 'owner' });
    dispatcher.assign('WT-5', card('codex-luna'), 'owner');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const quest = store.get('WT-5');
    const copyPath = quest.assignee.worktree.path;
    appendJsonLine(config.paths.registry, { at: new Date().toISOString(), event: 'dispatch', package: 'WT-5', lane: 'codex', model: 'gpt-5.6-luna', variant: 'high', name: quest.assignee.name });
    const outDir = path.join(copyPath, '.work', 'codex');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, quest.assignee.name + '.out'), 'working in the copy\n');
    const { packages } = await createCollector(config).collect();
    const row = packages.find((entry) => entry.package === 'WT-5');
    assert.equal(row.state, 'running', "the copy's .out makes the worker visible");
    assert.ok(!fs.existsSync(path.join(root, '.work')), 'the main tree has no artifacts at all');
  });
});
