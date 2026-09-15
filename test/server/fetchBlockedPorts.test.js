// Regression coverage for QB-FB-TEST-FETCH-PORTS: an MCP stdio run failed once because listen(0) handed
// the fixture a Fetch-blocked ephemeral port (recorded cause: 'bad port' at 6667) — the server was fine,
// fetch() itself refused it. A separate annotation-origin run failed with the same symptom, but its port
// was never logged, so a blocked port there is suspected, not confirmed. fixture.js now checks and
// retries; this file proves that retry, its bookkeeping and its exhaustion error deterministically,
// without depending on the OS ever actually allocating a blocked port.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { isFetchBlockedPort } from './fetchBlockedPorts.js';
import { listenOnSafePort } from './fixture.js';

// A scripted stand-in for net.Server: hands out the given ports in order via listen()/address(), and
// counts close() calls, without ever touching a real socket — for the deterministic B1 cases below.
class ScriptedServer extends EventEmitter {
  constructor(ports) {
    super();
    this.ports = ports;
    this.next = 0;
    this.closeCount = 0;
    this.listening = false;
  }
  listen(_port, _host, cb) {
    this.currentPort = this.ports[this.next];
    this.next += 1;
    this.listening = true;
    process.nextTick(cb);
  }
  address() {
    return { port: this.currentPort };
  }
  close(cb) {
    this.closeCount += 1;
    this.listening = false;
    process.nextTick(cb);
  }
}

const servers = [];
function freshServer() {
  const server = http.createServer((req, res) => res.end('ok'));
  servers.push(server);
  return server;
}
after(async () => { await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))); });

describe('fetchBlockedPorts', () => {
  it('knows the confirmed-bad port 6667 and a plainly safe port', () => {
    assert.equal(isFetchBlockedPort(6667), true);
    assert.equal(isFetchBlockedPort(45231), false);
  });

  it('pins spec entries, including 6679 which a hand-copy of the spec text first missed', () => {
    assert.equal(isFetchBlockedPort(6679), true);
    assert.equal(isFetchBlockedPort(10080), true);
    assert.equal(isFetchBlockedPort(6000), true);
  });
});

describe('listenOnSafePort', () => {
  it('tries scripted ports in order on a fake server, closing each blocked one, and lands on the first safe port', async () => {
    // No OS involved: a scripted server plus the real, default isFetchBlockedPort predicate proves the
    // retry/close bookkeeping deterministically, unlike relying on the OS to hand out a specific port.
    const server = new ScriptedServer([6667, 6667, 45231]);
    const { port, tried } = await listenOnSafePort(server);
    assert.deepEqual(tried, [6667, 6667, 45231]);
    assert.equal(port, 45231);
    assert.equal(server.closeCount, 2);
    assert.equal(server.listening, true);
  });

  it('gives up with an exhaustion error, closing every attempt, if every scripted port is blocked', async () => {
    const server = new ScriptedServer([6667, 6667, 6667]);
    await assert.rejects(
      () => listenOnSafePort(server, { maxAttempts: 3 }),
      (err) => {
        assert.match(err.message, /gave up after 3 attempts/);
        assert.deepEqual(err.tried, [6667, 6667, 6667]);
        return true;
      },
    );
    assert.equal(server.closeCount, 3);
    assert.equal(server.listening, false);
  });

  it('on a real listener, closes a forced-blocked first allocation and retries onto a genuinely safe one', async () => {
    const server = freshServer();
    let calls = 0;
    // Force only the first allocation to read as blocked; every later one goes through the real
    // predicate, so this proves the retry path lands on a port fetch() will actually accept — without
    // assuming the OS changes which port it hands back after a close().
    const isBlocked = (p) => calls++ === 0 || isFetchBlockedPort(p);
    const { port, tried } = await listenOnSafePort(server, { isBlocked });
    assert.ok(tried.length >= 2);
    assert.equal(tried[tried.length - 1], port);
    assert.ok(!isFetchBlockedPort(port));
    assert.equal(server.address().port, port);
    // Prove the final listener is genuinely reachable via fetch (the thing that broke), not just via
    // a raw socket check.
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  });

  it('accepts an already-safe first allocation without closing or retrying', async () => {
    const server = freshServer();
    const { port, tried } = await listenOnSafePort(server, { isBlocked: () => false });
    assert.deepEqual(tried, [port]);
  });
});
