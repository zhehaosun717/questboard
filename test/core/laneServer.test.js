import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { resolveConfig } from '../../src/core/config.js';
import { laneServers, laneServerUp, serveCommand, startLaneServer } from '../../src/core/laneServer.js';
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
