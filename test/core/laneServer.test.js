import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { resolveConfig } from '../../src/core/config.js';
import { checkServerHealth, inFlightStarts, laneServers, laneServerUp, serveCommand, startLaneServer } from '../../src/core/laneServer.js';
import { tmpDir } from '../helpers.js';

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function projectWith(root, lanes) {
  return resolveConfig(root, { name: 'Lane Server Test', lanes });
}

function jsonResponse(status, body) {
  return { status, headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) }, text: async () => JSON.stringify(body) };
}

function htmlResponse(status = 200) {
  return { status, headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) }, text: async () => '<!doctype html><html><body>board</body></html>' };
}

function mockChild() {
  const child = new EventEmitter();
  child.pid = 1234;
  child.unref = () => {};
  return child;
}

describe('lane servers', () => {
  it('accepts a serve command only on a server lane, and without placeholders', () => {
    const root = tmpDir('qb-serve-config-');
    assert.deepEqual(projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6096', serve: ['opencode', 'serve'] } }).lanes.oc.serve, ['opencode', 'serve']);
    assert.throws(() => projectWith(root, { oc: { run: ['x'], outputDir: 'out', serve: ['opencode', 'serve'] } }), /needs api/);
    assert.throws(() => projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6096', serve: ['opencode', '{name}'] } }), /placeholders/);
    assert.throws(() => projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6096', serve: [] } }), /serve must be a non-empty array/);
  });

  it('runs npm command shims through cmd.exe on Windows and everything else directly', () => {
    assert.deepEqual(serveCommand(['opencode', 'serve'], { platform: 'win32', env: {} }), { file: 'cmd.exe', args: ['/d', '/c', 'opencode', 'serve'] });
    assert.deepEqual(serveCommand(['tool.cmd', 'x'], { platform: 'win32', env: { ComSpec: 'C:\\Windows\\cmd.exe' } }).file, 'C:\\Windows\\cmd.exe');
    assert.deepEqual(serveCommand(['C:/bin/server.exe', 'x'], { platform: 'win32', env: {} }), { file: 'C:/bin/server.exe', args: ['x'] });
    assert.deepEqual(serveCommand(['opencode', 'serve'], { platform: 'linux', env: {} }), { file: 'opencode', args: ['serve'] });
    assert.equal(serveCommand(['node', 'server.mjs']).file, process.execPath);
  });

  it('starts a lane server that is down, waits until it answers, and leaves it running', async () => {
    const root = tmpDir('qb-serve-real-');
    const port = await freePort();
    fs.writeFileSync(path.join(root, 'server.mjs'), `import http from 'node:http';\nhttp.createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1', () => console.log('listening'));\n`);
    const config = projectWith(root, { oc: { run: ['x'], api: `http://127.0.0.1:${port}`, serve: ['node', 'server.mjs'] } });
    assert.deepEqual(await laneServers(config), [{ id: 'oc', api: `http://127.0.0.1:${port}`, serve: ['node', 'server.mjs'], up: false }]);

    const started = await startLaneServer({ config, laneId: 'oc', pollMs: 100 });
    try {
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.equal(started.body.started, true);
      assert.equal(await laneServerUp(config.lanes.oc.api), true);
      const again = await startLaneServer({ config, laneId: 'oc' });
      assert.deepEqual(again.body, { up: true, started: false }, 'a running server is not started twice');
    } finally {
      if (started.body.pid) process.kill(started.body.pid);
    }
  });

  it('says why when the command ends without a server, and when there is nothing to start', async () => {
    const root = tmpDir('qb-serve-fail-');
    const port = await freePort();
    fs.writeFileSync(path.join(root, 'broken.mjs'), "console.error('Error: port is taken'); process.exit(3);\n");
    const config = projectWith(root, {
      oc: { run: ['x'], api: `http://127.0.0.1:${port}`, serve: ['node', 'broken.mjs'] },
      bare: { run: ['x'], api: `http://127.0.0.1:${port}` },
      files: { run: ['x'], outputDir: 'out' },
    });
    const failed = await startLaneServer({ config, laneId: 'oc', pollMs: 100, waitMs: 10000 });
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, /退出码 3/);
    assert.match(failed.body.error, /port is taken/);
    assert.match((await startLaneServer({ config, laneId: 'bare' })).body.error, /没有填启动命令/);
    assert.match((await startLaneServer({ config, laneId: 'files' })).body.error, /不需要启动/);
    assert.equal((await startLaneServer({ config, laneId: 'nowhere' })).status, 404);
  });
});

describe('server health classification', () => {
  it('without a health contract, any HTTP reply at all counts as reachable (legacy custom-lane behaviour)', async () => {
    for (const fetchImpl of [
      async () => jsonResponse(200, { ok: true }),
      async () => jsonResponse(404, {}),
      async () => htmlResponse(200),
      async () => jsonResponse(500, { error: 'boom' }),
    ]) {
      const result = await checkServerHealth('http://x', { fetchImpl });
      assert.deepEqual([result.up, result.conflicting], [true, false], JSON.stringify(result));
    }
    const refused = await checkServerHealth('http://x', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.deepEqual([refused.up, refused.conflicting], [false, false]);
    assert.equal(await laneServerUp('http://x', { fetchImpl: async () => { throw new Error('nope'); } }), false);
  });

  it('with a health contract, only a matching JSON reply at the declared path counts as up', async () => {
    const health = { path: '/global/health', json: { healthy: true } };

    const ok = await checkServerHealth('http://x', {
      health,
      fetchImpl: async (url) => {
        assert.equal(url, 'http://x/global/health');
        return jsonResponse(200, { healthy: true, version: '1.18.30' });
      },
    });
    assert.deepEqual([ok.up, ok.conflicting], [true, false]);

    const html = await checkServerHealth('http://x', { health, fetchImpl: async () => htmlResponse(200) });
    assert.deepEqual([html.up, html.conflicting, html.status], [false, true, 'wrong_service']);

    const notFound = await checkServerHealth('http://x', { health, fetchImpl: async () => jsonResponse(404, {}) });
    assert.deepEqual([notFound.up, notFound.conflicting, notFound.status], [false, true, 'wrong_service']);

    const unhealthy = await checkServerHealth('http://x', { health, fetchImpl: async () => jsonResponse(200, { healthy: false }) });
    assert.deepEqual([unhealthy.up, unhealthy.conflicting, unhealthy.status], [false, true, 'unhealthy']);

    const refused = await checkServerHealth('http://x', { health, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.deepEqual([refused.up, refused.conflicting, refused.status], [false, false, 'down']);
  });

  it('with a health contract, a 401 (password-protected) or 5xx (transient) reply is "unhealthy", not blamed on another service', async () => {
    const health = { path: '/global/health', json: { healthy: true } };
    for (const status of [401, 500, 503]) {
      const result = await checkServerHealth('http://x', { health, fetchImpl: async () => jsonResponse(status, { error: 'nope' }) });
      assert.deepEqual([result.up, result.conflicting, result.status], [false, true, 'unhealthy'], `status ${status}`);
      assert.doesNotMatch(result.detail, /不是期望的|另一个|其它服务/);
    }
  });

  it('does not follow a redirect from the health endpoint; a 3xx reply counts as wrong_service', async () => {
    const health = { path: '/global/health', json: { healthy: true } };
    let seenRedirect;
    const result = await checkServerHealth('http://x', {
      health,
      fetchImpl: async (url, opts) => { seenRedirect = opts.redirect; return { status: 302, headers: { get: () => null }, text: async () => '' }; },
    });
    assert.equal(seenRedirect, 'manual', 'the probe must not silently follow a redirect onto another host');
    assert.deepEqual([result.up, result.conflicting, result.status], [false, true, 'wrong_service']);
  });
});

describe('health contract config validation — ambiguous api/health rejected', () => {
  it('rejects api with a trailing slash, a query string, or a fragment when health is set', () => {
    const root = tmpDir('qb-serve-health-api-shape-');
    const health = { path: '/global/health' };
    assert.throws(() => projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6096/', serve: ['x'], health } }), /trailing \//);
    assert.throws(() => projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6096?x=1', serve: ['x'], health } }), /query or fragment/);
    assert.throws(() => projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6096#frag', serve: ['x'], health } }), /query or fragment/);
    // A plain api (no trailing /, ?, or #) is unaffected.
    assert.doesNotThrow(() => projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6096', serve: ['x'], health } }));
  });

  it('joins api and health.path without a doubled slash once api has no trailing slash', async () => {
    const health = { path: '/global/health', json: { healthy: true } };
    const result = await checkServerHealth('http://127.0.0.1:6096', {
      health,
      fetchImpl: async (url) => {
        assert.equal(url, 'http://127.0.0.1:6096/global/health', 'no doubled slash and no query/fragment mixed in');
        return jsonResponse(200, { healthy: true });
      },
    });
    assert.equal(result.up, true);
  });

  it('rejects a health.path starting with // or containing a backslash', () => {
    const root = tmpDir('qb-serve-health-path-shape-');
    assert.throws(() => projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6096', serve: ['x'], health: { path: '//evil.example/x' } } }), /health\.path must be a plain path/);
    assert.throws(() => projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6096', serve: ['x'], health: { path: '/\\evil.example' } } }), /health\.path must be a plain path/);
  });

  it('rejects a health.json expected value that is not a string, number, boolean, or null', () => {
    const root = tmpDir('qb-serve-health-json-shape-');
    assert.throws(
      () => projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6096', serve: ['x'], health: { path: '/h', json: { healthy: { nested: true } } } } }),
      /health\.json\.healthy must be a string, number, boolean, or null/,
    );
    assert.doesNotThrow(() => projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6096', serve: ['x'], health: { path: '/h', json: { healthy: true, version: '1.0', code: 200, extra: null } } } }));
  });
});

describe('OpenCode-shaped server (HTML root, JSON /global/health)', () => {
  function openCodeFetchImpl({ healthy = true, healthStatus = 200 } = {}) {
    return async (url) => (String(url).endsWith('/global/health') ? jsonResponse(healthStatus, { healthy, version: '1.18.30' }) : htmlResponse(200));
  }

  it('is up when the lane declares the health contract and the endpoint is healthy', async () => {
    const root = tmpDir('qb-serve-oc-health-up-');
    const config = projectWith(root, {
      oc: { run: ['x'], api: 'http://127.0.0.1:6099', serve: ['opencode', 'serve'], health: { path: '/global/health', json: { healthy: true } } },
    });
    const fetchImpl = openCodeFetchImpl({ healthy: true });
    assert.deepEqual(await laneServers(config, { fetchImpl }), [{ id: 'oc', api: 'http://127.0.0.1:6099', serve: ['opencode', 'serve'], up: true }]);
    const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl: () => { throw new Error('must not spawn over a healthy server'); } });
    assert.deepEqual(result.body, { up: true, started: false });
  });

  it('without a declared health contract, an HTML root is never refused as a conflict (compatibility with custom lanes)', async () => {
    const root = tmpDir('qb-serve-oc-nohealth-');
    const config = projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:6099', serve: ['opencode', 'serve'] } });
    const fetchImpl = openCodeFetchImpl({ healthy: true });
    assert.deepEqual(await laneServers(config, { fetchImpl }), [{ id: 'oc', api: 'http://127.0.0.1:6099', serve: ['opencode', 'serve'], up: true }]);
    const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl: () => { throw new Error('must not spawn over a reachable server'); } });
    assert.notEqual(result.status, 409);
    assert.deepEqual(result.body, { up: true, started: false });
  });

  it('with a health contract, a 404/HTML/unhealthy endpoint refuses to spawn over it (409, no spawn)', async () => {
    const root = tmpDir('qb-serve-oc-conflict-');
    const config = projectWith(root, {
      oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'], health: { path: '/global/health', json: { healthy: true } } },
    });
    let spawned = false;
    const spawnImpl = () => { spawned = true; return mockChild(); };
    for (const fetchImpl of [
      async () => jsonResponse(404, {}),
      async () => htmlResponse(200),
      async () => jsonResponse(200, { healthy: false }),
    ]) {
      const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl });
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.match(result.body.error, /(HTML|HTTP 404|不健康)/);
    }
    assert.equal(spawned, false, 'a conflicting or unhealthy reply is never overwritten by a new spawn');
    assert.equal(inFlightStarts.size, 0);
  });

  it('after a spawn, a conflicting reply does not falsely claim no command was started, and keeps the log output', async () => {
    const root = tmpDir('qb-serve-oc-postspawn-conflict-');
    const config = projectWith(root, {
      oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'], health: { path: '/global/health', json: { healthy: true } } },
    });
    // Down before the spawn (so performStart actually spawns instead of returning the pre-spawn 409), then
    // HTML forever after — the health check never passes, and the mock child never exits, so the wait runs to waitMs.
    let started = false;
    const fetchImpl = async () => {
      if (!started) throw new Error('down');
      return htmlResponse(200);
    };
    const spawnImpl = (file, args, options) => {
      started = true;
      fs.writeSync(options.stdio[1], 'server starting on the wrong port\n');
      return mockChild();
    };

    const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl, waitMs: 100, pollMs: 20 });
    assert.equal(result.status, 502, JSON.stringify(result.body));
    assert.doesNotMatch(result.body.error, /没有启动/, 'a spawn did happen, so the refusal must not claim otherwise');
    assert.match(result.body.error, /server starting on the wrong port/, 'the log output the owner needs stays in the message');
    assert.match(result.body.error, /HTML/, 'the last health check detail is appended');
  });

  it('post-spawn, an unhealthy reply does not end the bounded wait early — it polls until healthy or timeout', async () => {
    const root = tmpDir('qb-serve-oc-warmup-');
    const config = projectWith(root, {
      oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'], health: { path: '/global/health', json: { healthy: true } } },
    });
    let started = false;
    let pollCount = 0;
    const fetchImpl = async () => {
      if (!started) throw new Error('down'); // nothing listens before the spawn
      pollCount += 1;
      return pollCount < 3 ? jsonResponse(200, { healthy: false }) : jsonResponse(200, { healthy: true });
    };
    const spawnImpl = () => { started = true; return mockChild(); };

    const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl, waitMs: 2000, pollMs: 10 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.started, true);
    assert.ok(pollCount >= 3, 'kept polling past the first unhealthy reply instead of stopping immediately');
  });
});

describe('lane server start — mocked regressions (no live service or network)', () => {
  it('shares one spawn across concurrent clicks, and a failed attempt frees a later explicit retry', async () => {
    const root = tmpDir('qb-serve-parallel-');
    const config = projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'] } });
    let spawnCount = 0;
    const spawnImpl = () => {
      spawnCount += 1;
      const child = mockChild();
      setTimeout(() => child.emit('exit', 1), 10);
      return child;
    };
    const fetchImpl = async () => { throw new Error('down'); };

    const [a, b] = await Promise.all([
      startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl, waitMs: 500, pollMs: 20 }),
      startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl, waitMs: 500, pollMs: 20 }),
    ]);
    assert.equal(spawnCount, 1, 'two concurrent clicks caused only one spawn');
    assert.deepEqual(a, b, 'both callers get the same settled attempt');
    assert.equal(a.status, 502);
    assert.equal(inFlightStarts.size, 0, 'the in-flight entry is cleared once the attempt settles');

    const retry = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl, waitMs: 500, pollMs: 20 });
    assert.equal(spawnCount, 2, 'an explicit request after failure starts a new attempt');
    assert.equal(retry.status, 502);
  });

  it('reports a clear spawn error without touching the in-flight map', async () => {
    const root = tmpDir('qb-serve-spawnerr-');
    const config = projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'] } });
    const fetchImpl = async () => { throw new Error('down'); };
    const spawnImpl = () => { throw new Error('ENOENT: no such file'); };

    const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl });
    assert.equal(result.status, 500);
    assert.match(result.body.error, /启动命令没能运行/);
    assert.match(result.body.error, /ENOENT/);
    assert.equal(inFlightStarts.size, 0);
  });

  it('times out with an actionable reason when the command neither answers nor exits', async () => {
    const root = tmpDir('qb-serve-timeout-');
    const config = projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'] } });
    const fetchImpl = async () => { throw new Error('down'); };
    const spawnImpl = () => mockChild(); // never exits, never errors

    const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl, waitMs: 120, pollMs: 30 });
    assert.equal(result.status, 502);
    assert.match(result.body.error, /等了.*秒.*还是连不上/);
    assert.doesNotMatch(result.body.error, /端口被占用/);
  });

  it('names address-in-use when the command exits complaining the port is taken', async () => {
    const root = tmpDir('qb-serve-addrinuse-');
    const config = projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'] } });
    const fetchImpl = async () => { throw new Error('down'); };
    const spawnImpl = (file, args, options) => {
      fs.writeSync(options.stdio[1], 'Error: address already in use\n');
      const child = mockChild();
      setTimeout(() => child.emit('exit', 1), 10);
      return child;
    };

    const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl, waitMs: 500, pollMs: 20 });
    assert.equal(result.status, 502);
    assert.match(result.body.error, /端口被占用/);
    assert.match(result.body.error, /换一个端口/);
  });

  it('redacts a known token-shaped secret from the log tail (best-effort, not exhaustive)', async () => {
    const root = tmpDir('qb-serve-secret-');
    const config = projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'] } });
    const fetchImpl = async () => { throw new Error('down'); };
    const secret = 'sk-liveTestSecretValue1234567890';
    const spawnImpl = (file, args, options) => {
      fs.writeSync(options.stdio[1], `token=${secret}\nauth failed\n`);
      const child = mockChild();
      setTimeout(() => child.emit('exit', 1), 10);
      return child;
    };

    const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl, waitMs: 500, pollMs: 20 });
    assert.equal(result.status, 502);
    assert.ok(!result.body.error.includes(secret));
    assert.match(result.body.error, /已隐藏/);
  });

  it('redacts password=, "Authorization: Basic …", and header-style "x-api-key <value>" from the log tail', async () => {
    const root = tmpDir('qb-serve-secret-residual-');
    const config = projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'] } });
    const fetchImpl = async () => { throw new Error('down'); };
    const passwordSecret = 'p@ssw0rd!2024xyz';
    const basicSecret = 'dXNlcjpwYXNzd29yZA==';
    const headerKeySecret = 'Zz9Klm3Qa7VtRb2Ns8Wc';
    const spawnImpl = (file, args, options) => {
      fs.writeSync(options.stdio[1], `password=${passwordSecret}\nAuthorization: Basic ${basicSecret}\nx-api-key ${headerKeySecret}\n`);
      const child = mockChild();
      setTimeout(() => child.emit('exit', 1), 10);
      return child;
    };

    const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl, waitMs: 500, pollMs: 20 });
    assert.equal(result.status, 502);
    assert.ok(!result.body.error.includes(passwordSecret), 'password= value');
    assert.ok(!result.body.error.includes(basicSecret), 'Basic auth value');
    assert.ok(!result.body.error.includes(headerKeySecret), 'x-api-key header value');
  });

  it('redacts userinfo credentials embedded in a lane\'s own api from the conflict/failure message', async () => {
    const root = tmpDir('qb-serve-userinfo-');
    const config = projectWith(root, { oc: { run: ['x'], api: 'http://user:t0pSecretPass@127.0.0.1:1', serve: ['node', 'never.mjs'] } });
    const fetchImpl = async () => { throw new Error('down'); };
    const spawnImpl = () => mockChild(); // never exits

    const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl, waitMs: 100, pollMs: 20 });
    assert.equal(result.status, 502);
    assert.ok(!result.body.error.includes('t0pSecretPass'));
  });

  it('redacts a quoted JSON key in the log tail and a key inside a spawn error message', async () => {
    const root = tmpDir('qb-serve-secret-json-');
    const config = projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'] } });
    const fetchImpl = async () => { throw new Error('down'); };
    const logSecret = 'AbCdEf1234567890+/==';
    const spawnLog = (file, args, options) => {
      fs.writeSync(options.stdio[1], `{"apiKey": "${logSecret}"}\n`);
      const child = mockChild();
      setTimeout(() => child.emit('exit', 1), 10);
      return child;
    };
    const logResult = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl: spawnLog, waitMs: 500, pollMs: 20 });
    assert.equal(logResult.status, 502);
    assert.ok(!logResult.body.error.includes(logSecret));
    assert.match(logResult.body.error, /已隐藏/);

    const spawnErrorSecret = 'sk-liveSpawnErrorSecretValue123456';
    const spawnThrow = () => { throw new Error(`auth failed with token=${spawnErrorSecret}`); };
    const throwResult = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl: spawnThrow });
    assert.equal(throwResult.status, 500);
    assert.ok(!throwResult.body.error.includes(spawnErrorSecret));
    assert.match(throwResult.body.error, /已隐藏/);
  });

  it('reports an honest reason (not an unhandled rejection) when the data directory cannot be prepared', async () => {
    const root = tmpDir('qb-serve-baddata-');
    fs.writeFileSync(path.join(root, '.questboard-data'), 'occupied by a plain file, not a directory');
    const config = projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'] } });
    const fetchImpl = async () => { throw new Error('down'); };
    const spawnImpl = () => mockChild();

    const rejections = [];
    const onUnhandled = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl });
      assert.equal(result.status, 500, JSON.stringify(result.body));
      assert.match(result.body.error, /日志文件/);
      assert.equal(inFlightStarts.size, 0);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(rejections, [], 'no unhandled rejection escaped a failed fs operation');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('does not throw when the detached child emits an error after the attempt has settled', async () => {
    const root = tmpDir('qb-serve-lateerror-');
    const config = projectWith(root, { oc: { run: ['x'], api: 'http://127.0.0.1:1', serve: ['node', 'never.mjs'] } });
    const fetchImpl = async () => { throw new Error('down'); };
    let child;
    const spawnImpl = () => { child = mockChild(); return child; };

    const result = await startLaneServer({ config, laneId: 'oc', fetchImpl, spawnImpl, waitMs: 100, pollMs: 20 });
    assert.equal(result.status, 502);
    assert.doesNotThrow(() => child.emit('error', new Error('late failure after settle')));
  });
});
