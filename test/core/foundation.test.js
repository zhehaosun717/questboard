import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, loadProjectConfig, findProjectRoot, fillTemplate, CONFIG_FILE } from '../../src/core/config.js';
import { StatusLog, foldStatuses, applyStatuses } from '../../src/core/status.js';
import { validateRoster, upsertAdventurer, saveRoster, loadRoster } from '../../src/core/roster.js';
import { splitLegacyRoster } from '../../src/core/legacy.js';
import { readJsonLines } from '../../src/core/jsonl.js';
import { questboardHome, homePaths } from '../../src/core/home.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const lanes = { codex: { run: ['tools/codex-run.sh', '{name}', '{brief}', '{model}', '{variant}'], outputDir: '.claude/codex' } };
const card = { id: 'codex-luna', name: 'Luna', provider: 'OpenAI Codex', lane: 'codex', model: 'gpt-5.6-luna', family: 'gpt-5.6-luna' };

describe('config', () => {
  it('resolves paths against the project root and fills defaults', () => {
    const config = resolveConfig('E:/game', { name: 'Game', lanes, events: '.claude/lanes/events.jsonl' });
    assert.equal(config.paths.events, path.resolve('E:/game/.claude/lanes/events.jsonl'));
    assert.equal(config.paths.data, path.resolve('E:/game/.questboard-data'));
    assert.deepEqual(config.briefs.dispatchDirs, ['docs/briefs']);
    assert.ok(config.briefs.fileListHeading.test('## Files you may edit (nothing else)'));
    assert.equal(config.port, 6097);
    assert.equal(config.lanes.codex.editCounter, 'patch');
  });

  it('names what is wrong', () => {
    assert.throws(() => resolveConfig('E:/g', { lanes }), /name must be a non-empty string/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes: {} }), /at least one lane/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: ['x', '{nmae}'], outputDir: 'o' } } }), /unknown placeholder \{nmae\}/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: ['x'] } } }), /needs outputDir .* or api/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes, briefs: { packagePattern: '(' } }), /not a valid regular expression/);
  });

  it('finds and loads the config file walking up from a subfolder', () => {
    const root = tmp('cfg-');
    fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify({ name: 'G', lanes }));
    fs.mkdirSync(path.join(root, 'docs', 'briefs'), { recursive: true });
    assert.equal(findProjectRoot(path.join(root, 'docs', 'briefs')), root);
    assert.equal(loadProjectConfig(root).name, 'G');
    assert.throws(() => loadProjectConfig(tmp('none-')), /no questboard\.config\.json/);
  });

  it('refuses to fill a placeholder that has no value', () => {
    assert.deepEqual(fillTemplate(['a', '{name}-{model}'], { name: 'run4', model: 'm' }), ['a', 'run4-m']);
    assert.throws(() => fillTemplate(['{agent}'], { agent: '' }, 'lanes.opencode.env'), /needs \{agent\}/);
  });
});

describe('status log', () => {
  it('keeps the start date while the status repeats, and resets it on change', () => {
    const log = new StatusLog(path.join(tmp('status-'), 'status.jsonl'));
    log.set('codex-astra', { status: 'paused', reason: 'cost', setBy: 'owner', at: '2026-09-12T10:00:00.000Z' });
    const again = log.set('codex-astra', { status: 'paused', reason: 'cost, still', setBy: 'owner', at: '2026-09-13T10:00:00.000Z' });
    assert.equal(again.since, '2026-09-12T10:00:00.000Z');
    assert.equal(again.reason, 'cost, still');
    const back = log.set('codex-astra', { status: 'available', setBy: 'owner', at: '2026-09-14T10:00:00.000Z' });
    assert.equal(back.since, '2026-09-14T10:00:00.000Z');
    assert.throws(() => log.set('codex-astra', { status: 'tired', setBy: 'owner' }), /status must be one of/);
  });

  it('treats a card with no record as available', () => {
    const current = foldStatuses([{ at: '2026-09-12T00:00:00.000Z', adventurerId: 'oc-kimi', status: 'limited', reason: 'weekly', setBy: 'lanes' }]);
    const [kimi, luna] = applyStatuses([{ id: 'oc-kimi' }, { id: 'codex-luna' }], current);
    assert.equal(kimi.status, 'limited');
    assert.equal(kimi.statusReason, 'weekly');
    assert.equal(luna.status, 'available');
  });
});

describe('roster', () => {
  it('rejects a status field and points at the status log', () => {
    assert.throws(() => validateRoster({ adventurers: [{ ...card, status: 'paused' }] }), /status log/);
  });

  it('upserts immutably and round-trips to disk', () => {
    const roster = { adventurers: [card] };
    const next = upsertAdventurer(roster, { ...card, notes: 'same plan as Codex' });
    assert.equal(roster.adventurers[0].notes, undefined);
    const file = path.join(tmp('roster-'), 'roster.json');
    saveRoster(file, next);
    assert.equal(loadRoster(file).adventurers[0].notes, 'same plan as Codex');
    assert.throws(() => loadRoster(path.join(tmp('no-'), 'roster.json')), /questboard roster import/);
  });
});

describe('legacy import', () => {
  it('moves statuses and dated notes out of the roster and reports each one', () => {
    const legacy = {
      policy: { bannedModelPatterns: ['-fast'], bannedAgents: ['Sisyphus'] },
      adventurers: [
        { ...card, id: 'codex-astra', status: 'paused', note: '像素画暂停，太费用量（owner 2026-09-12）', statusChangedAt: '2026-09-12T10:00:00.000Z' },
        { ...card, status: 'available', note: 'Codex 唯一允许的模型（owner 2026-09-13）' },
        { ...card, id: 'oc-luna', status: 'available', note: '和 Codex 同一个订阅' },
      ],
    };
    const { roster, statusRecords, policy, report } = splitLegacyRoster(legacy, { at: '2026-09-13T00:00:00.000Z' });
    validateRoster(roster);
    assert.deepEqual(statusRecords, [{ at: '2026-09-12T10:00:00.000Z', adventurerId: 'codex-astra', status: 'paused', reason: '像素画暂停，太费用量（owner 2026-09-12）', setBy: 'import' }]);
    assert.equal(roster.adventurers[1].notes, undefined);
    assert.equal(roster.adventurers[2].notes, '和 Codex 同一个订阅');
    assert.equal(report.length, 2);
    assert.deepEqual(policy.bannedAgents, ['Sisyphus']);
  });
});

describe('home and jsonl', () => {
  it('uses QUESTBOARD_HOME when set', () => {
    assert.equal(homePaths(questboardHome({ QUESTBOARD_HOME: 'E:/qb' })).roster, path.resolve('E:/qb/roster.json'));
  });

  it('skips a torn final line but fails on corruption in the middle', () => {
    const file = path.join(tmp('jsonl-'), 'x.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"a":');
    assert.deepEqual(readJsonLines(file), [{ a: 1 }]);
    fs.writeFileSync(file, '{"a":1}\nnot json\n{"a":2}\n');
    assert.throws(() => readJsonLines(file), /x\.jsonl:2 is not JSON/);
  });
});
