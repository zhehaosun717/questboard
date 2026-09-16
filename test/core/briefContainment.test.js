// Requirement 3 (revision 3): containment is rechecked at read/dispatch time, not only once when a brief is
// posted — and requirement 7's resolveConfig half (reject a lexically escaping folder, in Chinese, while a
// folder that only escapes via a symlink/junction still surfaces as a per-folder discovery diagnostic).
// These fail on 47f86d9, which has no containment check anywhere in this module.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../../src/core/config.js';
import { briefPathAllowed } from '../../src/core/patterns.js';
import { fileSetFor, discoverBriefs } from '../../src/core/briefs.js';
import { briefExists } from '../../src/core/snapshot.js';
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

describe('resolveConfig rejects an outside-root brief folder (requirement 7)', () => {
  const lanes = { codex: { run: ['tools/codex-run.sh', '{name}', '{brief}', '{model}', '{variant}'], outputDir: '.work/codex' } };

  it('refuses a literal ".." dispatchDirs entry with a clear Chinese message', () => {
    assert.throws(
      () => resolveConfig('E:/game', { name: 'Game', lanes, briefs: { dispatchDirs: ['../outside'] } }),
      /配置目录在项目外/,
    );
  });

  it('refuses an absolute ownerDirs entry outside root', () => {
    assert.throws(
      () => resolveConfig('E:/game', { name: 'Game', lanes, briefs: { ownerDirs: ['C:/elsewhere'] } }),
      /配置目录在项目外/,
    );
  });

  it('still accepts an ordinary relative folder', () => {
    const config = resolveConfig('E:/game', { name: 'Game', lanes, briefs: { dispatchDirs: ['docs/briefs'] } });
    assert.deepEqual(config.briefs.dispatchDirs, ['docs/briefs']);
  });
});

describe('containment rechecked at read/dispatch time, not only at post (requirement 3)', () => {
  it('briefPathAllowed refuses a not-yet-existing folder under a junction that escapes root, before and after the file appears', (t) => {
    const { config, root } = makeProject({ briefs: { dispatchDirs: ['docs/jdir/sub'] } });
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-outside-'));
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    const made = trySymlink(outside, path.join(root, 'docs', 'jdir'), 'junction');
    if (!made) { t.skip('junction creation refused (EPERM) on this machine'); return; }
    // The folder itself ("sub") does not exist yet — this must not be read as "safe because unverifiable".
    assert.equal(briefPathAllowed(config, 'docs/jdir/sub/RUN-5-x.md', 'code'), false, 'a folder that does not exist yet under an escaping junction must still be refused');
    fs.mkdirSync(path.join(outside, 'sub'));
    fs.writeFileSync(path.join(outside, 'sub', 'RUN-5-x.md'), '# T\n\n## Files you may edit\n- `src/shared.js`\n');
    assert.equal(briefPathAllowed(config, 'docs/jdir/sub/RUN-5-x.md', 'code'), false, 'still refused once the outside file actually exists');
  });

  it('fileSetFor and briefExists refuse to read a brief whose folder now resolves outside the project, even for an already-posted quest', (t) => {
    const { config, root } = makeProject({ briefs: { dispatchDirs: ['docs/jdir'] } });
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-outside2-'));
    fs.writeFileSync(path.join(outside, 'RUN-6-x.md'), '# T\n\n## Files you may edit\n- `src/shared.js`\n');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    const made = trySymlink(outside, path.join(root, 'docs', 'jdir'), 'junction');
    if (!made) { t.skip('junction creation refused (EPERM) on this machine'); return; }
    const quest = { id: 'RUN-6', kind: 'code', brief: 'docs/jdir/RUN-6-x.md' };
    assert.deepEqual(fileSetFor(config, quest.brief), [], 'must never read the outside file\'s real content');
    assert.equal(briefExists(config, quest), false, 'briefExists must refuse a brief outside the project even though the path exists on disk');
  });

  it('discovery still reports the escaping junction as a per-folder diagnostic (the "legacy" case resolveConfig cannot catch lexically)', (t) => {
    const { config, root } = makeProject({ briefs: { dispatchDirs: ['docs/jdir'] } });
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-outside3-'));
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    const made = trySymlink(outside, path.join(root, 'docs', 'jdir'), 'junction');
    if (!made) { t.skip('junction creation refused (EPERM) on this machine'); return; }
    const result = discoverBriefs(config, { postedIds: new Set(), dispatchedIds: new Set() });
    assert.equal(result.items.length, 0);
    assert.ok(result.errors.some((e) => e.folder === 'docs/jdir' && /项目外/.test(e.reason)));
  });
});
