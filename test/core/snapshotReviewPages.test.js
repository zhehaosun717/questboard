// FB2-11 item 1: reviewPages only recognises pages at depth 1 of the review directory, and only in
// subdirectories that carry a manifest.json — src/, before/ and other nested working directories are
// ignored by construction.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reviewPages } from '../../src/core/snapshot.js';
import { makeProject } from '../helpers.js';

function writeReviewPage(root, dir, filename, manifestPage, title) {
  const fullDir = path.join(root, dir);
  fs.mkdirSync(fullDir, { recursive: true });
  const manifest = { page: manifestPage, title: title || manifestPage, sections: [{ id: 's1' }, { id: 's2' }] };
  const html = '<!DOCTYPE html><html><head><script type="application/json" id="review-data">' +
    JSON.stringify(manifest) + '</script></head><body></body></html>';
  fs.writeFileSync(path.join(fullDir, filename), html);
}

describe('reviewPages depth-1 + manifest.json filtering (FB2-11 item 1)', () => {
  it('lists html files only in depth-1 subdirectories that have manifest.json', () => {
    const { config, write } = makeProject({ reviewPages: { dir: 'docs/review' } });
    const root = path.join(config.root, 'docs', 'review');
    fs.mkdirSync(root, { recursive: true });

    // A valid review page: depth-1 directory with manifest.json + matching html.
    writeReviewPage(config.root, 'docs/review/char-a', 'review_char-a.html', 'char-a-final', 'Char A Final');
    fs.writeFileSync(path.join(root, 'char-a', 'manifest.json'), '{}');

    // Another valid review page in a different depth-1 directory.
    writeReviewPage(config.root, 'docs/review/char-b', 'review_char-b.html', 'char-b-final', 'Char B Final');
    fs.writeFileSync(path.join(root, 'char-b', 'manifest.json'), '{}');

    const pages = reviewPages(config);
    assert.equal(pages.length, 2);
    const ids = pages.map((p) => p.page).sort();
    assert.deepEqual(ids, ['char-a-final', 'char-b-final']);
  });

  it('ignores html files in directories without manifest.json', () => {
    const { config } = makeProject({ reviewPages: { dir: 'docs/review' } });
    const root = path.join(config.root, 'docs', 'review');
    fs.mkdirSync(root, { recursive: true });

    // Directory with html but NO manifest.json — should be ignored.
    writeReviewPage(config.root, 'docs/review/no-manifest', 'review_x.html', 'x-page', 'X');

    // Directory with manifest.json but html does not match the filePattern — should be ignored.
    const dirWithManifest = path.join(root, 'wrong-pattern');
    fs.mkdirSync(dirWithManifest, { recursive: true });
    fs.writeFileSync(path.join(dirWithManifest, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(dirWithManifest, 'index.html'), '<html></html>');

    const pages = reviewPages(config);
    assert.equal(pages.length, 0, 'no manifest.json → ignored; wrong filePattern → ignored');
  });

  it('ignores nested subdirectories (src/, before/) even when they have manifest.json', () => {
    const { config } = makeProject({ reviewPages: { dir: 'docs/review' } });
    const root = path.join(config.root, 'docs', 'review');
    fs.mkdirSync(root, { recursive: true });

    // Valid depth-1 directory.
    writeReviewPage(config.root, 'docs/review/ok-page', 'review_ok.html', 'ok-page', 'OK');
    fs.writeFileSync(path.join(root, 'ok-page', 'manifest.json'), '{}');

    // Nested src/ directory with manifest.json — should be ignored (depth 2).
    writeReviewPage(config.root, 'docs/review/ok-page/src', 'review_src.html', 'src-page', 'SRC');
    fs.writeFileSync(path.join(root, 'ok-page', 'src', 'manifest.json'), '{}');

    // Nested before/ directory with manifest.json — should be ignored (depth 2).
    writeReviewPage(config.root, 'docs/review/ok-page/before', 'review_before.html', 'before-page', 'BEFORE');
    fs.writeFileSync(path.join(root, 'ok-page', 'before', 'manifest.json'), '{}');

    // Standalone depth-1 src/ directory with manifest.json — this IS at depth 1, so it should be listed.
    writeReviewPage(config.root, 'docs/review/src', 'review_src2.html', 'src2-page', 'SRC2');
    fs.writeFileSync(path.join(root, 'src', 'manifest.json'), '{}');

    const pages = reviewPages(config);
    const ids = pages.map((p) => p.page).sort();
    assert.deepEqual(ids, ['ok-page', 'src2-page'], 'depth-1 src/ is listed; nested src/ and before/ are not');
  });

  it('returns an empty array when reviewPages is not configured', () => {
    const { config } = makeProject();
    assert.deepEqual(reviewPages(config), []);
  });

  it('returns an empty array when the review directory does not exist', () => {
    const { config } = makeProject({ reviewPages: { dir: 'docs/nonexistent' } });
    assert.deepEqual(reviewPages(config), []);
  });

  it('marks html files without an embedded manifest as 手工页面', () => {
    const { config } = makeProject({ reviewPages: { dir: 'docs/review' } });
    const root = path.join(config.root, 'docs', 'review');
    const dir = path.join(root, 'manual');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(dir, 'review_manual.html'), '<html><body>no manifest</body></html>');

    const pages = reviewPages(config);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].page, null);
    assert.equal(pages[0].error, '手工页面，无批注统计');
  });

  it('skips _static files', () => {
    const { config } = makeProject({ reviewPages: { dir: 'docs/review' } });
    const root = path.join(config.root, 'docs', 'review');
    const dir = path.join(root, 'static-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
    writeReviewPage(config.root, 'docs/review/static-test', 'review_main.html', 'main-page', 'Main');
    fs.writeFileSync(path.join(dir, 'review_backup_static.html'), '<html></html>');

    const pages = reviewPages(config);
    assert.equal(pages.length, 1, 'only the non-_static file is listed');
    assert.equal(pages[0].page, 'main-page');
  });
});
