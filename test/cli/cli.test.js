import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readNewLines } from '../../src/cli/watch.js';
import { option } from '../../src/cli/client.js';
import { loadRoster } from '../../src/core/roster.js';
import { StatusLog } from '../../src/core/status.js';
import { tmpDir } from '../helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'questboard.js');
const run = (args, env) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20000 });

describe('cli', () => {
  it('reads options by name', () => {
    assert.equal(option(['post', '--package', 'RUN-4'], '--package'), 'RUN-4');
    assert.equal(option(['post', '--package'], '--package'), undefined);
  });

  it('tails only new complete event lines', () => {
    const file = path.join(tmpDir('watch-'), 'events.jsonl');
    const state = { offset: 0, carry: '' };
    fs.writeFileSync(file, '{"event":"posted"}\n{"event":"assi');
    assert.deepEqual(readNewLines(file, state), ['{"event":"posted"}']);
    fs.appendFileSync(file, 'gned"}\n');
    assert.deepEqual(readNewLines(file, state), ['{"event":"assigned"}']);
    assert.deepEqual(readNewLines(file, state), []);
  });

  it('imports a legacy roster into the home roster and status log, reporting moved notes', () => {
    const home = tmpDir('cli-home-');
    const legacy = path.join(tmpDir('legacy-'), 'roster.json');
    fs.writeFileSync(legacy, JSON.stringify({
      policy: { bannedModelPatterns: ['-fast'], bannedAgents: ['Sisyphus'] },
      adventurers: [
        { id: 'codex-astra', name: 'Astra', provider: 'OpenAI Codex', lane: 'codex', model: 'gpt-6-astra', family: 'gpt-6-astra', status: 'paused', note: '像素画暂停，太费用量（owner 2026-09-12）' },
        { id: 'oc-luna', name: 'Luna', provider: 'OpenAI', lane: 'opencode', model: 'openai/gpt-5.6-luna', family: 'gpt-5.6-luna', status: 'available', note: '和 Codex 同一个订阅' },
      ],
    }));
    const output = run(['roster', 'import', legacy], { QUESTBOARD_HOME: home });
    assert.match(output, /imported 2 cards/);
    assert.match(output, /1 条旧备注未原样保留.*codex-astra \(status record \(paused\)\)/);
    assert.ok(!output.includes('像素画暂停') && !output.includes('Sisyphus'), 'note text and policy values stay out of the output');
    assert.match(output, /policy for the project config/);
    assert.equal(loadRoster(path.join(home, 'roster.json')).adventurers[1].notes, '和 Codex 同一个订阅');
    assert.equal(new StatusLog(path.join(home, 'status.jsonl')).current().get('codex-astra').status, 'paused');
    assert.throws(() => run(['roster', 'import', legacy], { QUESTBOARD_HOME: home }), /pass --force/);
    const status = run(['card', 'status', 'codex-astra', 'available', '--reason', 'owner lifted the pause', '--by', 'owner'], { QUESTBOARD_HOME: home });
    assert.match(status, /codex-astra available since .* — owner lifted the pause/);
  });

  it('card add succeeds when another card carries an env allowed only by some project list, and leaves that card untouched', () => {
    const home = tmpDir('cli-cardadd-env-');
    fs.writeFileSync(path.join(home, 'roster.json'), JSON.stringify({ adventurers: [
      { id: 'project-card', name: '项目卡', provider: 'p', lane: 'codex', model: 'm', family: 'm', env: { OC_AGENT: 'build' } },
    ] }));
    const output = run(['card', 'add', '--id', 'new-card', '--name', '新卡', '--provider', 'p', '--lane', 'codex', '--model', 'm'], { QUESTBOARD_HOME: home });
    assert.match(output, /new-card/);
    const roster = loadRoster(path.join(home, 'roster.json'));
    assert.equal(roster.adventurers.find((a) => a.id === 'project-card').env.OC_AGENT, 'build');
    assert.ok(roster.adventurers.find((a) => a.id === 'new-card'));
  });

  it('explains how to point at a project when none is found', () => {
    assert.throws(() => execFileSync(process.execPath, [CLI, 'list'], { cwd: tmpDir('noproj-'), encoding: 'utf8', stdio: 'pipe', env: { ...process.env, QUESTBOARD_PROJECT: '' } }), /no questboard\.config\.json/);
  });
});
describe('FB2-06: --help/-h dispatch and card add/edit', () => {
  const runCli = (args, options = {}) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...(options.env || {}) }, ...(options.cwd ? { cwd: options.cwd } : {}) });

  it('a subcommand with --help anywhere prints only its usage table, without a project or a server', () => {
    const bare = tmpDir('help-bare-');
    const out = runCli(['get', '--help'], { cwd: bare, env: { QUESTBOARD_PROJECT: '' } });
    assert.match(out, /usage: questboard get/);
    assert.doesNotMatch(out, /no questboard\.config\.json/, 'help must not demand a project');
    const late = runCli(['release', 'RUN-1', '-h', '--detail', 'x'], { cwd: bare, env: { QUESTBOARD_PROJECT: '' } });
    assert.match(late, /usage: questboard release/);
  });

  it('an unknown subcommand prints the total usage and exits with code 2', () => {
    const bare = tmpDir('help-unknown-');
    assert.throws(() => runCli(['frobnicate', '--help'], { cwd: bare, env: { QUESTBOARD_PROJECT: '' } }), /usage: questboard/);
  });

  it('card add --env KEY=VALUE is repeatable and validated like the roster', () => {
    const home = tmpDir('cli-cardadd-env2-');
    const add = (args) => runCli(['card', 'add', ...args], { env: { QUESTBOARD_HOME: home } });
    add(['--id', 'env-card', '--name', '环境卡', '--provider', 'p', '--lane', 'codex', '--model', 'm', '--env', 'OC_BASE_URL=http://x', '--env', 'MODEL_NAME=big']);
    const roster = loadRoster(path.join(home, 'roster.json'));
    assert.deepEqual(roster.adventurers[0].env, { OC_BASE_URL: 'http://x', MODEL_NAME: 'big' });
    assert.throws(() => add(['--id', 'bad-card', '--name', '坏卡', '--provider', 'p', '--lane', 'codex', '--model', 'm', '--env', 'OC_BASE_URL=sk-abc123']), /看起来像密钥/);
    assert.throws(() => add(['--id', 'bad-name', '--name', '坏名', '--provider', 'p', '--lane', 'codex', '--model', 'm', '--env', 'PATH=z']), /PATH/);
  });

  it('card edit changes name/model/variant/note/env, backs the roster up first, and refuses an unknown id', () => {
    const home = tmpDir('cli-cardedit-');
    fs.writeFileSync(path.join(home, 'roster.json'), JSON.stringify({ adventurers: [
      { id: 'edit-me', name: '旧名', provider: 'p', lane: 'codex', model: 'old', family: 'old', variant: 'low', env: { OC_BASE_URL: 'http://a' } },
    ] }));
    const out = runCli(['card', 'edit', 'edit-me', '--name', '新名', '--model', 'new-model', '--variant', 'high', '--note', '改过', '--env', 'MODEL_NAME=small'], { env: { QUESTBOARD_HOME: home } });
    assert.match(out, /edit-me/);
    const roster = loadRoster(path.join(home, 'roster.json'));
    const card = roster.adventurers[0];
    assert.equal(card.name, '新名');
    assert.equal(card.model, 'new-model');
    assert.equal(card.variant, 'high');
    assert.equal(card.notes, '改过');
    assert.deepEqual(card.env, { OC_BASE_URL: 'http://a', MODEL_NAME: 'small' }, 'env merges per key');
    const backups = fs.readdirSync(home).filter((f) => f.startsWith('roster.json.bak-'));
    assert.equal(backups.length, 1, 'a timestamped backup is kept before the write');
    assert.throws(() => runCli(['card', 'edit', 'nope', '--name', 'x'], { env: { QUESTBOARD_HOME: home } }), /不在名册里/);
  });
});

