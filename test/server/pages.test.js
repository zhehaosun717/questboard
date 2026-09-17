import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPageRoutes } from '../../src/server/pages.js';
import { routeParts } from '../../src/server/http.js';
import { makeProject, tmpDir } from '../helpers.js';

async function get(routes, pathname) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (!(await routes.handle(request, response, url, routeParts(url.pathname)))) { response.writeHead(599); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
  const text = await response.text();
  await new Promise((resolve) => server.close(resolve));
  return { status: response.status, text, csp: response.headers.get('content-security-policy') };
}

describe('page routes', () => {
  it('serves the built app at / when web/dist exists, with its hashed assets', async () => {
    const { config, write } = makeProject();
    const dist = tmpDir('web-dist-');
    const { root } = { root: dist };
    const fs = await import('node:fs');
    fs.mkdirSync(`${root}/assets`, { recursive: true });
    fs.writeFileSync(`${root}/index.html`, '<div id="root"></div><!-- built app -->');
    fs.writeFileSync(`${root}/assets/index-abc123.js`, 'console.log(1)');
    write('unused.txt', '');
    const routes = createPageRoutes({ config, webDist: root });
    const page = await get(routes, '/');
    assert.match(page.text, /built app/);
    assert.match(page.csp, /script-src 'self';/);
    assert.equal((await get(routes, '/assets/index-abc123.js')).status, 200);
    assert.equal((await get(routes, '/assets/..%2F..%2Findex.html')).status, 404);
    assert.match((await get(routes, '/classic')).text, /悬赏板/);
    assert.equal((await get(routes, '/assets/quests.app.js')).status, 200, 'classic assets still load');
  });

  it('refuses a file reached through a junction that points outside the served root', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { config } = makeProject();
    const dist = tmpDir('web-dist-');
    const outside = tmpDir('outside-');
    fs.writeFileSync(path.join(outside, 'secret.js'), 'secret');
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<div id="root"></div>');
    fs.symlinkSync(outside, path.join(dist, 'assets', 'link'), 'junction');
    const routes = createPageRoutes({ config, webDist: dist });
    assert.equal((await get(routes, '/assets/link/secret.js')).status, 404);
  });

  it('falls back to the classic board when there is no web build', async () => {
    const { config } = makeProject();
    const routes = createPageRoutes({ config, webDist: tmpDir('no-dist-') });
    assert.match((await get(routes, '/')).text, /assets\/quests\.app\.js/);
  });

  it('serves public/board.html with translated Chinese headings and no English placeholders', async () => {
    const { config } = makeProject();
    const routes = createPageRoutes({ config, webDist: tmpDir('no-dist-') });
    const page = await get(routes, '/board');
    assert.equal(page.status, 200);
    assert.match(page.text, /选一个主题/);
    assert.doesNotMatch(page.text, /Choose a thread/);
    assert.match(page.text, /主题列表/);
    assert.doesNotMatch(page.text, /<h2>Threads<\/h2>/);
  });
});
