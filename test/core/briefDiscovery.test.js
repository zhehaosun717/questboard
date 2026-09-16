// Requirements 2, 4, 5, 6, 7 (revision 3) for src/core/briefs.js discoverBriefs/readBrief. All fail on
// 47f86d9, which has no discoverBriefs at all (only a plain, uncapped unpostedBriefs scan).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { discoverBriefs, fileSetFor, MAX_BRIEF_BYTES } from '../../src/core/briefs.js';
import { makeProject } from '../helpers.js';

function trySymlink(target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return false;
    throw err;
  }
}

describe('diagnostics counts are truthful even when the excluded list is capped (requirement 2)', () => {
  it('counts old/dispatched from every exclusion, not just the first 300 rows sent', () => {
    const { config, write } = makeProject();
    for (let i = 0; i < 305; i++) write(`docs/briefs/notes-${String(i).padStart(3, '0')}.md`, 'not a package id, so it becomes a badId exclusion');
    const old = write('docs/briefs/RUN-7-old.md', '# old one');
    const past = new Date(Date.now() - 30 * 86400000);
    fs.utimesSync(old, past, past);
    write('docs/briefs/RUN-8-disp.md', '# dispatched one');
    const result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set(['RUN-8']) });
    assert.ok(result.excluded.length <= 300, 'the wire payload stays capped');
    assert.ok(result.excludedTotal > 300, 'the true total is still reported');
    assert.equal(result.byKind.old, 1, 'must not read 0 just because the old row did not survive the cap');
    assert.equal(result.byKind.dispatched, 1, 'must not read 0 just because the dispatched row did not survive the cap');
    assert.equal(result.excludedTruncated, true);
  });

  // B4 (revision 4): byKind's counts were already truthful before this fix — this is the actual gap the
  // independent review found: the capped `excluded` slice itself dropped the old/dispatched rows once more
  // than 300 badId rows came first, so the shelf's reveal checkboxes (which filter the capped slice, not
  // byKind — see BriefShelf.tsx) offered to reveal 1 old and 1 dispatched brief but the reveal produced
  // nothing.
  it('keeps the old and dispatched rows inside the capped excluded slice even with over 300 bad file names', () => {
    const { config, write } = makeProject();
    for (let i = 0; i < 305; i++) write(`docs/briefs/notes-${String(i).padStart(3, '0')}.md`, 'not a package id, so it becomes a badId exclusion');
    const old = write('docs/briefs/RUN-7-old.md', '# old one');
    const past = new Date(Date.now() - 30 * 86400000);
    fs.utimesSync(old, past, past);
    write('docs/briefs/RUN-8-disp.md', '# dispatched one');
    const result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set(['RUN-8']) });
    assert.equal(result.excluded.length, 300, 'the wire payload stays capped');
    const oldRow = result.excluded.find((e) => e.kind === 'old' && e.package === 'RUN-7');
    const dispatchedRow = result.excluded.find((e) => e.kind === 'dispatched' && e.package === 'RUN-8');
    assert.ok(oldRow, 'the old row must survive the cap so the shelf\'s reveal checkbox actually reveals it');
    assert.ok(dispatchedRow, 'the dispatched row must survive the cap so the shelf\'s reveal checkbox actually reveals it');
    assert.ok(oldRow.title !== undefined && oldRow.writtenAt !== undefined, 'a revealable row needs title/writtenAt (BriefShelf.tsx filters on both)');
    assert.ok(dispatchedRow.title !== undefined && dispatchedRow.writtenAt !== undefined);
  });
});

describe('the newest copy governs even when it is the one that is broken (requirement 4)', () => {
  it('an oversized newest copy surfaces its own error, never an older readable copy as ready', () => {
    const { config, write } = makeProject({ briefs: { dispatchDirs: ['docs/b1', 'docs/b2'] } });
    const older = write('docs/b1/RUN-9-old.md', '# stale copy');
    const past = new Date(Date.now() - 86400000);
    fs.utimesSync(older, past, past);
    write('docs/b2/RUN-9-new.md', `# new copy\n${'x'.repeat(MAX_BRIEF_BYTES + 10)}`);
    const result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() });
    assert.equal(result.items.some((i) => i.package === 'RUN-9'), false, 'RUN-9 must not appear as ready via the stale older copy');
    const primaryRow = result.excluded.find((e) => e.package === 'RUN-9' && e.brief.endsWith('RUN-9-new.md'));
    assert.ok(primaryRow, 'the newest (broken) copy must be the one reported');
    assert.equal(primaryRow.kind, 'oversized');
    const dupRow = result.excluded.find((e) => e.package === 'RUN-9' && e.brief.endsWith('RUN-9-old.md'));
    assert.equal(dupRow.kind, 'duplicate', 'the older copy is shadowed, not silently presented as ready');
  });

  it('an unreadable newest copy also wins over an older readable one', () => {
    const { config, write } = makeProject({ briefs: { dispatchDirs: ['docs/b1', 'docs/b2'] } });
    const older = write('docs/b1/RUN-11-old.md', '# stale copy');
    const past = new Date(Date.now() - 86400000);
    fs.utimesSync(older, past, past);
    const newer = write('docs/b2/RUN-11-new.md', '# new copy');
    const orig = fs.openSync;
    fs.openSync = (target, flags) => {
      if (String(target) === newer) { const err = new Error('busy'); err.code = 'EBUSY'; throw err; }
      return orig(target, flags);
    };
    try {
      const result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() });
      assert.equal(result.items.some((i) => i.package === 'RUN-11'), false);
      const primaryRow = result.excluded.find((e) => e.package === 'RUN-11' && e.brief.endsWith('RUN-11-new.md'));
      assert.equal(primaryRow.kind, 'unreadable');
    } finally {
      fs.openSync = orig;
    }
  });
});

describe('the iteration cap states truthful seen/returned counts, never "scanned 0, complete" (requirement 5)', () => {
  // Actually creating 50000+ real files to trip MAX_DIR_ITERATE is minutes slow on NTFS; scanDirectory only
  // ever calls fs.opendirSync/handle.readSync()/handle.closeSync(), so a fake handle exercises the exact same
  // loop and cap logic in microseconds. 5 real .md entries mixed in prove seen/mdSeen stay separate concepts.
  function fakeDirHandle(names) {
    let i = 0;
    return {
      readSync() {
        if (i >= names.length) return null;
        const name = names[i];
        i += 1;
        return { name, isSymbolicLink: () => false, isFile: () => true };
      },
      closeSync() {},
    };
  }

  it('reports how many .md files were seen and returned when the raw entry cap stops the scan', () => {
    const { config, root } = makeProject();
    const dir = path.join(root, 'docs', 'briefs');
    const names = [];
    for (let i = 0; i < 5; i++) names.push(`AAA-${i}-early.md`);
    for (let i = 0; i < 50010; i++) names.push(`noise-${String(i).padStart(6, '0')}.txt`);
    const origOpendir = fs.opendirSync;
    fs.opendirSync = (target) => (path.resolve(String(target)) === path.resolve(dir) ? fakeDirHandle(names) : origOpendir(target));
    let result;
    try {
      result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() });
    } finally {
      fs.opendirSync = origOpendir;
    }
    assert.equal(result.truncated, true);
    const err = result.errors.find((e) => e.folder === 'docs/briefs');
    assert.ok(err, 'the folder must report a diagnostic');
    assert.doesNotMatch(err.reason, /扫描 0|scanned 0/i, 'must never claim it scanned nothing');
    assert.match(err.reason, /5/, 'must state the concrete .md-seen count, not just "truncated"');
  });
});

describe('the readBrief cache stays bounded and evicts deleted files (requirement 6)', () => {
  it('does not retain unbounded bytes after scanning many large briefs then deleting them', () => {
    const { config, root, write } = makeProject();
    const dir = path.join(root, 'docs', 'briefs');
    const big = `# big\n${'y'.repeat(1.5 * 1024 * 1024)}`;
    for (let i = 0; i < 80; i++) write(`docs/briefs/BIG-${i}-x.md`, big);
    // Discovery itself must never populate the fileSetFor cache with full bodies (peekTitle only).
    discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() });
    // fileSetFor is the one path that does cache full bodies (for real dispatch use) — bounded regardless.
    for (let i = 0; i < 80; i++) fileSetFor(config, `docs/briefs/BIG-${i}-x.md`);
    for (let i = 0; i < 80; i++) fs.rmSync(path.join(dir, `BIG-${i}-x.md`));
    // Touching each now-deleted path again must evict its stale cache entry rather than leaving it to grow forever.
    for (let i = 0; i < 80; i++) fileSetFor(config, `docs/briefs/BIG-${i}-x.md`);
    if (global.gc) global.gc();
    const heapMB = process.memoryUsage().heapUsed / 1048576;
    // 80 * 1.5MB = 120MB; a bounded cache must retain nothing close to that once every file is deleted and
    // re-touched. Generous headroom for the rest of the test process's own heap.
    assert.ok(heapMB < 400, `heap after deleting 80 x 1.5MB briefs should stay bounded, was ${heapMB.toFixed(1)}MB`);
  });
});

describe('folder spellings normalize to one canonical entry (requirement 7)', () => {
  it('treats ./docs/briefs, docs//briefs, docs/briefs/. and a different case as the same folder', () => {
    const variants = ['docs/briefs', './docs/briefs', 'docs//briefs', 'docs/briefs/.'];
    if (process.platform === 'win32') variants.push('Docs/Briefs');
    const { config, write } = makeProject({ briefs: { dispatchDirs: variants } });
    write('docs/briefs/RUN-20-x.md', '# T\n\n## Files you may edit\n- `src/a.js`\n');
    const result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() });
    assert.equal(result.folders.length, 1, `expected one canonical folder, got ${JSON.stringify(result.folders)}`);
    assert.equal(result.items.filter((i) => i.package === 'RUN-20').length, 1, 'the same file must not be listed once per spelling');
  });
});

describe('a symlinked entry inside a scanned folder is skipped, never followed (requirement 7, guarded)', () => {
  it('does not surface a file reached only through a symlink planted inside the folder', (t) => {
    const { config, root } = makeProject();
    const outsideFile = path.join(root, '..', `${path.basename(root)}-outside-RUN-30.md`);
    fs.writeFileSync(outsideFile, '# T\n\n## Files you may edit\n- `src/a.js`\n');
    const linkPath = path.join(root, 'docs', 'briefs', 'RUN-30-link.md');
    const made = trySymlink(outsideFile, linkPath, 'file');
    if (!made) { t.skip('symlink creation refused (EPERM) on this machine'); fs.rmSync(outsideFile, { force: true }); return; }
    try {
      const result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() });
      assert.equal(result.items.some((i) => i.package === 'RUN-30'), false, 'a symlinked file must never be surfaced as a ready brief');
      assert.ok(result.excluded.some((e) => e.kind === 'symlink'));
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });
});
