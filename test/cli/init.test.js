// `questboard init` is the whole setup for a new machine, so it has to produce a config the board actually
// accepts, and it must never quietly replace a project someone already has.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildConfig, commandExists, KNOWN_LANES, parseLaneFlag, runInit } from '../../src/cli/init.js';
import { resolveConfig } from '../../src/core/config.js';
import { loadRoster } from '../../src/core/roster.js';
import { tmpDir } from '../helpers.js';

const freshHome = () => {
  const dir = tmpDir('qb-init-home-');
  return { home: dir, roster: path.join(dir, 'roster.json'), status: path.join(dir, 'status.jsonl') };
};
const installed = (...names) => (binary) => names.includes(binary);

describe('questboard init', () => {
  it('writes a config the board accepts, with the wrapper, a brief and an empty roster', () => {
    const dir = path.join(tmpDir('qb-init-'), 'my-game');
    const home = freshHome();
    const result = runInit({ dir, home, exists: installed('codex', 'claude') });

    assert.deepEqual(result.lanes, ['codex', 'claude']);
    assert.equal(result.rosterCreated, true);
    assert.deepEqual(loadRoster(home.roster), { adventurers: [] });
    for (const file of ['questboard.config.json', 'scripts/run-worker.mjs', 'docs/briefs/RUN-1-first-task.md']) {
      assert.ok(fs.existsSync(path.join(dir, file)), `${file} missing`);
    }
    assert.ok(fs.existsSync(path.join(dir, 'docs/review')));

    // The real validator, not a copy of the shape: init must not produce a project the server refuses.
    const raw = JSON.parse(fs.readFileSync(result.configFile, 'utf8'));
    const config = resolveConfig(dir, raw);
    assert.equal(config.name, 'my-game');
    assert.equal(config.port, 6097);
    assert.deepEqual(Object.keys(config.lanes), ['codex', 'claude']);
    assert.equal(config.lanes.claude.editCounter, 'stream-json');
    // The brief travels on stdin: codex reads it only when no prompt argument follows the model.
    assert.deepEqual(config.lanes.codex.run.slice(-5), ['--', 'codex', 'exec', '-m', '{model}']);
    assert.ok(config.lanes.codex.run.includes('scripts/run-worker.mjs'));
  });

  it('names the project and port from the flags, and reports CLIs whose lane must be written by hand', () => {
    const dir = tmpDir('qb-init-named-');
    const result = runInit({ dir, name: 'Friend Game', port: 6200, home: freshHome(), exists: installed('claude', 'opencode', 'agy') });
    assert.deepEqual(result.detected, ['claude']);
    assert.deepEqual(result.manual, ['opencode', 'agy']);
    const config = resolveConfig(dir, JSON.parse(fs.readFileSync(result.configFile, 'utf8')));
    assert.equal(config.name, 'Friend Game');
    assert.equal(config.port, 6200);
    assert.deepEqual(Object.keys(config.lanes), ['claude'], 'no lane is written for a CLI we cannot drive');
  });

  it('still writes usable lanes when no agent CLI is installed yet', () => {
    const dir = tmpDir('qb-init-empty-');
    const result = runInit({ dir, home: freshHome(), exists: () => false });
    assert.deepEqual(result.detected, []);
    assert.deepEqual(result.lanes, KNOWN_LANES.map((l) => l.id));
  });

  it('refuses to overwrite an existing project unless forced, and keeps files already there', () => {
    const dir = tmpDir('qb-init-existing-');
    const home = freshHome();
    runInit({ dir, home, exists: installed('codex') });
    const brief = path.join(dir, 'docs/briefs/RUN-1-first-task.md');
    fs.writeFileSync(brief, 'my own brief');
    assert.throws(() => runInit({ dir, home, exists: installed('codex') }), /exists/);
    runInit({ dir, name: 'Renamed', force: true, home, exists: installed('codex') });
    assert.equal(fs.readFileSync(brief, 'utf8'), 'my own brief', 'a brief already written is not replaced');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'questboard.config.json'), 'utf8')).name, 'Renamed');
  });

  it('writes a lane for whatever tool the owner names, without needing it to be known or installed', () => {
    const dir = tmpDir('qb-init-own-');
    const result = runInit({
      dir,
      home: freshHome(),
      exists: installed('opencode'),
      extraLanes: [parseLaneFlag('aider=aider --model {model} --yes'), parseLaneFlag('opencode=opencode run {model}')],
    });
    assert.deepEqual(result.custom, ['aider', 'opencode']);
    assert.deepEqual(result.detected, [], 'nothing known was installed');
    assert.deepEqual(result.manual, [], 'a CLI the owner gave a lane for is not reported as needing one');
    const config = resolveConfig(dir, JSON.parse(fs.readFileSync(result.configFile, 'utf8')));
    assert.deepEqual(Object.keys(config.lanes), ['aider', 'opencode']);
    assert.deepEqual(config.lanes.aider.run.slice(-5), ['--', 'aider', '--model', '{model}', '--yes']);
    assert.ok(!Object.keys(config.lanes).includes('codex'), 'named lanes replace the built-in guesses');
  });

  it('names a lane and refuses a broken one', () => {
    assert.deepEqual(parseLaneFlag('aider=aider --model {model}'), { id: 'aider', agentArgs: ['aider', '--model', '{model}'], custom: true });
    assert.equal(parseLaneFlag('x=  my-tool   run  ').agentArgs.join(' '), 'my-tool run');
    for (const bad of ['aider', '=aider', 'Aider=aider', '9x=aider', 'my lane=aider', 'aider=']) {
      assert.throws(() => parseLaneFlag(bad), /--lane|lane name|has no command/, bad);
    }
  });

  it('lets a named lane win over the same CLI detected on the machine', () => {
    const dir = tmpDir('qb-init-override-');
    const result = runInit({ dir, home: freshHome(), exists: installed('codex', 'claude'), extraLanes: [parseLaneFlag('codex=codex exec --full-auto -m {model}')] });
    assert.deepEqual(result.lanes, ['claude', 'codex']);
    const config = resolveConfig(dir, JSON.parse(fs.readFileSync(result.configFile, 'utf8')));
    assert.ok(config.lanes.codex.run.includes('--full-auto'));
  });

  it('builds lanes only from templates, and detects commands without a shell', () => {
    const config = buildConfig({ name: 'x', lanes: KNOWN_LANES });
    for (const lane of Object.values(config.lanes)) assert.equal(lane.run[0], 'node');
    const calls = [];
    const run = (file, args) => { calls.push([file, args]); return { status: args[0] === 'here' ? 0 : 1 }; };
    assert.equal(commandExists('here', { platform: 'linux', run }), true);
    assert.equal(commandExists('nope', { platform: 'linux', run }), false);
    assert.deepEqual(calls.map((c) => c[0]), ['which', 'which']);
    assert.equal(commandExists('x', { platform: 'win32', run: () => { throw new Error('no such tool'); } }), false);
  });
});
