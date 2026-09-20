// FB2-02 item 3: before a redo spawns, the previous attempts' delivery artifacts are copied aside.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { backupPreviousAttempts } from '../../src/core/dispatchBackup.js';
import { makeProject, quest } from '../helpers.js';

function setup() {
  const { config, write } = makeProject();
  const lane = config.lanes.codex;
  return { config, write, lane };
}

describe('dispatchBackup', () => {
  it('copies a previous attempt\'s artifacts into a .bak dir and leaves the originals untouched', () => {
    const { config, write, lane } = setup();
    write('.work/codex/mod20.out', 'old log');
    write('.work/codex/mod20.exit', '{"code":0}');
    write('.work/codex/other.out', 'not ours');
    const redo = quest({ id: 'MOD-20', dispatches: [{ attemptId: 'a1', name: 'mod20' }] });
    const backups = backupPreviousAttempts({ config, quest: redo, lane });
    assert.equal(backups.length, 1);
    assert.match(backups[0].backup, /^\.work\/codex\/mod20\.bak-\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(backups[0].files.sort(), ['mod20.exit', 'mod20.out']);
    const dir = path.join(config.root, backups[0].backup);
    assert.equal(fs.readFileSync(path.join(dir, 'mod20.out'), 'utf8'), 'old log');
    assert.equal(fs.readFileSync(path.join(dir, 'mod20.exit'), 'utf8'), '{"code":0}');
    assert.equal(fs.readFileSync(path.join(config.root, '.work/codex/mod20.out'), 'utf8'), 'old log', 'original stays');
    assert.equal(fs.existsSync(path.join(dir, 'other.out')), false, 'unrelated files are not copied');
  });

  it('backs up both output and delivery dirs, dedupes them, and skips names without files', () => {
    const { config, write } = setup();
    write('.work/codex/mod21.out', 'log');
    const lane = { outputDir: '.work/codex', deliveryDir: '.work/codex' };
    const redo = quest({ id: 'MOD-21', dispatches: [{ attemptId: 'a1', name: 'mod21' }, { attemptId: 'a0', name: 'ghost' }] });
    const backups = backupPreviousAttempts({ config, quest: redo, lane });
    assert.equal(backups.length, 1, 'same dir twice is one backup; the name with no files is skipped');
    assert.equal(backups[0].name, 'mod21');
  });

  it('returns no backups for a first dispatch', () => {
    const { config, lane } = setup();
    assert.deepEqual(backupPreviousAttempts({ config, quest: quest({ id: 'MOD-22' }), lane }), []);
  });

  it('names the failed step when the backup cannot be made, and never deletes the source', () => {
    const { config, write } = setup();
    write('.work/codex/mod23.out', 'log');
    const now = new Date('2026-09-20T08:00:00.000Z');
    // A plain file sitting where the backup folder must go: mkdir cannot become it, the copy never runs.
    write('.work/codex/mod23.bak-2026-09-20T08-00-00-000Z', 'squatter');
    const redo = quest({ id: 'MOD-23', dispatches: [{ attemptId: 'a1', name: 'mod23' }] });
    assert.throws(
      () => backupPreviousAttempts({ config, quest: redo, lane: config.lanes.codex, now }),
      /备份失败|备份目录/,
    );
    assert.equal(fs.readFileSync(path.join(config.root, '.work/codex/mod23.out'), 'utf8'), 'log', 'source untouched');
  });
});
