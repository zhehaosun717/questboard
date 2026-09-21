// Requirements 2, 4, 5, 6, 7 (revision 3) for src/core/briefs.js discoverBriefs/readBrief. All fail on
// 47f86d9, which has no discoverBriefs at all (only a plain, uncapped unpostedBriefs scan).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { discoverBriefs, fileSetFor, MAX_BRIEF_BYTES, readDismissedBriefs, writeDismissedBrief, removeDismissedBrief } from '../../src/core/briefs.js';
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

describe('a folder read failure is this folder\'s own diagnostic, not a crash that fails the whole snapshot (F4)', () => {
  it('reports a mid-scan directory read error (EIO) for just that folder and still returns the other folder\'s briefs', () => {
    const { config, root, write } = makeProject({ briefs: { dispatchDirs: ['docs/b1', 'docs/b2'] } });
    write('docs/b2/RUN-12-ok.md', '# fine');
    const dir1 = path.join(root, 'docs', 'b1');
    const orig = fs.readdirSync;
    fs.readdirSync = (target, options) => {
      if (path.resolve(String(target)) === path.resolve(dir1)) {
        const err = new Error('input/output error');
        err.code = 'EIO';
        throw err;
      }
      return orig(target, options);
    };
    let result;
    try {
      assert.doesNotThrow(() => { result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() }); });
    } finally {
      fs.readdirSync = orig;
    }
    const err = result.errors.find((e) => e.folder === 'docs/b1');
    assert.ok(err, 'docs/b1 must report its own diagnostic');
    assert.equal(err.reason, '目录不可读（EIO）');
    assert.ok(result.items.some((i) => i.package === 'RUN-12'), 'docs/b2 must still be scanned and its brief returned');
  });
});

describe('the iteration cap states truthful seen/returned counts, never "scanned 0, complete" (requirement 5)', () => {
  // Actually creating 50000+ real files to trip MAX_DIR_ITERATE is minutes slow on NTFS; scanDirectory only
  // ever calls fs.readdirSync(dir, {withFileTypes: true}) once, so a fake Dirent array exercises the exact
  // same sort/cap logic in microseconds. 5 real .md entries mixed in prove seen/mdSeen stay separate concepts.
  function fakeDirent(name) {
    return { name, isSymbolicLink: () => false, isFile: () => true };
  }

  it('reports how many .md files were seen and returned when the raw entry cap stops the scan', () => {
    const { config, root } = makeProject();
    const dir = path.join(root, 'docs', 'briefs');
    const names = [];
    for (let i = 0; i < 5; i++) names.push(`AAA-${i}-early.md`);
    for (let i = 0; i < 50010; i++) names.push(`noise-${String(i).padStart(6, '0')}.txt`);
    const origReaddir = fs.readdirSync;
    fs.readdirSync = (target, options) => (path.resolve(String(target)) === path.resolve(dir) ? names.map(fakeDirent) : origReaddir(target, options));
    let result;
    try {
      result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() });
    } finally {
      fs.readdirSync = origReaddir;
    }
    assert.equal(result.truncated, true);
    const err = result.errors.find((e) => e.folder === 'docs/briefs');
    assert.ok(err, 'the folder must report a diagnostic');
    assert.doesNotMatch(err.reason, /扫描 0|scanned 0/i, 'must never claim it scanned nothing');
    assert.match(err.reason, /5/, 'must state the concrete .md-seen count, not just "truncated"');
  });

  it('which entries survive the raw-entry cap is a sorted, stable choice — never an accident of raw listing order (F4)', () => {
    const { config, root, write } = makeProject();
    const dir = path.join(root, 'docs', 'briefs');
    // The candidates need to actually be readable (discoverBriefs stats and peeks every .md name scanDirectory
    // returns), but scanDirectory's own directory listing is faked so 50000+ filler entries never have to
    // exist on disk.
    write('docs/briefs/AAA-1-early.md', '# early');
    write('docs/briefs/MMM-5-mid.md', '# mid');
    write('docs/briefs/ZZZZZ-9-notlast.md', '# not last');
    // The 3 real .md candidates are appended LAST in raw order, after more than MAX_DIR_ITERATE (50000)
    // filler entries that all sort AFTER them ("zzz-filler-*" > "AAA"/"MMM"). A scan that merely streams raw
    // entries and stops at the 50000th would never reach these three at all (iterationCapped, mdSeen 0) —
    // only a scan that sorts the full listing before applying the cap can find them.
    const names = [];
    for (let i = 0; i < 50002; i++) names.push(`zzz-filler-${String(i).padStart(6, '0')}.txt`);
    // "ZZZZZ-9-…" sorts after every "zzz-filler-…" filler name (verified: locale compare ranks the shared
    // "zzz" prefix ahead of a longer all-caps run), so it is always past the cap in sorted order — unlike raw
    // order, where it would win just by being appended last, and unlike a lowercase name it would never be
    // excluded as a bad package id either.
    names.push('MMM-5-mid.md', 'AAA-1-early.md', 'ZZZZZ-9-notlast.md');
    const origReaddir = fs.readdirSync;
    fs.readdirSync = (target, options) => (path.resolve(String(target)) === path.resolve(dir) ? names.map(fakeDirent) : origReaddir(target, options));
    let result;
    try {
      result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() });
    } finally {
      fs.readdirSync = origReaddir;
    }
    const briefs = result.items.map((i) => i.brief).sort();
    assert.deepEqual(briefs, ['docs/briefs/AAA-1-early.md', 'docs/briefs/MMM-5-mid.md']);
    assert.equal(result.items.some((i) => i.brief === 'docs/briefs/ZZZZZ-9-notlast.md'), false, 'sorts after all the filler names, so it must not survive the raw-entry cap');
    const err = result.errors.find((e) => e.folder === 'docs/briefs');
    assert.equal(err?.reason?.includes('停止扫描'), true, 'the iteration cap must have actually triggered, not just happened to exclude nothing');
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

  it('reports a dangling junction on the discovery shelf instead of surfacing it, with a Chinese reason (F4, discovery shelf only)', () => {
    const { config, root } = makeProject();
    // mklink /J can only target a directory, so the dangling junction itself has to be a directory entry —
    // exactly the shape a broken dispatch-briefs-style link takes. Its target is never created, so this
    // proves discovery never follows the link, dangling or not. The POST-time refusal for the same shape is
    // covered separately, through QuestStore.post, in test/core/store.test.js — this test starts and ends
    // at discovery.
    const missingTarget = path.join(root, '..', `qb-discovery-missing-target-${path.basename(root)}`);
    const junctionPath = path.join(root, 'docs', 'briefs', 'RUN-31-x.md');
    fs.mkdirSync(path.dirname(junctionPath), { recursive: true });
    try { fs.symlinkSync(missingTarget, junctionPath, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
      throw error;
    }
    assert.equal(fs.existsSync(missingTarget), false, 'test setup: the junction target must stay nonexistent');
    const result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() });
    assert.equal(result.items.some((i) => i.package === 'RUN-31'), false, 'a dangling junction must never be surfaced as a ready brief');
    const row = result.excluded.find((e) => e.brief === 'docs/briefs/RUN-31-x.md');
    assert.ok(row, 'the dangling junction must be reported, not silently dropped');
    assert.equal(row.kind, 'symlink');
    assert.equal(row.reason, '这是链接，跳过了，没有跟进去');
  });
});

describe('dismissed briefs (FB2-08 items 1,2)', () => {
  const dismissedRecords = (config) => {
    const file = path.join(config.paths.data, 'brief-dismissed.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  it('writeDismissedBrief appends one jsonl record in dataDir, outside the events namespace', () => {
    const { config, write } = makeProject();
    write('docs/briefs/RUN-11-x.md', '# d1');
    writeDismissedBrief(config, { package: 'RUN-11', brief: 'docs/briefs/RUN-11-x.md', by: 'owner', note: '在外面做完了' });
    const records = dismissedRecords(config);
    assert.equal(records.length, 1);
    assert.equal(records[0].package, 'RUN-11');
    assert.equal(records[0].brief, 'docs/briefs/RUN-11-x.md');
    assert.equal(records[0].by, 'owner');
    assert.equal(records[0].note, '在外面做完了');
    assert.ok(records[0].at);
    assert.equal(fs.existsSync(path.join(config.paths.events)), false, 'no event file was touched');
  });

  it('discoverBriefs filters a dismissed file into kind dismissed, and undismiss brings it back', () => {
    const { config, write } = makeProject();
    write('docs/briefs/RUN-12-x.md', '# d2');
    writeDismissedBrief(config, { package: 'RUN-12', brief: 'docs/briefs/RUN-12-x.md', by: 'owner', note: '忽略它' });
    const dismissed = readDismissedBriefs(config);
    const result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set(), dismissed });
    assert.equal(result.items.length, 0, 'a dismissed file is never ready');
    assert.equal(result.byKind.dismissed, 1);
    const row = result.excluded.find((e) => e.kind === 'dismissed');
    assert.equal(row.package, 'RUN-12');
    assert.match(row.reason, /忽略它/);
    removeDismissedBrief(config, { package: 'RUN-12' });
    const again = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set(), dismissed: readDismissedBriefs(config) });
    assert.equal(again.items.length, 1, 'undismiss restores the file');
    assert.equal(again.byKind.dismissed, undefined);
  });

  it('a whole-package dismissal hides every copy, and a per-file dismissal only that copy', () => {
    const { config, write } = makeProject();
    write('docs/briefs/RUN-13-x.md', '# copy one');
    const second = write('docs/briefs/RUN-13-y.md', '# copy two');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(second, past, past);
    // Per-file dismissal of the newest copy: the older copy becomes the ready item, the dismissed one is
    // kind dismissed (not duplicate), and each physical file keeps its own count.
    writeDismissedBrief(config, { package: 'RUN-13', brief: 'docs/briefs/RUN-13-x.md', by: 'owner', note: '' });
    let result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set(), dismissed: readDismissedBriefs(config) });
    assert.equal(result.items.length, 1, 'the other copy stays ready');
    assert.equal(result.items[0].brief, 'docs/briefs/RUN-13-y.md');
    assert.equal(result.byKind.dismissed, 1);
    assert.equal(result.byKind.duplicate, undefined, 'a dismissed copy is not also counted as a duplicate');
    // Whole-package dismissal hides both.
    removeDismissedBrief(config, { package: 'RUN-13' });
    writeDismissedBrief(config, { package: 'RUN-13', by: 'owner', note: '整包忽略' });
    result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set(), dismissed: readDismissedBriefs(config) });
    assert.equal(result.items.length, 0);
    assert.equal(result.byKind.dismissed, 2, 'each physical copy counts separately');
  });

  it('?unlimited keeps every excluded row instead of capping at MAX_EXCLUDED', () => {
    const { config, write } = makeProject();
    for (let i = 0; i < 305; i++) write('docs/briefs/notes-' + String(i).padStart(3, '0') + '.md', 'bad id');
    const capped = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() });
    assert.equal(capped.excluded.length, 300);
    const all = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set(), unlimited: true });
    assert.equal(all.excluded.length, 305);
    assert.equal(all.excludedTotal, 305);
    assert.equal(all.excludedTruncated, false, 'nothing was dropped, so nothing is truncated');
  });
});
