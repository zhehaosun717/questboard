// Regression coverage for the annotation write-origin fix (QB-FB-I): unrelated websites must not be able
// to POST annotations even though review pages may be opened same-origin, headerless (local CLI), or
// (refused) directly from file://.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startFixture } from './fixture.js';

// fetch()'s Host header is spec-forbidden and silently ignored, so a nonlocal-Host request needs a raw
// http.request instead of fx.api.
function postWithHost(port, host, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = http.request({ host: '127.0.0.1', port, path: '/api/annotations', method: 'POST', headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    request.on('error', reject);
    request.end(data);
  });
}

let fx;
before(async () => { fx = await startFixture(); });
after(() => fx.close());

const page = 'robot8';
const items = () => [{ id: 'a', verdict: '用新的', note: '好', updatedAt: new Date().toISOString() }];
const annotationFile = () => path.join(fx.project.config.paths.data, 'annotations', `${page}.jsonl`);
const savedLineCount = () => fs.existsSync(annotationFile()) ? fs.readFileSync(annotationFile(), 'utf8').trim().split('\n').filter(Boolean).length : 0;

describe('annotation write origin', () => {
  it('accepts a same-origin JSON POST', async () => {
    const before_ = savedLineCount();
    const result = await fx.api('/api/annotations', 'POST', { page, items: items() }, { origin: fx.base });
    assert.equal(result.status, 200);
    assert.equal(savedLineCount(), before_ + 1);
  });

  it('accepts a headerless local CLI JSON POST (no Origin, no Sec-Fetch-Site)', async () => {
    const before_ = savedLineCount();
    const result = await fx.api('/api/annotations', 'POST', { page, items: items() });
    assert.equal(result.status, 200);
    assert.equal(savedLineCount(), before_ + 1);
  });

  it('refuses a POST from an unrelated website', async () => {
    const before_ = savedLineCount();
    const result = await fx.api('/api/annotations', 'POST', { page, items: items() }, { origin: 'http://evil.example' });
    assert.equal(result.status, 403);
    assert.equal(savedLineCount(), before_);
  });

  it('refuses a POST with Origin: null (file://) and names the reason in Chinese', async () => {
    const before_ = savedLineCount();
    const result = await fx.api('/api/annotations', 'POST', { page, items: items() }, { origin: 'null' });
    assert.equal(result.status, 403);
    assert.match(result.body.error, /Questboard/);
    assert.match(result.body.error, /file:\/\//);
    assert.equal(savedLineCount(), before_);
  });

  it('refuses a cross-site fetch (Sec-Fetch-Site: cross-site) even with a local Origin', async () => {
    const before_ = savedLineCount();
    const result = await fx.api('/api/annotations', 'POST', { page, items: items() }, { origin: fx.base, 'sec-fetch-site': 'cross-site' });
    assert.equal(result.status, 403);
    assert.equal(savedLineCount(), before_);
  });

  it('refuses a POST to a non-local Host', async () => {
    const before_ = savedLineCount();
    const result = await postWithHost(fx.server.address().port, 'evil.example', { page, items: items() });
    assert.equal(result.status, 403);
    assert.equal(savedLineCount(), before_);
  });

  it('refuses a POST with the wrong content-type', async () => {
    const before_ = savedLineCount();
    const result = await fx.api('/api/annotations', 'POST', { page, items: items() }, { 'content-type': 'text/plain' });
    assert.equal(result.status, 403);
    assert.equal(savedLineCount(), before_);
  });

  it('rejects unsupported methods instead of falling through to a write', async () => {
    const before_ = savedLineCount();
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const result = await fx.api('/api/annotations', method, { page, items: items() });
      assert.equal(result.status, 405, `${method} should be rejected`);
    }
    assert.equal(savedLineCount(), before_);
  });

  it('does not advertise cross-origin write permission on preflight', async () => {
    const post = await fx.api('/api/annotations', 'OPTIONS', undefined, { 'access-control-request-method': 'POST' });
    assert.equal(post.status, 204);
    assert.equal(post.headers.get('access-control-allow-origin'), null);
    const get = await fx.api('/api/annotations', 'OPTIONS', undefined, { 'access-control-request-method': 'GET' });
    assert.equal(get.status, 204);
    assert.equal(get.headers.get('access-control-allow-origin'), '*');
  });

  it('keeps GET readable cross-origin', async () => {
    const result = await fx.api(`/api/annotations?page=${page}`, 'GET', undefined, { origin: 'http://evil.example' });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('access-control-allow-origin'), '*');
  });
});
