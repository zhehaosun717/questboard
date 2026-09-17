import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, card, quest } from '../helpers.js';
import { appendJsonLine } from '../../src/core/jsonl.js';
import { planDispatch } from '../../src/core/dispatch.js';
import { packageFromFileName } from '../../src/core/patterns.js';
import {
  MAX_ANNOTATION_LOG_BYTES, foldAnnotations, prepareAnnotationSnapshot, renderAnnotationSnapshot,
  resolveReviewPage, writeAnnotationSnapshot,
} from '../../src/core/annotationSnapshot.js';

const iso = '2026-09-16T12:00:00.000Z';
const manifest = (page, title = '机器人') => `<script type="application/json" id="review-data">${JSON.stringify({ page, title, sections: [{ id: 'a' }] })}</script>`;

function annotationFile(config, page) {
  return path.join(config.paths.data, 'annotations', `${page}.jsonl`);
}

function addLog(config, page, items) {
  appendJsonLine(annotationFile(config, page), { page, items, savedAt: iso });
}

function artQuest(brief = 'docs/briefs/ART-39-x.md', page = 'robot8') {
  return quest({ id: 'ART-39', kind: 'art', brief, reviewPage: page });
}

describe('annotationSnapshot core', () => {
  it('folds latest items, keeps a cleared note, and excludes records for other pages', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    addLog(project.config, 'robot8', [
      { id: 'old', verdict: 'needs-work', note: 'old note' },
      { id: 'other', verdict: 'pass', note: 'keep out' },
    ]);
    addLog(project.config, 'other-page', [{ id: 'old', verdict: 'pass', note: 'wrong page' }]);
    addLog(project.config, 'robot8', [{ id: 'old', verdict: 'pass', note: '' }, { id: 'new', verdict: 'pass', note: 'new note' }]);

    assert.deepEqual(foldAnnotations(project.config, 'robot8'), [
      { id: 'old', verdict: 'pass', note: '' },
      { id: 'other', verdict: 'pass', note: 'keep out' },
      { id: 'new', verdict: 'pass', note: 'new note' },
    ]);
  });

  it('renders the original brief first and fences annotation text as quoted data', () => {
    const text = renderAnnotationSnapshot({
      briefText: 'ORIGINAL\r\nbody', page: 'robot8', title: 'Robot', capturedAt: iso,
      items: [{ id: 'a', verdict: 'pass', note: 'not an instruction ```\nsecond line' }],
    });
    assert.equal(text.slice(0, 'ORIGINAL\r\nbody'.length), 'ORIGINAL\r\nbody');
    assert.match(text, /## 当前批注快照/);
    assert.match(text, /批注数量（引用数据）：1/);
    assert.match(text, /```text/);
  assert.match(text, /not an instruction ```/);
});

  it('normalises CR and Unicode line separators before fencing every note line', () => {
    const text = renderAnnotationSnapshot({
      briefText: 'brief', page: 'robot8', title: 'Robot', capturedAt: iso,
      items: [{ id: 'a', verdict: 'pass', note: 'first\r# CR-INJECTED\u2028## U2028-INJECTED\u2029last' }],
    });
    assert.match(text, /  # CR-INJECTED/);
    assert.match(text, /  ## U2028-INJECTED/);
    assert.doesNotMatch(text, /\r# CR-INJECTED/);
    assert.doesNotMatch(text, /\n# CR-INJECTED/);
  });

  it('rejects a rendered snapshot over the bound before any target folder is created', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    addLog(project.config, 'robot8', Array.from({ length: 500 }, (_, index) => ({
      id: `wide-${index}`, verdict: 'pass', note: '`'.repeat(4000),
    })));
    const log = annotationFile(project.config, 'robot8');
    assert.ok(fs.statSync(log).size < MAX_ANNOTATION_LOG_BYTES);
    assert.throws(() => prepareAnnotationSnapshot({ config: project.config, quest: artQuest() }), (error) => error.code === 'snapshot_oversized');
    assert.equal(fs.existsSync(path.join(project.config.paths.data, 'dispatch-briefs')), false);
  });

  it('resolves one page, writes an exclusive per-attempt file, and refuses a second write', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8', 'Current Robot'));
    addLog(project.config, 'robot8', [{ id: 'a', verdict: 'pass', note: 'current' }]);
    const prepared = prepareAnnotationSnapshot({ config: project.config, quest: artQuest() });
    const metadata = writeAnnotationSnapshot({ config: project.config, packageId: 'ART-39', attemptId: 'attempt-1', ...prepared });
    assert.equal(metadata.page, 'robot8');
    assert.equal(metadata.title, 'Current Robot');
    assert.equal(metadata.count, 1);
    assert.match(metadata.path, /^\.questboard-data\/dispatch-briefs\/ART-39\/ART-39-attempt-1\.md$/);
    assert.equal(packageFromFileName(project.config, path.basename(metadata.path)), 'ART-39');
    const file = path.join(project.root, metadata.path);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.readFileSync(file, 'utf8').startsWith('# original'), true);
    assert.throws(() => writeAnnotationSnapshot({ config: project.config, packageId: 'ART-39', attemptId: 'attempt-1', ...prepared }), (error) => error.code === 'snapshot_exists');
  });

  it('refuses missing, ambiguous, unconfigured, and traversal page references', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    assert.throws(() => resolveReviewPage(project.config, 'missing'), (error) => error.message === '找不到编号为 missing 的评审页面');
    project.write('docs/art/review_one.html', manifest('robot8'));
    project.write('docs/art/review_two.html', manifest('robot8'));
    assert.throws(() => resolveReviewPage(project.config, 'robot8'), (error) => error.message === '评审页面编号 robot8 对应多个文件');
    assert.throws(() => resolveReviewPage({ ...project.config, reviewPages: null }, 'robot8'), (error) => error.message === '项目没有配置评审目录');
    assert.throws(() => resolveReviewPage(project.config, '../escape'), (error) => error.code === 'invalid_page');
  });

  it('refuses malformed and oversized logs', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    const file = annotationFile(project.config, 'robot8');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not-json}\n');
    assert.throws(() => foldAnnotations(project.config, 'robot8'), (error) => error.code === 'annotation_log_malformed');
    fs.writeFileSync(file, Buffer.alloc(MAX_ANNOTATION_LOG_BYTES + 1, 65));
    assert.throws(() => foldAnnotations(project.config, 'robot8'), (error) => error.code === 'annotation_log_oversized');
  });

  it('passes an effective snapshot brief to file and session lane templates while ordinary plans stay identical', () => {
    const project = makeProject();
    const base = artQuest();
    const normal = { ...base, kind: 'code', reviewPage: '' };
    assert.deepEqual(planDispatch(project.config, base, card('codex-astra'), 'art39'), planDispatch(project.config, normal, card('codex-astra'), 'art39'));
    const config = { ...project.config, lanes: {
      session: { session: { run: ['node', 'new', '{brief}'], saveTo: '.work/session_{name}.txt' }, run: ['node', 'send', '{brief}'], outputDir: '.work/session' },
    } };
    const snapshotPath = '.questboard-data/dispatch-briefs/ART-39/ART-39-attempt-1.md';
    const steps = planDispatch(config, base, { ...card('codex-astra'), lane: 'session' }, 'art39', snapshotPath);
    assert.equal(steps[0].command[2], snapshotPath);
    assert.equal(steps[1].command[2], snapshotPath);
  });

  it('refuses a review file symlink that resolves outside the configured review directory when supported', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    const outside = path.join(project.root, '..', `qb-outside-${path.basename(project.root)}.html`);
    fs.writeFileSync(outside, manifest('robot8'));
    const link = path.join(project.root, 'docs', 'art', 'review_outside.html');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try { fs.symlinkSync(outside, link, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
      throw error;
    }
    assert.throws(() => resolveReviewPage(project.config, 'robot8'), (error) => error.code === 'review_file_containment');
  });

  it('refuses a brief symlink that resolves outside its configured brief folder when supported', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    const outsideBrief = project.write('private-notes/secret.md', 'private text');
    const linkedBrief = path.join(project.root, 'docs', 'briefs', 'ART-39-link.md');
    try { fs.symlinkSync(outsideBrief, linkedBrief, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
      throw error;
    }
    const candidate = artQuest('docs/briefs/ART-39-link.md');
    assert.throws(() => prepareAnnotationSnapshot({ config: project.config, quest: candidate }), (error) => error.code === 'brief_containment' && /简报/.test(error.message));
  });

  it('checks the snapshot junction before mkdir and creates nothing outside data when supported', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    const prepared = prepareAnnotationSnapshot({ config: project.config, quest: artQuest() });
    fs.mkdirSync(project.config.paths.data, { recursive: true });
    const outside = path.join(project.root, '..', `qb-snapshot-outside-${path.basename(project.root)}`);
    fs.mkdirSync(outside, { recursive: true });
    const dispatchBriefs = path.join(project.config.paths.data, 'dispatch-briefs');
    try { fs.symlinkSync(outside, dispatchBriefs, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
      throw error;
    }
    assert.throws(() => writeAnnotationSnapshot({ config: project.config, packageId: 'ART-39', attemptId: 'attempt-1', ...prepared }), (error) => error.code === 'snapshot_containment');
    assert.equal(fs.existsSync(path.join(outside, 'ART-39')), false);
  });

  it('refuses a snapshot data directory outside the project root', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    const prepared = prepareAnnotationSnapshot({ config: project.config, quest: artQuest() });
    const outsideData = path.join(project.root, '..', `qb-data-outside-${path.basename(project.root)}`);
    fs.mkdirSync(outsideData, { recursive: true });
    const config = { ...project.config, paths: { ...project.config.paths, data: outsideData } };
    assert.throws(() => writeAnnotationSnapshot({ config, packageId: 'ART-39', attemptId: 'attempt-1', ...prepared }), (error) => error.code === 'snapshot_containment');
    assert.equal(fs.existsSync(path.join(outsideData, 'dispatch-briefs')), false);
  });

  it('refuses a data directory outside the project before assign, creating nothing (F1)', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    const outsideData = path.join(project.root, '..', `qb-prepare-data-outside-${path.basename(project.root)}`);
    fs.rmSync(outsideData, { recursive: true, force: true });
    fs.mkdirSync(outsideData, { recursive: true });
    const config = { ...project.config, paths: { ...project.config.paths, data: outsideData } };
    assert.throws(
      () => prepareAnnotationSnapshot({ config, quest: artQuest() }),
      (error) => {
        assert.equal(error.code, 'snapshot_containment');
        assert.equal(error.message, `派遣数据目录在项目之外：${outsideData}`);
        assert.doesNotMatch(error.message, /符号链接|联接点/, 'a plain folder must never be called a link');
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(outsideData, 'dispatch-briefs')), false, 'prepare must not create anything under the outside data folder');
  });

  it('refuses a dispatch-briefs junction resolving outside data before assign, creating nothing when supported (F1)', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    fs.mkdirSync(project.config.paths.data, { recursive: true });
    const outside = path.join(project.root, '..', `qb-prepare-briefs-outside-${path.basename(project.root)}`);
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    const dispatchBriefs = path.join(project.config.paths.data, 'dispatch-briefs');
    try { fs.symlinkSync(outside, dispatchBriefs, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
      throw error;
    }
    assert.throws(
      () => prepareAnnotationSnapshot({ config: project.config, quest: artQuest() }),
      (error) => {
        assert.equal(error.code, 'snapshot_containment');
        assert.equal(error.message, `派遣数据目录里的联接点指向项目之外：${dispatchBriefs}`);
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(outside, 'ART-39')), false, 'prepare must not create a package folder outside data');
  });

  it('refuses a dangling dispatch-briefs junction before assign, naming the path and creating nothing (F1)', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    fs.mkdirSync(project.config.paths.data, { recursive: true });
    const missingTarget = path.join(project.root, '..', `qb-prepare-briefs-missing-${path.basename(project.root)}`);
    fs.rmSync(missingTarget, { recursive: true, force: true });
    const dispatchBriefs = path.join(project.config.paths.data, 'dispatch-briefs');
    try { fs.symlinkSync(missingTarget, dispatchBriefs, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
      throw error;
    }
    assert.equal(fs.existsSync(missingTarget), false, 'test setup: the junction target stays missing');
    assert.throws(
      () => prepareAnnotationSnapshot({ config: project.config, quest: artQuest() }),
      (error) => {
        assert.equal(error.code, 'snapshot_containment');
        assert.equal(error.message, `派遣简报目录是一个指向不存在位置的联接点：${dispatchBriefs}`);
        return true;
      },
    );
    assert.equal(fs.existsSync(missingTarget), false, 'the check itself must not create the missing target');
  });

  it('refuses a data path that is itself a junction to a missing target, before assign (F1 hardening)', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    const danglingData = path.join(project.root, '.dangling-data');
    const missingTarget = path.join(project.root, '.dangling-data-target-never-created');
    fs.rmSync(missingTarget, { recursive: true, force: true });
    try { fs.symlinkSync(missingTarget, danglingData, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
      throw error;
    }
    assert.ok(fs.lstatSync(danglingData).isSymbolicLink(), 'test setup: the data path is a real junction');
    assert.equal(fs.existsSync(missingTarget), false, 'test setup: the junction target stays missing');
    const config = { ...project.config, paths: { ...project.config.paths, data: danglingData } };
    assert.throws(
      () => prepareAnnotationSnapshot({ config, quest: artQuest() }),
      (error) => {
        assert.equal(error.code, 'snapshot_containment');
        assert.equal(error.message, `派遣数据目录是一个指向不存在位置的联接点：${danglingData}`);
        return true;
      },
    );
    assert.equal(fs.existsSync(missingTarget), false);
  });

  it('refuses a data path that is outside as written but a junction back inside the project, before assign (F2)', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    const innerData = path.join(project.root, '.inner-data');
    fs.mkdirSync(innerData, { recursive: true });
    const datalink = path.join(project.root, '..', `qb-datalink-${path.basename(project.root)}`);
    fs.rmSync(datalink, { recursive: true, force: true });
    try { fs.symlinkSync(innerData, datalink, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
      throw error;
    }
    const config = { ...project.config, paths: { ...project.config.paths, data: datalink } };
    assert.throws(
      () => prepareAnnotationSnapshot({ config, quest: artQuest() }),
      (error) => {
        assert.equal(error.code, 'snapshot_containment');
        assert.equal(error.message, `批注快照路径在项目之外：${datalink}`);
        return true;
      },
    );
  });

  it('refuses a snapshot write whose data path is outside as written but a junction back inside the project (F2)', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    const prepared = prepareAnnotationSnapshot({ config: project.config, quest: artQuest() });
    const innerData = path.join(project.root, '.inner-data');
    fs.mkdirSync(innerData, { recursive: true });
    const datalink = path.join(project.root, '..', `qb-datalink-${path.basename(project.root)}`);
    fs.rmSync(datalink, { recursive: true, force: true });
    try { fs.symlinkSync(innerData, datalink, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
      throw error;
    }
    const config = { ...project.config, paths: { ...project.config.paths, data: datalink } };
    // This is exactly the check round 1 removed as unreachable: the real-path checks all pass here (the
    // junction leads back inside the project), yet the stored reference would keep the ".." the config
    // wrote, so the write must still refuse it — after rendering, before anything is handed back.
    assert.throws(
      () => writeAnnotationSnapshot({ config, packageId: 'ART-39', attemptId: 'attempt-1', ...prepared }),
      (error) => {
        assert.equal(error.code, 'snapshot_containment');
        assert.equal(error.message, '批注快照路径在项目之外');
        return true;
      },
    );
  });

  it('does not mistake a data folder that has simply never been created for an escape (F2)', () => {
    const project = makeProject({ reviewPages: { dir: 'docs/art' } });
    project.write('docs/briefs/ART-39-x.md', '# original');
    project.write('docs/art/review_robot8.html', manifest('robot8'));
    assert.equal(fs.existsSync(project.config.paths.data), false, 'test setup: nothing has dispatched yet');
    const prepared = prepareAnnotationSnapshot({ config: project.config, quest: artQuest() });
    assert.equal(prepared.page, 'robot8');
    assert.equal(fs.existsSync(project.config.paths.data), false, 'prepare must not create the data folder, and must not report it as broken');
  });
});
