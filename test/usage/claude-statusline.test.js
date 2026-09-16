import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { tmpDir } from '../helpers.js';
import { extractClaudeSnapshot, writeClaudeSnapshot } from '../../examples/claude-usage-statusline.mjs';
import {
  CLAUDE_SETUP_NOTE,
  CLAUDE_STALE_THRESHOLD_MS,
  MAX_SNAPSHOT_BYTES,
  getClaudeSnapshotPath,
  readClaudeSnapshot,
} from '../../src/usage/claudeStatusline.js';
import { claudeSubscription, PROVIDERS } from '../../src/usage/providers.js';
import { CLAUDE_MANUAL_NOTE } from '../../src/usage/manualProviders.js';
import { getCatalogEntry, validateCatalogEntry } from '../../src/usage/catalog.js';
import { createUsageService } from '../../src/usage/service.js';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');
const STDIN_FIXTURE_PATH = path.join(FIXTURES_DIR, 'claude-statusline-stdin.synthetic.json');
const SNAPSHOT_FIXTURE_PATH = path.join(FIXTURES_DIR, 'claude-usage-snapshot.synthetic.json');
const EXAMPLE_PATH = path.join(import.meta.dirname, '..', '..', 'examples', 'claude-usage-statusline.mjs');

// In-process helpers always pass env: {} so an ambient QUESTBOARD_HOME in the
// test runner's environment can never redirect reads/writes away from homedir.
function snapshotPathFor(homedir) {
  return getClaudeSnapshotPath({ homedir, env: {} });
}

function writeSnapshotFile(homedir, snapshot) {
  const targetFile = snapshotPathFor(homedir);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, JSON.stringify(snapshot));
  return targetFile;
}

function runExample({ args = [], input = '', home }) {
  return child_process.spawnSync(process.execPath, [EXAMPLE_PATH, ...args], {
    input,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, QUESTBOARD_HOME: home },
  });
}

describe('Claude Code status-line example transform (pure, child-process-free)', () => {
  it('extracts rate_limits from synthetic stdin fixture matching expected snapshot fixture', () => {
    const stdinContent = fs.readFileSync(STDIN_FIXTURE_PATH, 'utf8');
    const expectedSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FIXTURE_PATH, 'utf8'));

    // Fix time to match synthetic snapshot fixture capturedAt
    const snapshot = extractClaudeSnapshot(stdinContent, '2000-01-01T00:00:00.000Z');
    assert.ok(snapshot, 'snapshot must be extracted');
    assert.deepEqual(snapshot, expectedSnapshot);
  });

  it('filters strictly: never copies session_id, transcript_path, cwd, model, workspace, cost, or context_window', () => {
    const stdinContent = fs.readFileSync(STDIN_FIXTURE_PATH, 'utf8');
    const snapshot = extractClaudeSnapshot(stdinContent);
    const serialized = JSON.stringify(snapshot);

    assert.ok(!serialized.includes('SYNTHETIC-SESSION'), 'must not copy session_id value');
    assert.ok(!serialized.includes('session_id'), 'must not copy session_id key');
    assert.ok(!serialized.includes('transcript_path'), 'must not copy transcript_path');
    assert.ok(!serialized.includes('/synthetic/path.jsonl'), 'must not copy transcript path value');
    assert.ok(!serialized.includes('cwd'), 'must not copy cwd');
    assert.ok(!serialized.includes('workspace'), 'must not copy workspace');
    assert.ok(!serialized.includes('model'), 'must not copy model');
    assert.ok(!serialized.includes('cost'), 'must not copy cost');
    assert.ok(!serialized.includes('total_cost_usd'), 'must not copy total_cost_usd');
    assert.ok(!serialized.includes('context_window'), 'must not copy context_window');
  });

  it('returns null when rate_limits is absent so an older snapshot is not overwritten', () => {
    assert.equal(extractClaudeSnapshot({}), null);
    assert.equal(extractClaudeSnapshot({ session_id: 'abc', model: 'test' }), null);
    assert.equal(extractClaudeSnapshot({ rate_limits: null }), null);
    assert.equal(extractClaudeSnapshot({ rate_limits: 'invalid' }), null);
    assert.equal(extractClaudeSnapshot(''), null);
    assert.equal(extractClaudeSnapshot('   '), null);
    assert.equal(extractClaudeSnapshot('not-json'), null);
    assert.equal(extractClaudeSnapshot(null), null);
    assert.equal(extractClaudeSnapshot([]), null);
  });

  it('returns null when rate_limits contains no recognized or valid numeric windows', () => {
    assert.equal(extractClaudeSnapshot({ rate_limits: {} }), null);
    assert.equal(extractClaudeSnapshot({ rate_limits: { unknown_window: { used_percentage: 10, resets_at: 1000 } } }), null);
    assert.equal(extractClaudeSnapshot({ rate_limits: { five_hour: { used_percentage: 'nan', resets_at: 1000 } } }), null);
    assert.equal(extractClaudeSnapshot({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 'bad' } } }), null);

    // Only finite numbers are accepted; string-typed numbers (and empty strings, which
    // Number('') would turn into 0) are rejected instead of coerced.
    assert.equal(extractClaudeSnapshot({ rate_limits: { five_hour: { used_percentage: '12', resets_at: 1000 } } }), null);
    assert.equal(extractClaudeSnapshot({ rate_limits: { five_hour: { used_percentage: 12, resets_at: '1000' } } }), null);
    assert.equal(extractClaudeSnapshot({ rate_limits: { five_hour: { used_percentage: '', resets_at: '' } } }), null);
  });

  it('preserves five_hour, seven_day, and spend_limit with integer resets_at and stripped extra properties', () => {
    const input = {
      rate_limits: {
        five_hour: { used_percentage: 12.34, resets_at: 1700000000.8, extra_key: 'strip_me' },
        seven_day: { used_percentage: 45.6, resets_at: 1700050000 },
        spend_limit: { used_percentage: 120, resets_at: 1700090000 },
      },
    };
    const snapshot = extractClaudeSnapshot(input, '2026-09-16T10:00:00.000Z');
    assert.equal(snapshot.schema, 1);
    assert.equal(snapshot.capturedAt, '2026-09-16T10:00:00.000Z');
    assert.deepEqual(snapshot.rate_limits, {
      five_hour: { used_percentage: 12.34, resets_at: 1700000000 },
      seven_day: { used_percentage: 45.6, resets_at: 1700050000 },
      spend_limit: { used_percentage: 120, resets_at: 1700090000 },
    });
    assert.equal('extra_key' in snapshot.rate_limits.five_hour, false);
  });

  it('writes snapshot atomically via temp file to target directory', () => {
    const homedir = tmpDir('qb-statusline-write-');
    const snapshot = {
      schema: 1,
      capturedAt: '2026-09-16T10:00:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 1800000000 },
      },
    };

    const ok = writeClaudeSnapshot(snapshot, { homedir, env: {} });
    assert.equal(ok, true);

    const targetFile = snapshotPathFor(homedir);
    assert.ok(fs.existsSync(targetFile), 'claude.json should exist');
    const readBack = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    assert.deepEqual(readBack, snapshot);

    // No leftover temporary files in target directory
    const dirFiles = fs.readdirSync(path.dirname(targetFile));
    assert.deepEqual(dirFiles, ['claude.json']);
  });
});

describe('Claude status-line example as a real child process', () => {
  it('prints a fallback status line and writes the snapshot when run with the synthetic stdin fixture', () => {
    const home = tmpDir('qb-example-child-');
    const stdin = fs.readFileSync(STDIN_FIXTURE_PATH, 'utf8');

    const result = runExample({ input: stdin, home });
    assert.equal(result.status, 0, `example must exit 0 (stderr: ${result.stderr})`);
    // Without arguments the status line must never be blank: a fixed truthful line is printed
    assert.equal(result.stdout, 'Claude 用量快照已更新\n');

    const snapshotFile = path.join(home, 'usage', 'claude.json');
    assert.ok(fs.existsSync(snapshotFile), 'snapshot file must be written');
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));

    assert.deepEqual(Object.keys(snapshot).sort(), ['capturedAt', 'rate_limits', 'schema']);
    assert.equal(snapshot.schema, 1);

    const expected = JSON.parse(fs.readFileSync(SNAPSHOT_FIXTURE_PATH, 'utf8'));
    assert.deepEqual(snapshot.rate_limits, expected.rate_limits);

    const capturedMs = Date.parse(snapshot.capturedAt);
    assert.ok(Number.isFinite(capturedMs), 'capturedAt must be a valid timestamp');
    assert.ok(Math.abs(Date.now() - capturedMs) < 60000, 'capturedAt should be recent');

    const serialized = JSON.stringify(snapshot);
    for (const planted of ['SYNTHETIC-SESSION', 'transcript_path', '/synthetic/path.jsonl', 'cwd', 'cost', 'context_window', 'workspace']) {
      assert.ok(!serialized.includes(planted), `snapshot must not contain ${planted}`);
    }
  });

  it('prints the owner status text passed as arguments through unchanged and still writes the snapshot', () => {
    const home = tmpDir('qb-example-child-args-');
    const result = runExample({
      args: ['my', 'status', '│', 'text'],
      input: fs.readFileSync(STDIN_FIXTURE_PATH, 'utf8'),
      home,
    });

    assert.equal(result.status, 0, `example must exit 0 (stderr: ${result.stderr})`);
    assert.equal(result.stdout, 'my status │ text\n', 'owner text must be printed through unchanged');
    assert.ok(fs.existsSync(path.join(home, 'usage', 'claude.json')), 'snapshot must still be written');
  });

  it('prints the not-updated fallback and writes nothing when stdin has no rate_limits', () => {
    const home = tmpDir('qb-example-child-nolimits-');
    const result = runExample({ input: '{"session_id":"x"}', home });

    assert.equal(result.status, 0, `example must exit 0 (stderr: ${result.stderr})`);
    assert.equal(result.stdout, 'Claude 用量快照未更新\n');
    assert.equal(fs.existsSync(path.join(home, 'usage', 'claude.json')), false, 'nothing must be written');
  });

  it('keeps an older snapshot byte-identical and exits 0 when stdin is corrupt JSON', () => {
    const home = tmpDir('qb-example-child-corrupt-');
    const snapshotFile = path.join(home, 'usage', 'claude.json');
    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    const oldContent = '{"schema":1,"capturedAt":"2000-01-01T00:00:00.000Z","rate_limits":{"five_hour":{"used_percentage":1,"resets_at":2000000000}}}\n';
    fs.writeFileSync(snapshotFile, oldContent, 'utf8');

    const result = runExample({ input: 'not json{', home });

    assert.equal(result.status, 0, `example must exit 0 (stderr: ${result.stderr})`);
    assert.equal(result.stdout, 'Claude 用量快照未更新\n');
    assert.equal(fs.readFileSync(snapshotFile, 'utf8'), oldContent, 'older snapshot must stay byte-identical');
  });
});

describe('Claude snapshot reader (readClaudeSnapshot)', () => {
  it('returns not_configured with the exact Chinese setup note when snapshot file is missing', () => {
    const homedir = tmpDir('qb-snapshot-missing-');
    const result = readClaudeSnapshot({ homedir, env: {} });

    assert.equal(result.ok, false);
    assert.equal(result.configured, false);
    assert.equal(result.state, 'not_configured');
    assert.equal(result.note, CLAUDE_SETUP_NOTE);
    assert.match(result.note, /在 Claude Code 里运行 \/usage，或按 examples\/claude-usage-statusline\.mjs 里的说明启用状态栏快照/);
    assert.ok(result.note.includes('examples/claude-usage-statusline.mjs'), 'setup note must name the example script');
    assert.deepEqual(result.windows, []);
    assert.deepEqual(result.balances, []);
    assert.equal(result.asOf, null);
  });

  it('never reads any other file under ~/.claude', () => {
    const homedir = tmpDir('qb-snapshot-claude-dir-');
    const claudeDir = path.join(homedir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"statusLine":{"type":"command","command":"echo"}}');
    fs.writeFileSync(path.join(claudeDir, 'credentials.json'), '{"secret":"must-not-read"}');

    const accessedPaths = [];
    const origReadFileSync = fs.readFileSync;
    const origStatSync = fs.statSync;
    const origExistsSync = fs.existsSync;

    try {
      fs.readFileSync = (filePath, ...args) => {
        accessedPaths.push(String(filePath));
        return origReadFileSync(filePath, ...args);
      };
      fs.statSync = (filePath, ...args) => {
        accessedPaths.push(String(filePath));
        return origStatSync(filePath, ...args);
      };
      fs.existsSync = (filePath, ...args) => {
        accessedPaths.push(String(filePath));
        return origExistsSync(filePath, ...args);
      };

      const result = readClaudeSnapshot({ homedir, env: {} });
      assert.equal(result.state, 'not_configured');

      for (const accessed of accessedPaths) {
        assert.ok(
          !accessed.includes(path.join(homedir, '.claude')),
          `Must never read or touch files under ~/.claude: ${accessed}`
        );
      }
    } finally {
      fs.readFileSync = origReadFileSync;
      fs.statSync = origStatSync;
      fs.existsSync = origExistsSync;
    }
  });

  it('parses valid snapshot mapping five_hour to 5 小时, seven_day to 每周, spend_limit to 消费上限', () => {
    const homedir = tmpDir('qb-snapshot-valid-');
    writeSnapshotFile(homedir, {
      schema: 1,
      capturedAt: '2026-09-16T10:00:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: 1.5, resets_at: 2000000000 },
        seven_day: { used_percentage: 42.8, resets_at: 2000500000 },
        spend_limit: { used_percentage: 101, resets_at: 2100000000 },
      },
    });

    // now before resets
    const result = readClaudeSnapshot({ homedir, env: {}, now: Date.parse('2026-09-16T10:05:00.000Z') });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'ok');
    assert.equal(result.asOf, '2026-09-16T10:00:00.000Z');
    assert.deepEqual(result.balances, []);

    assert.equal(result.windows.length, 3);
    assert.deepEqual(result.windows[0], {
      label: '5 小时',
      usedPercent: 1.5,
      resetsAt: new Date(2000000000 * 1000).toISOString(),
    });
    assert.deepEqual(result.windows[1], {
      label: '每周',
      usedPercent: 42.8,
      resetsAt: new Date(2000500000 * 1000).toISOString(),
    });
    // spend_limit: truthful above 100
    assert.deepEqual(result.windows[2], {
      label: '消费上限',
      usedPercent: 101,
      resetsAt: new Date(2100000000 * 1000).toISOString(),
    });
  });

  it('drops windows whose resets_at has passed and sets state: reset with null usedPercent', () => {
    const homedir = tmpDir('qb-snapshot-reset-');
    writeSnapshotFile(homedir, {
      schema: 1,
      capturedAt: '2026-09-16T10:00:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: 50, resets_at: 1000000000 }, // past
        spend_limit: { used_percentage: 101, resets_at: 4000000000 }, // future
      },
    });

    const result = readClaudeSnapshot({ homedir, env: {}, now: Date.parse('2026-09-16T12:00:00.000Z') });
    assert.equal(result.ok, true);
    assert.equal(result.windows[0].label, '5 小时');
    assert.equal(result.windows[0].usedPercent, null);
    assert.equal(result.windows[0].state, 'reset');
    assert.equal(result.windows[0].resetsAt, new Date(1000000000 * 1000).toISOString());

    assert.equal(result.windows[1].label, '消费上限');
    assert.equal(result.windows[1].usedPercent, 101);
    assert.equal(result.windows[1].state, undefined);
  });

  it('marks stale when capturedAt is older than documented threshold', () => {
    const homedir = tmpDir('qb-snapshot-stale-');
    const capturedAt = '2026-09-10T10:00:00.000Z';
    writeSnapshotFile(homedir, {
      schema: 1,
      capturedAt,
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 2000000000 },
      },
    });

    // 2 days later (> 24 hour threshold)
    const laterTime = Date.parse(capturedAt) + CLAUDE_STALE_THRESHOLD_MS + 10000;
    const staleRes = readClaudeSnapshot({ homedir, env: {}, now: laterTime });
    assert.equal(staleRes.ok, true);
    assert.equal(staleRes.stale, true);
    assert.match(staleRes.note, /过期|未更新/);

    // 1 hour later (< 24 hour threshold)
    const freshTime = Date.parse(capturedAt) + 3600000;
    const freshRes = readClaudeSnapshot({ homedir, env: {}, now: freshTime });
    assert.equal(freshRes.ok, true);
    assert.equal(freshRes.stale, undefined);
    assert.equal(freshRes.note, '');
  });

  it('gives safe Chinese error on corrupt JSON, oversized file, invalid schema, or missing rate_limits', () => {
    const homedir = tmpDir('qb-snapshot-corrupt-');
    const targetFile = snapshotPathFor(homedir);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    // Corrupt JSON
    fs.writeFileSync(targetFile, 'not-valid-json{');
    const corruptRes = readClaudeSnapshot({ homedir, env: {} });
    assert.equal(corruptRes.ok, false);
    assert.equal(corruptRes.state, 'failed');
    assert.match(corruptRes.error, /JSON/);

    // Oversized file
    const huge = JSON.stringify({ schema: 1, capturedAt: '2026-09-16T10:00:00.000Z', rate_limits: {}, padding: 'x'.repeat(MAX_SNAPSHOT_BYTES + 10) });
    fs.writeFileSync(targetFile, huge);
    const hugeRes = readClaudeSnapshot({ homedir, env: {} });
    assert.equal(hugeRes.ok, false);
    assert.equal(hugeRes.state, 'failed');
    assert.match(hugeRes.error, /超出正常大小/);

    // Unsupported schema
    fs.writeFileSync(targetFile, JSON.stringify({ schema: 2, capturedAt: '2026-09-16T10:00:00.000Z', rate_limits: {} }));
    const schemaRes = readClaudeSnapshot({ homedir, env: {} });
    assert.equal(schemaRes.ok, false);
    assert.equal(schemaRes.state, 'failed');
    assert.match(schemaRes.error, /schema 1/);

    // Missing rate_limits
    fs.writeFileSync(targetFile, JSON.stringify({ schema: 1, capturedAt: '2026-09-16T10:00:00.000Z' }));
    const noLimitsRes = readClaudeSnapshot({ homedir, env: {} });
    assert.equal(noLimitsRes.ok, false);
    assert.equal(noLimitsRes.state, 'failed');
    assert.match(noLimitsRes.error, /缺少额度数据/);
  });

  it('keeps used percentages above 100 truthful for every window without clamping', () => {
    const homedir = tmpDir('qb-snapshot-over100-');
    writeSnapshotFile(homedir, {
      schema: 1,
      capturedAt: '2026-09-16T10:00:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: 133.37, resets_at: 2000000000 },
        seven_day: { used_percentage: 250, resets_at: 2000500000 },
        spend_limit: { used_percentage: 101, resets_at: 2100000000 },
      },
    });

    const result = readClaudeSnapshot({ homedir, env: {}, now: Date.parse('2026-09-16T10:05:00.000Z') });
    assert.equal(result.ok, true);
    assert.equal(result.windows[0].usedPercent, 133.4);
    assert.equal(result.windows[1].usedPercent, 250);
    assert.equal(result.windows[2].usedPercent, 101);
  });

  it('treats a negative used_percentage as unknown instead of fabricating zero', () => {
    const homedir = tmpDir('qb-snapshot-negative-');
    writeSnapshotFile(homedir, {
      schema: 1,
      capturedAt: '2026-09-16T10:00:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: -5, resets_at: 2000000000 },
      },
    });

    const result = readClaudeSnapshot({ homedir, env: {}, now: Date.parse('2026-09-16T10:05:00.000Z') });
    assert.equal(result.ok, true);
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].usedPercent, null);
    assert.equal(result.windows[0].state, undefined);
    assert.equal(result.windows[0].resetsAt, new Date(2000000000 * 1000).toISOString());
  });

  it('rejects string-typed window fields instead of coercing them', () => {
    const homedirA = tmpDir('qb-snapshot-string-used-');
    writeSnapshotFile(homedirA, {
      schema: 1,
      capturedAt: '2026-09-16T10:00:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: '12', resets_at: 2000000000 },
      },
    });
    const resA = readClaudeSnapshot({ homedir: homedirA, env: {}, now: Date.parse('2026-09-16T10:05:00.000Z') });
    assert.equal(resA.ok, true);
    assert.equal(resA.windows[0].usedPercent, null);
    assert.equal(resA.windows[0].resetsAt, new Date(2000000000 * 1000).toISOString());

    const homedirB = tmpDir('qb-snapshot-string-reset-');
    writeSnapshotFile(homedirB, {
      schema: 1,
      capturedAt: '2026-09-16T10:00:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: '2000000000' },
      },
    });
    const resB = readClaudeSnapshot({ homedir: homedirB, env: {}, now: Date.parse('2026-09-16T10:05:00.000Z') });
    assert.equal(resB.ok, true);
    assert.equal(resB.windows[0].usedPercent, 12);
    assert.equal(resB.windows[0].resetsAt, null);
  });

  it('never throws on out-of-range resets_at and drops only the reset time', () => {
    const homedir = tmpDir('qb-snapshot-range-');
    writeSnapshotFile(homedir, {
      schema: 1,
      capturedAt: '2026-09-16T10:00:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 1e13 },
      },
    });

    const result = readClaudeSnapshot({ homedir, env: {}, now: Date.parse('2026-09-16T10:05:00.000Z') });
    assert.equal(result.ok, true);
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].usedPercent, 10);
    assert.equal(result.windows[0].resetsAt, null);
    assert.equal(result.windows[0].state, undefined);
  });

  it('fails loudly when rate_limits holds no usable window', () => {
    const homedir = tmpDir('qb-snapshot-empty-limits-');
    const cases = [
      {}, // empty rate_limits
      { five_hour: 'x' },
      { five_hour: {} },
      { five_hour: { used_percentage: 'x', resets_at: 1e13 } }, // both fields invalid
    ];

    for (const rate_limits of cases) {
      writeSnapshotFile(homedir, {
        schema: 1,
        capturedAt: '2026-09-16T10:00:00.000Z',
        rate_limits,
      });
      const result = readClaudeSnapshot({ homedir, env: {}, now: Date.parse('2026-09-16T10:05:00.000Z') });
      assert.equal(result.ok, false, `must fail for ${JSON.stringify(rate_limits)}`);
      assert.equal(result.state, 'failed');
      assert.match(result.error, /没有可用的额度数据/);
    }
  });

  it('rejects an impossible calendar date in capturedAt', () => {
    const homedir = tmpDir('qb-snapshot-calendar-');
    writeSnapshotFile(homedir, {
      schema: 1,
      capturedAt: '2026-02-31T10:00:00.000Z', // February 31 does not exist
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 2000000000 },
      },
    });

    const result = readClaudeSnapshot({ homedir, env: {}, now: Date.parse('2026-09-16T10:05:00.000Z') });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /时间戳无效/);
  });

  it('marks a future capturedAt as stale with a clock-check note', () => {
    const homedir = tmpDir('qb-snapshot-future-');
    writeSnapshotFile(homedir, {
      schema: 1,
      capturedAt: '2026-09-16T12:00:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 2000000000 },
      },
    });

    const result = readClaudeSnapshot({ homedir, env: {}, now: Date.parse('2026-09-16T10:00:00.000Z') });
    assert.equal(result.ok, true);
    assert.equal(result.stale, true);
    assert.match(result.note, /时钟/);
  });

  it('getClaudeSnapshotPath prefers QUESTBOARD_HOME over homedir', () => {
    const home = tmpDir('qb-snapshot-path-env-');
    assert.equal(
      getClaudeSnapshotPath({ homedir: 'ignored-homedir', env: { QUESTBOARD_HOME: home } }),
      path.join(home, 'usage', 'claude.json')
    );
    assert.equal(
      getClaudeSnapshotPath({ homedir: home, env: {} }),
      path.join(home, '.questboard', 'usage', 'claude.json')
    );
  });

  it('ensures planted metadata fields in snapshot file are never accepted or output by reader', () => {
    const homedir = tmpDir('qb-snapshot-planted-');
    writeSnapshotFile(homedir, {
      schema: 1,
      capturedAt: '2026-09-16T10:00:00.000Z',
      session_id: 'PLANTED-SESSION-ID',
      transcript_path: '/planted/transcript.jsonl',
      cwd: '/planted/cwd',
      model: { id: 'planted-model' },
      cost: { total_cost_usd: 999 },
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 2000000000, secret_token: 'planted-token' },
      },
    });

    const result = readClaudeSnapshot({ homedir, env: {}, now: Date.parse('2026-09-16T10:05:00.000Z') });
    assert.equal(result.ok, true);
    const serialized = JSON.stringify(result);

    assert.ok(!serialized.includes('PLANTED-SESSION-ID'));
    assert.ok(!serialized.includes('planted/transcript.jsonl'));
    assert.ok(!serialized.includes('/planted/cwd'));
    assert.ok(!serialized.includes('planted-model'));
    assert.ok(!serialized.includes('999'));
    assert.ok(!serialized.includes('planted-token'));
  });
});

describe('claudeSubscription provider registration and service integration', () => {
  it('registers claudeSubscription in providers.js with official-hook access and docsUrl', () => {
    assert.equal(claudeSubscription.id, 'claude-subscription');
    assert.equal(claudeSubscription.name, 'Claude 订阅');
    assert.equal(claudeSubscription.source, 'official-hook');
    assert.equal(claudeSubscription.access, 'official-hook');
    assert.equal(claudeSubscription.credentialType, 'claude-ai-subscription');
    assert.equal(claudeSubscription.docsUrl, 'https://code.claude.com/docs/en/statusline');

    assert.ok(PROVIDERS.some((p) => p.id === 'claude-subscription'));
  });

  it('matches catalog entry in catalog.js with valid allowlisted metadata', () => {
    const catalog = getCatalogEntry('claude-subscription');
    assert.ok(catalog);
    assert.equal(catalog.id, 'claude-subscription');
    assert.equal(catalog.access, 'official-hook');
    assert.equal(catalog.credentialType, 'claude-ai-subscription');
    assert.equal(catalog.docsUrl, 'https://code.claude.com/docs/en/statusline');
    assert.doesNotThrow(() => validateCatalogEntry(catalog));
  });

  it('shows the setup step when no snapshot exists and live windows when one does', async () => {
    const homedir = tmpDir('qb-provider-replace-');

    // The manual note is single-sourced from the reader's setup note
    assert.equal(CLAUDE_MANUAL_NOTE, CLAUDE_SETUP_NOTE);

    // Case 1: No snapshot exists -> manual_only state with the exact setup-step note
    const noSnapRes = await claudeSubscription.fetch({ homedir, env: {} });
    assert.equal(noSnapRes.state, 'manual_only');
    assert.equal(noSnapRes.manual_only, true);
    assert.equal(noSnapRes.note, CLAUDE_SETUP_NOTE);
    assert.ok(noSnapRes.note.includes('examples/claude-usage-statusline.mjs'));
    assert.deepEqual(noSnapRes.windows, []);
    assert.deepEqual(noSnapRes.balances, []);

    // Case 2: Snapshot exists -> replaces manual card with ok state and quota windows
    writeSnapshotFile(homedir, {
      schema: 1,
      capturedAt: '2026-09-16T10:00:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: 2000000000 },
        spend_limit: { used_percentage: 105, resets_at: 2000000000 },
      },
    });

    const withSnapRes = await claudeSubscription.fetch({ homedir, env: {}, now: Date.parse('2026-09-16T10:05:00.000Z') });
    assert.equal(withSnapRes.ok, true);
    assert.equal(withSnapRes.state, 'ok');
    assert.equal(withSnapRes.asOf, '2026-09-16T10:00:00.000Z');
    assert.equal(withSnapRes.windows.length, 2);
    assert.equal(withSnapRes.windows[0].label, '5 小时');
    assert.equal(withSnapRes.windows[0].usedPercent, 20);
    assert.equal(withSnapRes.windows[1].label, '消费上限');
    assert.equal(withSnapRes.windows[1].usedPercent, 105);
  });

  it('asserts no child processes, no network calls, and no key lookups', async () => {
    let childCalls = 0;
    let networkCalls = 0;

    const originalExecFile = child_process.execFile;
    const originalSpawn = child_process.spawn;
    const originalExec = child_process.exec;
    const originalFetch = globalThis.fetch;

    try {
      child_process.execFile = () => { childCalls += 1; throw new Error('child_process.execFile called'); };
      child_process.spawn = () => { childCalls += 1; throw new Error('child_process.spawn called'); };
      child_process.exec = () => { childCalls += 1; throw new Error('child_process.exec called'); };
      globalThis.fetch = async () => { networkCalls += 1; throw new Error('globalThis.fetch called'); };
      module.syncBuiltinESMExports();

      assert.equal(claudeSubscription.keys, undefined, 'claudeSubscription must not define keys');
      assert.equal(claudeSubscription.oauth, undefined, 'claudeSubscription must not define oauth');

      const homedir = tmpDir('qb-provider-safety-');
      await claudeSubscription.fetch({ homedir, env: {} });

      assert.equal(childCalls, 0, 'No child process must be invoked');
      assert.equal(networkCalls, 0, 'No network call must be made');
    } finally {
      child_process.execFile = originalExecFile;
      child_process.spawn = originalSpawn;
      child_process.exec = originalExec;
      globalThis.fetch = originalFetch;
      module.syncBuiltinESMExports();
    }
  });

  it('integrates cleanly with createUsageService report, surfacing the setup step when absent', async () => {
    const homedir = tmpDir('qb-service-claude-');

    // 1. Without snapshot file: the card's error text must be the exact setup step
    const serviceWithout = createUsageService({ homedir, providers: [claudeSubscription], env: {} });
    const reportWithout = await serviceWithout.report();
    const [entryWithout] = reportWithout.providers;

    assert.equal(entryWithout.id, 'claude-subscription');
    assert.equal(entryWithout.ok, false);
    assert.equal(entryWithout.providerState, 'manual_only');
    assert.equal(entryWithout.error, CLAUDE_SETUP_NOTE);
    assert.ok(entryWithout.error.includes('在 Claude Code 里运行 /usage'), 'must tell the reader to run /usage');
    assert.ok(entryWithout.error.includes('examples/claude-usage-statusline.mjs'), 'must name the example script');
    assert.equal(entryWithout.access, 'official-hook');
    assert.equal(entryWithout.docsUrl, 'https://code.claude.com/docs/en/statusline');
    assert.deepEqual(entryWithout.windows, []);

    // 2. With snapshot file
    writeSnapshotFile(homedir, {
      schema: 1,
      capturedAt: '2026-09-16T10:00:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: 15, resets_at: 2000000000 },
        spend_limit: { used_percentage: 101, resets_at: 2000000000 },
      },
    });

    const serviceWith = createUsageService({
      homedir,
      providers: [claudeSubscription],
      env: {},
      now: () => Date.parse('2026-09-16T10:05:00.000Z'),
    });
    const reportWith = await serviceWith.report({ refresh: true });
    const [entryWith] = reportWith.providers;

    assert.equal(entryWith.id, 'claude-subscription');
    assert.equal(entryWith.ok, true);
    assert.equal(entryWith.providerState, 'ok');
    assert.equal(entryWith.asOf, '2026-09-16T10:00:00.000Z');
    assert.equal(entryWith.windows.length, 2);
    assert.equal(entryWith.windows[0].label, '5 小时');
    assert.equal(entryWith.windows[0].usedPercent, 15);
    assert.equal(entryWith.windows[1].label, '消费上限');
    assert.equal(entryWith.windows[1].usedPercent, 101);
  });
});
