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
    assert.match(output, /codex-astra: "像素画暂停，太费用量（owner 2026-09-12）" -> status record \(paused\)/);
    assert.match(output, /policy for the project config/);
    assert.equal(loadRoster(path.join(home, 'roster.json')).adventurers[1].notes, '和 Codex 同一个订阅');
    assert.equal(new StatusLog(path.join(home, 'status.jsonl')).current().get('codex-astra').status, 'paused');
    assert.throws(() => run(['roster', 'import', legacy], { QUESTBOARD_HOME: home }), /pass --force/);
    const status = run(['card', 'status', 'codex-astra', 'available', '--reason', 'owner lifted the pause', '--by', 'owner'], { QUESTBOARD_HOME: home });
    assert.match(status, /codex-astra available since .* — owner lifted the pause/);
  });

  it('explains how to point at a project when none is found', () => {
    assert.throws(() => execFileSync(process.execPath, [CLI, 'list'], { cwd: tmpDir('noproj-'), encoding: 'utf8', stdio: 'pipe', env: { ...process.env, QUESTBOARD_PROJECT: '' } }), /no questboard\.config\.json/);
  });
});
