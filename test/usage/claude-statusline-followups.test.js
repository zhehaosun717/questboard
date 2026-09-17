// Bundle J follow-ups for the Claude subscription reader and its standalone example:
// - J1: every reader failure carries a fixed, first-party code and the service renders its own sentence
//   (never the generic 没有给出可显示的失败原因).
// - J2: the example's inline copy of the snapshot-path rule must agree with src/usage/claudeStatusline.js.
// - J3: the example header must tell Windows users that an absolute ESM import needs a file:/// URL.
// - J5: the no-snapshot Claude entry is not a fresh reading.
// - Round 2: F1 puts the fixed code on the entry, N1 pins every sentence to the reader's own table, and N7
//   keeps a manual card manual when a re-read has not settled before the timeout.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers.js';
import { getClaudeSnapshotPath as exampleSnapshotPath } from '../../examples/claude-usage-statusline.mjs';
import {
  CLAUDE_SETUP_NOTE,
  CLAUDE_SNAPSHOT_ERROR_TEXT,
  MAX_SNAPSHOT_BYTES,
  getClaudeSnapshotPath,
  readClaudeSnapshot,
} from '../../src/usage/claudeStatusline.js';
import { claudeSubscription } from '../../src/usage/providers.js';
import { createUsageService } from '../../src/usage/service.js';

const EXAMPLE_PATH = path.join(import.meta.dirname, '..', '..', 'examples', 'claude-usage-statusline.mjs');
const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const GENERIC_TEXT = '没有给出可显示的失败原因';
const VALID_CAPTURE = { schema: 1, capturedAt: '2026-09-16T12:00:00.000Z' };
const ONE_WINDOW = { five_hour: { used_percentage: 1, resets_at: 2100000000 } };

// Every reader failure reachable from a file on disk, with the fixed code and sentence it must carry. Shared
// by the reader test and the F1 service test so both sides are pinned to the same eight code names.
function readerFailureScenarios() {
  return [
    { name: 'corrupt JSON', code: 'claude_snapshot_corrupt', contents: '{not json', error: /JSON/ },
    { name: 'oversized file', code: 'claude_snapshot_too_large', contents: 'x'.repeat(MAX_SNAPSHOT_BYTES + 1), error: /超出正常大小/ },
    {
      name: 'schema 2',
      code: 'claude_snapshot_schema',
      contents: JSON.stringify({ ...VALID_CAPTURE, schema: 2, rate_limits: ONE_WINDOW }),
      error: /schema 1/,
    },
    {
      name: 'bad timestamp',
      code: 'claude_snapshot_timestamp',
      contents: JSON.stringify({ ...VALID_CAPTURE, capturedAt: 'nope', rate_limits: ONE_WINDOW }),
      error: /时间戳无效/,
    },
    { name: 'missing rate_limits', code: 'claude_snapshot_no_rate_limits', contents: JSON.stringify(VALID_CAPTURE), error: /缺少额度数据/ },
    {
      name: 'empty rate_limits',
      code: 'claude_snapshot_no_windows',
      contents: JSON.stringify({ ...VALID_CAPTURE, rate_limits: {} }),
      error: /没有可用的额度数据/,
    },
    {
      name: 'directory at the snapshot path',
      code: 'claude_snapshot_read_failed',
      setup: (filePath) => fs.mkdirSync(filePath, { recursive: true }),
      error: /读取 Claude 状态栏快照失败/,
    },
  ];
}

function snapshotPathFor(homedir) {
  return getClaudeSnapshotPath({ homedir, env: {} });
}

// Places one scenario's file (or its directory, for the read-failure case) at the snapshot path.
function placeSnapshot(homedir, scenario) {
  const filePath = snapshotPathFor(homedir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (scenario.setup) scenario.setup(filePath);
  else fs.writeFileSync(filePath, scenario.contents);
  return filePath;
}

async function claudeEntry(homedir) {
  const service = createUsageService({ providers: [claudeSubscription], env: {}, homedir });
  const [entry] = (await service.report()).providers;
  return entry;
}

describe('Claude statusline bundle J follow-ups', () => {
  it('J1: each reader failure carries its fixed code and its own Chinese sentence', () => {
    for (const scenario of readerFailureScenarios()) {
      const homedir = tmpDir('qb-claude-followups-');
      placeSnapshot(homedir, scenario);
      const result = readClaudeSnapshot({ homedir, env: {}, now: NOW });
      assert.equal(result.ok, false, scenario.name);
      assert.equal(result.code, scenario.code, scenario.name);
      assert.match(result.error, scenario.error, scenario.name);
      assert.equal(result.error, CLAUDE_SNAPSHOT_ERROR_TEXT[scenario.code], `${scenario.name}: the sentence is the shared table's`);
    }
  });

  it('F1: every snapshot failure reaches the service entry as its fixed code and the reader sentence', async () => {
    for (const scenario of readerFailureScenarios()) {
      const homedir = tmpDir('qb-claude-followups-');
      placeSnapshot(homedir, scenario);
      const reader = readClaudeSnapshot({ homedir, env: {}, now: NOW });
      const entry = await claudeEntry(homedir);
      assert.equal(entry.ok, false, scenario.name);
      assert.equal(entry.state, 'failed', scenario.name);
      assert.equal(entry.errorCode, scenario.code, `${scenario.name}: the entry carries the fixed code the board maps`);
      assert.equal(entry.error, CLAUDE_SNAPSHOT_ERROR_TEXT[scenario.code], scenario.name);
      assert.equal(entry.error, reader.error, `${scenario.name}: the card sentence is the reader's own sentence`);
      assert.ok(!String(entry.error).includes(GENERIC_TEXT), scenario.name);
      assert.ok(!JSON.stringify(entry).includes(GENERIC_TEXT), scenario.name);
    }
  });

  it('J2: the example copy of the snapshot-path rule agrees with the board', () => {
    const cases = [
      { homedir: 'E:/some/home', env: { QUESTBOARD_HOME: 'E:/qb-home-abs' } },
      { homedir: 'E:/some/home', env: { QUESTBOARD_HOME: 'relative-qb-home' } },
      { homedir: 'E:/some/home', env: {} },
      { homedir: path.join('relative', 'home'), env: {} },
      { homedir: undefined, env: {} },
      { homedir: undefined, env: { QUESTBOARD_HOME: 'E:/only-home' } },
    ];
    for (const { homedir, env } of cases) {
      assert.equal(
        exampleSnapshotPath({ homedir, env }),
        getClaudeSnapshotPath({ homedir, env }),
        JSON.stringify({ homedir, env }),
      );
    }
  });

  it('J5: the no-snapshot Claude entry is not a fresh reading', async () => {
    const homedir = tmpDir('qb-claude-followups-');
    const entry = await claudeEntry(homedir);
    assert.equal(entry.ok, false);
    assert.equal(entry.providerState, 'manual_only');
    assert.notEqual(entry.state, 'fresh');
    assert.equal(entry.state, 'unconfigured');
    assert.equal(entry.fresh, false);
    assert.equal(entry.error, CLAUDE_SETUP_NOTE);
  });

  it('N1: the service renders all eight fixed codes from the reader\'s own table, never a local copy', async () => {
    const codes = Object.keys(CLAUDE_SNAPSHOT_ERROR_TEXT);
    assert.equal(codes.length, 8);
    for (const code of codes) {
      const stub = {
        id: 'stub-fixed-code',
        name: 'Stub',
        source: 'official-hook',
        async fetch() {
          return { ok: false, configured: true, state: 'failed', code, error: '供应商自由文本', note: '', windows: [], balances: [], asOf: null };
        },
      };
      const service = createUsageService({ providers: [stub], env: {}, homedir: tmpDir('qb-claude-codes-') });
      const [entry] = (await service.report()).providers;
      assert.equal(entry.errorCode, code, code);
      assert.equal(entry.error, CLAUDE_SNAPSHOT_ERROR_TEXT[code], code);
      assert.ok(!JSON.stringify(entry).includes('供应商自由文本'), `${code}: the free-text error never reaches the entry`);
    }
  });

  it('N7: a manual card keeps its manual state and note when a re-read has not settled before the timeout', async () => {
    let ms = 1000000;
    let fetches = 0;
    const manualNote = '请到控制台查看';
    const manualCard = {
      id: 'manual-clock',
      name: '手动卡片',
      source: 'manual',
      async fetch() {
        fetches += 1;
        // The settled first read answers by hand; the re-read never settles, so the service has to time it out.
        if (fetches > 1) return new Promise(() => {});
        return { windows: [], balances: [], plan: '', note: manualNote, manual_only: true, state: 'manual_only', asOf: null };
      },
    };
    const service = createUsageService({
      providers: [manualCard],
      env: {},
      homedir: tmpDir('qb-claude-manual-clock-'),
      cacheMs: 1000,
      cooldownMs: 0,
      timeoutMs: 50,
      now: () => ms,
    });
    const [first] = (await service.report()).providers;
    assert.equal(first.state, 'unconfigured', 'a settled manual read is already not a fresh reading');
    ms += 5000; // the previous reading now sits outside the cache window
    const [second] = (await service.report({ refresh: true })).providers;
    assert.equal(fetches, 2);
    assert.equal(second.refreshing, true, 'the timed-out re-read is still in flight');
    assert.equal(second.state, 'unconfigured');
    assert.equal(second.providerState, 'manual_only');
    assert.equal(second.fresh, false);
    assert.equal(second.stale, false);
    assert.equal(second.error, manualNote);
    assert.ok(!JSON.stringify(second).includes('数据已过期'));
  });

  it('J3: the example header tells Windows users their import needs a file:/// URL', () => {
    const source = fs.readFileSync(EXAMPLE_PATH, 'utf8');
    assert.match(source, /Windows note/);
    assert.match(source, /file:\/\/\//);
  });
});
