import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, loadProjectConfig, findProjectRoot, fillTemplate, CONFIG_FILE } from '../../src/core/config.js';
import { BROWSER_UNSAFE_PORTS } from '../../src/core/browserUnsafePorts.js';
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

  it('refuses a board port a browser would refuse to connect to, in Chinese, naming the port and an example', () => {
    for (const blocked of [6000, 6666, 10080]) {
      assert.throws(
        () => resolveConfig('E:/g', { name: 'G', lanes, port: blocked }),
        (error) => error.message.includes(String(blocked)) && error.message.includes('浏览器') && error.message.includes('6097'),
        `port ${blocked} should be refused with a Chinese explanation naming it and 6097`,
      );
    }
    // Every canonical blocked port fails, and it is the same 82-port dataset the fixtures and the desktop
    // shell's Rust settings parser read (src/core/browserUnsafePorts.js).
    for (const blocked of BROWSER_UNSAFE_PORTS) {
      assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes, port: blocked }), /浏览器会直接拒绝连接/, `port ${blocked}`);
    }
    // Existing valid default and ordinary ephemeral ports stay unaffected.
    assert.equal(resolveConfig('E:/g', { name: 'G', lanes, port: 6097 }).port, 6097);
    assert.equal(resolveConfig('E:/g', { name: 'G', lanes, port: 45231 }).port, 45231);
  });

  it('refuses a non-integer or out-of-range board port in Chinese, not a string, fraction, overflow or non-finite value', () => {
    // Same JSON numeric integer representation Rust's parse_project requires (desktop/src-tauri/src/settings.rs):
    // a plain in-range integer. Strings, fractions, overflow and non-finite values are refused on both sides.
    for (const bad of [0, -1, -6097, 65536, 70000, 6097.5, NaN, Infinity, -Infinity, '6097', null, true, [6097], {}]) {
      assert.throws(
        () => resolveConfig('E:/g', { name: 'G', lanes, port: bad }),
        (error) => error.message.includes('必须是 1 到 65535 之间的整数') && !/must be an integer/.test(error.message),
        `port ${JSON.stringify(bad)} should be refused in Chinese, naming the 1..65535 range`,
      );
    }
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

  it('defaults every feedback-38 policy field to exactly today\'s behaviour', () => {
    const config = resolveConfig('E:/game', { name: 'Game', lanes });
    assert.equal(config.policy.stallAfterMinutes, 20);
    assert.deepEqual(Object.keys(config.policy.laneConcurrency), []);
    assert.equal(config.policy.defaultLane, null);
    assert.equal(config.policy.defaultCard, null);
    assert.deepEqual(config.policy.bouncePatterns, []);
  });

  it('refuses invalid feedback-38 policy values, naming the field', () => {
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes, policy: { stallAfterMinutes: 0 } }), /policy\.stallAfterMinutes must be a positive integer \(minutes\)/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes, policy: { stallAfterMinutes: 1.5 } }), /policy\.stallAfterMinutes/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes, policy: { laneConcurrency: { ghost: 2 } } }), /policy\.laneConcurrency\.ghost names a lane that is not configured/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes, policy: { laneConcurrency: { codex: 0 } } }), /policy\.laneConcurrency\.codex must be a positive integer/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes, policy: { defaultLane: 'ghost' } }), /policy\.defaultLane ghost is not a configured lane/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes, policy: { defaultCard: 'Bad Card' } }), /policy\.defaultCard must match/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes, policy: { bouncePatterns: [42] } }), /policy\.bouncePatterns\[0\].*object/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes, policy: { bouncePatterns: [{ code: 'Bad Code', pattern: 'x', label: 'y' }] } }), /policy\.bouncePatterns\[0\]\.code must match/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes, policy: { bouncePatterns: [{ code: 'ok', pattern: '(', label: 'y' }] } }), /policy\.bouncePatterns\[0\]\.pattern is not a valid regular expression/);
  });

  it('resolves feedback-38 policy values, compiling bounce patterns at resolve time', () => {
    const config = resolveConfig('E:/g', {
      name: 'G',
      lanes,
      policy: {
        stallAfterMinutes: 45,
        laneConcurrency: { codex: 2 },
        defaultLane: 'codex',
        defaultCard: 'oc-mimo',
        bouncePatterns: [{ code: 'quota_5h', pattern: 'resets (at|in)', label: '额度用尽' }],
      },
    });
    assert.equal(config.policy.stallAfterMinutes, 45);
    assert.equal(config.policy.laneConcurrency.codex, 2);
    assert.equal(config.policy.defaultLane, 'codex');
    assert.equal(config.policy.defaultCard, 'oc-mimo');
    assert.equal(config.policy.bouncePatterns[0].code, 'quota_5h');
    assert.equal(config.policy.bouncePatterns[0].label, '额度用尽');
    assert.ok(config.policy.bouncePatterns[0].pattern instanceof RegExp);
    assert.ok(config.policy.bouncePatterns[0].pattern.test('rate window resets in 3h'));
  });

  it('validates an optional per-lane health contract without disturbing lanes that omit it', () => {
    const withHealth = resolveConfig('E:/g', { name: 'G', lanes: { oc: { run: ['x'], api: 'http://127.0.0.1:6096', health: { path: '/global/health', json: { healthy: true } } } } });
    assert.deepEqual(withHealth.lanes.oc.health, { path: '/global/health', json: { healthy: true } });
    // Existing fields (run, serve as an argv array) are untouched by adding health.
    const withServeAndHealth = resolveConfig('E:/g', { name: 'G', lanes: { oc: { run: ['x'], api: 'http://127.0.0.1:6096', serve: ['opencode', 'serve'], health: { path: '/global/health' } } } });
    assert.deepEqual(withServeAndHealth.lanes.oc.serve, ['opencode', 'serve']);
    assert.deepEqual(withServeAndHealth.lanes.oc.health, { path: '/global/health' });
    assert.equal(resolveConfig('E:/g', { name: 'G', lanes }).lanes.codex.health, undefined, 'lanes without health stay legacy');

    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes: { oc: { run: ['x'], outputDir: 'o', health: { path: '/h' } } } }), /needs api/);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes: { oc: { run: ['x'], api: 'http://127.0.0.1:6096', health: { path: 'no-slash' } } } }), /must start with \//);
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes: { oc: { run: ['x'], api: 'http://127.0.0.1:6096', health: { path: '/h', json: 'nope' } } } }), /health\.json must be an object/);
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

  it('takes non-secret env values on a card and refuses key-shaped ones', () => {
    const base = 'https://api.example.test/v1';
    assert.deepEqual(validateRoster({ adventurers: [{ ...card, env: { OPENAI_BASE_URL: base } }] }).adventurers[0].env, { OPENAI_BASE_URL: base });
    assert.throws(() => validateRoster({ adventurers: [{ ...card, env: { 'lower case': 'x' } }] }), /UPPER_SNAKE_CASE/);
    assert.throws(() => validateRoster({ adventurers: [{ ...card, env: { OPENAI_API_KEY: 'sk-abcdef0123456789' } }] }), /looks like a key/);
    assert.throws(() => validateRoster({ adventurers: [{ ...card, env: 'OPENAI_BASE_URL=x' }] }), /must be an object/);
    assert.throws(() => validateRoster({ adventurers: [{ ...card, env: { LONG: 'x'.repeat(201) } }] }), /at most 200/);
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
