// The dev proxy's front-door decision (evaluateProxyRequest) is exported so its logic can be unit-tested
// without a real Vite dev server — but a copy of the same logic tested in isolation proves nothing about
// whether it is actually wired into the real proxy path. The second describe block below drives an actual
// `vite` dev server (the real `createServer` from the `vite` package, loading this repo's own
// vite.config.ts) in front of a real board (`startFixture`'s real `createServer` from src/server/server.js,
// with a stub `usage` so no real provider is ever called), bound on its own ephemeral port — never 5173 —
// and sends real HTTP requests through it. That is what proves the guard reads its own actual bound address
// (not a hardcoded port) and runs before the upstream connection opens, not just that a hand-copied stand-in
// of the logic would.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createViteServer } from 'vite';
import type { ViteDevServer } from 'vite';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { evaluateProxyRequest, boundDevOrigins } from './vite.config';
import { startFixture } from '../test/server/fixture.js';

const BOARD = 'http://127.0.0.1:6097';
// A fixed, representative pair of live-bound origins for the pure-function tests below — standing in for
// whatever `boundDevOrigins()` would actually compute from a real `httpServer.address()`.
const BOUND = ['http://127.0.0.1:6891', 'http://localhost:6891'];
const DEV_LOCALHOST = BOUND[1];
const DEV_LOOPBACK = BOUND[0];
const FOREIGN_SITE = 'https://evil.example';
const FOREIGN_LOCAL_PORT = 'http://127.0.0.1:9999';
// The historically hardcoded port. Once the guard reads its live-bound origin instead, this must be refused
// exactly like any other foreign local port whenever the dev server is actually bound elsewhere.
const FORGED_5173 = 'http://localhost:5173';

// A synthetic listener on the loopback family Vite did NOT bind, occupying the very same port number — this
// is the scenario review's probe-bind.mjs demonstrated: an unrelated process can squat that alias address,
// and only the guard's exact-origin match (never the port number alone, never "nothing else could be
// there") stands between it and looking like Vite's own front door. Binding it is best-effort: a platform
// or sandbox that refuses a same-port dual-stack bind leaves nothing on the alias for a real client to
// reach, but the guard assertions below depend only on the Origin header sent to Vite's own real socket, so
// they hold either way.
function listenOnAlias(port: number, aliasHost: string): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'x-probe': 'foreign' });
      res.end('FOREIGN PAGE');
    });
    srv.once('error', () => resolve(null));
    srv.listen(port, aliasHost, () => resolve(srv));
  });
}

describe('evaluateProxyRequest: the dev proxy front door (pure)', () => {
  it('own legitimate dev page (localhost, live-bound port): allowed, Origin and Referer rewritten to the board', () => {
    const decision = evaluateProxyRequest({ origin: DEV_LOCALHOST, referer: `${DEV_LOCALHOST}/usage?refresh=1` }, BOUND, BOARD);
    expect(decision.allow).toBe(true);
    expect(decision.overrides.origin).toBe(BOARD);
    expect(decision.overrides.referer).toBe(`${BOARD}/usage?refresh=1`);
  });

  it('own legitimate dev page (127.0.0.1, live-bound port): allowed, same rewrite', () => {
    const decision = evaluateProxyRequest({ origin: DEV_LOOPBACK, referer: `${DEV_LOOPBACK}/x` }, BOUND, BOARD);
    expect(decision.allow).toBe(true);
    expect(decision.overrides.origin).toBe(BOARD);
    expect(decision.overrides.referer).toBe(`${BOARD}/x`);
  });

  it('no headers at all (CLI-compatible): allowed, nothing to rewrite', () => {
    const decision = evaluateProxyRequest({}, BOUND, BOARD);
    expect(decision.allow).toBe(true);
    expect(decision.overrides).toEqual({});
  });

  it('only a legitimate Referer, no Origin: allowed, only Referer rewritten', () => {
    const decision = evaluateProxyRequest({ referer: `${DEV_LOOPBACK}/y` }, BOUND, BOARD);
    expect(decision.allow).toBe(true);
    expect(decision.overrides.origin).toBeUndefined();
    expect(decision.overrides.referer).toBe(`${BOARD}/y`);
  });

  it('foreign website Origin: refused', () => {
    expect(evaluateProxyRequest({ origin: FOREIGN_SITE }, BOUND, BOARD).allow).toBe(false);
  });

  it('foreign website Referer: refused, never rewritten into the board origin', () => {
    expect(evaluateProxyRequest({ referer: `${FOREIGN_SITE}/steal?t=1` }, BOUND, BOARD).allow).toBe(false);
  });

  it('foreign local port Origin (not the live-bound port): refused', () => {
    expect(evaluateProxyRequest({ origin: FOREIGN_LOCAL_PORT }, BOUND, BOARD).allow).toBe(false);
  });

  it('foreign local port Referer (not the live-bound port): refused', () => {
    expect(evaluateProxyRequest({ referer: `${FOREIGN_LOCAL_PORT}/x` }, BOUND, BOARD).allow).toBe(false);
  });

  it('the historically hardcoded port 5173, forged while bound elsewhere: refused', () => {
    expect(evaluateProxyRequest({ origin: FORGED_5173 }, BOUND, BOARD).allow).toBe(false);
    expect(evaluateProxyRequest({ referer: `${FORGED_5173}/usage` }, BOUND, BOARD).allow).toBe(false);
  });

  it('contradictory headers: legitimate Origin but foreign Referer: refused', () => {
    expect(evaluateProxyRequest({ origin: DEV_LOCALHOST, referer: `${FOREIGN_SITE}/x` }, BOUND, BOARD).allow).toBe(false);
  });

  it('contradictory headers: foreign Origin but legitimate Referer: refused', () => {
    expect(evaluateProxyRequest({ origin: FOREIGN_SITE, referer: `${DEV_LOCALHOST}/x` }, BOUND, BOARD).allow).toBe(false);
  });

  it('malformed Origin (not a parseable URL): refused, not forwarded as-is', () => {
    expect(evaluateProxyRequest({ origin: 'not a url at all' }, BOUND, BOARD).allow).toBe(false);
  });

  it('malformed Referer (not a parseable URL): refused', () => {
    expect(evaluateProxyRequest({ referer: 'not a url at all' }, BOUND, BOARD).allow).toBe(false);
  });

  it('userinfo in Origin (spoofed, never sent by a real browser): refused', () => {
    expect(evaluateProxyRequest({ origin: 'http://x@127.0.0.1:6891' }, BOUND, BOARD).allow).toBe(false);
  });

  it('userinfo in Referer: refused', () => {
    expect(evaluateProxyRequest({ referer: 'http://x@127.0.0.1:6891/y' }, BOUND, BOARD).allow).toBe(false);
  });

  for (const [label, origin] of [
    ['https instead of http', 'https://127.0.0.1:6891'],
    ['ws scheme', 'ws://127.0.0.1:6891'],
    ['ftp scheme', 'ftp://127.0.0.1:6891'],
    ['unknown scheme', 'foo://127.0.0.1:6891'],
    ['protocol-relative (no scheme)', '//127.0.0.1:6891'],
  ]) {
    it(`non-http scheme Origin (${label}): refused even though host:port match`, () => {
      expect(evaluateProxyRequest({ origin }, BOUND, BOARD).allow).toBe(false);
    });
  }

  for (const [label, origin] of [
    ['trailing path', 'http://127.0.0.1:6891/evil'],
    ['trailing slash', 'http://127.0.0.1:6891/'],
    ['query string', 'http://127.0.0.1:6891?x=1'],
    ['uppercase host', 'http://LOCALHOST:6891'],
    ['leading-zero port', 'http://localhost:06891'],
    ['alternate short IPv4 (127.1)', 'http://127.1:6891'],
    ['hex-octet IPv4 (0x7f.0.0.1)', 'http://0x7f.0.0.1:6891'],
    ['trailing dot host', 'http://localhost.:6891'],
  ]) {
    it(`non-serialized-origin form (${label}): refused even though it would parse to the same host/port`, () => {
      expect(evaluateProxyRequest({ origin }, BOUND, BOARD).allow).toBe(false);
    });
  }

  it('Origin: null: refused', () => {
    expect(evaluateProxyRequest({ origin: 'null' }, BOUND, BOARD).allow).toBe(false);
  });

  it('Sec-Fetch-Site: cross-site is refused even with a legitimate Origin', () => {
    expect(evaluateProxyRequest({ origin: DEV_LOCALHOST, 'sec-fetch-site': 'cross-site' }, BOUND, BOARD).allow).toBe(false);
  });

  it('Sec-Fetch-Site: same-site (not same-origin) is refused', () => {
    expect(evaluateProxyRequest({ origin: DEV_LOCALHOST, 'sec-fetch-site': 'same-site' }, BOUND, BOARD).allow).toBe(false);
  });

  it('Sec-Fetch-Site: same-origin with a legitimate Origin is allowed', () => {
    expect(evaluateProxyRequest({ origin: DEV_LOCALHOST, 'sec-fetch-site': 'same-origin' }, BOUND, BOARD).allow).toBe(true);
  });

  it('Sec-Fetch-Site: none (typed-URL/CLI-style navigation) with a legitimate Origin is allowed', () => {
    expect(evaluateProxyRequest({ origin: DEV_LOCALHOST, 'sec-fetch-site': 'none' }, BOUND, BOARD).allow).toBe(true);
  });

  it('no live-bound origins yet (server not listening): every Origin is refused, nothing is ever "the" front door', () => {
    expect(evaluateProxyRequest({ origin: DEV_LOCALHOST }, [], BOARD).allow).toBe(false);
    // Still CLI-compatible with no headers at all: an absent header carries nothing to launder.
    expect(evaluateProxyRequest({}, [], BOARD).allow).toBe(true);
  });
});

// A real `vite` dev server, loading this repo's own vite.config.ts, bound on its own ephemeral port (never
// 5173) and proxying to a real board. `usage` is a stub (no real provider is ever called) so a leak through
// the guard is caught as an actual extra call, not inferred from headers alone. The board's own `connection`/
// `request` events are also counted directly, so a refusal is proven to have opened zero upstream connections
// and sent zero bytes to the board — not just that the board's usage service was never invoked.
describe('the front door wired into a real Vite dev server, in front of a real board', () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  let vite: ViteDevServer;
  let devBase: string;
  let devHost: string;
  let devPort: number;
  let alias: http.Server | null;
  let usageCalls: Array<{ refresh: boolean; provider: string | null }>;
  let board: { connections: number; requests: number };
  const priorBoardUrl = process.env.QUESTBOARD_URL;

  beforeAll(async () => {
    usageCalls = [];
    fixture = await startFixture({
      usage: {
        listProviderIds: () => ['fake'],
        report: async (opts: { refresh: boolean; provider: string | null }) => {
          usageCalls.push(opts);
          return { generatedAt: new Date().toISOString(), providers: [] };
        },
      },
    });
    board = { connections: 0, requests: 0 };
    fixture.server.on('connection', () => { board.connections += 1; });
    fixture.server.prependListener('request', () => { board.requests += 1; });
    process.env.QUESTBOARD_URL = fixture.base;
    vite = await createViteServer({
      configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
      root: fileURLToPath(new URL('.', import.meta.url)),
      server: { port: 0, strictPort: false, host: '127.0.0.1' },
      logLevel: 'silent',
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('vite dev server did not bind a port');
    devPort = address.port;
    devBase = `http://127.0.0.1:${devPort}`;
    devHost = `127.0.0.1:${devPort}`;
    // The explicit-127.0.0.1 bind leaves the IPv6 loopback family free for anything else — including a
    // page that isn't Vite's — at the very same port number.
    alias = await listenOnAlias(devPort, '::1');
  }, 60000);

  afterAll(async () => {
    await vite?.close();
    await new Promise<void>((resolve) => (alias ? alias.close(() => resolve()) : resolve()));
    await fixture?.close();
    if (priorBoardUrl === undefined) delete process.env.QUESTBOARD_URL;
    else process.env.QUESTBOARD_URL = priorBoardUrl;
  });

  function rawRequest(headers: http.OutgoingHttpHeaders, extra: { method?: string; body?: string; path?: string } = {}): Promise<{ status?: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: Number(devHost.split(':')[1]), method: extra.method || 'GET', path: extra.path || '/api/usage?refresh=1', headers: { host: devHost, ...headers } },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject);
      if (extra.body) req.write(extra.body);
      req.end();
    });
  }

  it('forwards a side-effect GET (usage refresh) from the own dev page, rewriting Origin/Referer to the board', async () => {
    const before = usageCalls.length;
    const response = await fetch(`${devBase}/api/usage?refresh=1`, {
      headers: { origin: devBase, referer: `${devBase}/usage` },
    });
    expect(response.status).toBe(200);
    expect(usageCalls.length).toBe(before + 1);
    expect(usageCalls[usageCalls.length - 1]).toEqual({ refresh: true, provider: null });
  });

  it('refuses the historically hardcoded localhost:5173 origin now that the server is bound elsewhere: zero board connections/bytes', async () => {
    const beforeConn = board.connections;
    const beforeReq = board.requests;
    const beforeCalls = usageCalls.length;
    const response = await fetch(`${devBase}/api/usage?refresh=1`, { headers: { origin: FORGED_5173, referer: `${FORGED_5173}/usage` } });
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'origin refused' });
    expect(usageCalls.length).toBe(beforeCalls);
    expect(board.connections).toBe(beforeConn);
    expect(board.requests).toBe(beforeReq);
  });

  it('refuses the localhost alias origin now bound explicitly to 127.0.0.1: the guard matches the live-bound family, not just the port; zero board connections', async () => {
    const aliasOrigin = `http://localhost:${devPort}`;
    const beforeConn = board.connections;
    const beforeReq = board.requests;
    const beforeCalls = usageCalls.length;
    const response = await fetch(`${devBase}/api/usage?refresh=1`, {
      headers: { origin: aliasOrigin, referer: `${aliasOrigin}/usage` },
    });
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'origin refused' });
    expect(usageCalls.length).toBe(beforeCalls);
    expect(board.connections).toBe(beforeConn);
    expect(board.requests).toBe(beforeReq);
  });

  it('the localhost alias really is a different server on this platform (threat context, not the guard itself)', async () => {
    if (!alias) return; // platform refused the dual-stack same-port bind; nothing to demonstrate here
    // Deliberately not `http://localhost:${devPort}/`: Node's fetch() races the IPv4 and IPv6 connections for
    // a hostname that resolves to both families (RFC 8305 "Happy Eyeballs" — `net.getDefaultAutoSelectFamily()`
    // is true by default since Node 20), and with a real listener on both `127.0.0.1` (Vite) and `::1` (this
    // alias) at the very same port number, that race nondeterministically lands the request on either one —
    // this was observed to flip the guarded-server test below between pass and fail across runs. Targeting the
    // alias's own literal bound address removes the race and asserts only what this test claims: that a
    // distinct server actually answers on the family Vite did not bind.
    const res = await fetch(`http://[::1]:${devPort}/`);
    expect(res.headers.get('x-probe')).toBe('foreign');
  });

  it('refuses a foreign website\'s side-effect GET at the proxy: zero board connections/bytes', async () => {
    const beforeConn = board.connections;
    const beforeReq = board.requests;
    const beforeCalls = usageCalls.length;
    const response = await fetch(`${devBase}/api/usage?refresh=1`, {
      headers: { origin: FOREIGN_SITE, referer: `${FOREIGN_SITE}/steal` },
    });
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'origin refused' });
    expect(usageCalls.length).toBe(beforeCalls);
    expect(board.connections).toBe(beforeConn);
    expect(board.requests).toBe(beforeReq);
  });

  it('refuses a foreign local port at the proxy: zero board connections/bytes', async () => {
    const beforeConn = board.connections;
    const beforeReq = board.requests;
    const response = await fetch(`${devBase}/api/usage?refresh=1`, { headers: { origin: FOREIGN_LOCAL_PORT } });
    expect(response.status).toBe(403);
    expect(board.connections).toBe(beforeConn);
    expect(board.requests).toBe(beforeReq);
  });

  it('refuses a non-canonical origin form (trailing path) even though host:port match: zero board connections', async () => {
    const beforeConn = board.connections;
    const response = await fetch(`${devBase}/api/usage?refresh=1`, { headers: { origin: `${devBase}/evil` } });
    expect(response.status).toBe(403);
    expect(board.connections).toBe(beforeConn);
  });

  it('refuses contradictory headers at the proxy: zero board connections', async () => {
    const beforeConn = board.connections;
    const response = await fetch(`${devBase}/api/usage?refresh=1`, {
      headers: { origin: devBase, referer: `${FOREIGN_SITE}/x` },
    });
    expect(response.status).toBe(403);
    expect(board.connections).toBe(beforeConn);
  });

  it('Expect: 100-continue with a foreign Origin is still refused at the front door, not just by the backend: zero board connections', async () => {
    const beforeConn = board.connections;
    const beforeReq = board.requests;
    const response = await rawRequest({ origin: FOREIGN_SITE, expect: '100-continue' });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'origin refused' });
    expect(board.connections).toBe(beforeConn);
    expect(board.requests).toBe(beforeReq);
  });

  it('forwards a write (POST /api/quests) from the own dev page through to the real board', async () => {
    const response = await fetch(`${devBase}/api/quests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: devBase, referer: `${devBase}/quests` },
      body: JSON.stringify({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-the-way-back.md', allowedLanes: 'codex' }),
    });
    expect(response.status).toBe(201);
    const listed = await fetch(`${devBase}/api/quests`, {
      headers: { origin: devBase, referer: `${devBase}/quests` },
    }).then((r) => r.json());
    expect(listed.quests.some((q: { id: string }) => q.id === 'RUN-4')).toBe(true);
  });

  it('refuses a foreign website\'s write at the proxy: the quest is never posted to the real board', async () => {
    const beforeConn = board.connections;
    const response = await fetch(`${devBase}/api/quests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: FOREIGN_SITE },
      body: JSON.stringify({ package: 'CSRF-1', brief: 'docs/briefs/RUN-4-the-way-back.md', allowedLanes: 'codex' }),
    });
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'origin refused' });
    expect(board.connections).toBe(beforeConn);
    const listed = await fetch(`${devBase}/api/quests`, {
      headers: { origin: devBase, referer: `${devBase}/quests` },
    }).then((r) => r.json());
    expect(listed.quests.some((q: { id: string }) => q.id === 'CSRF-1')).toBe(false);
  });
});

// `npm run dev` binds no explicit `host` — this is that default, whatever loopback family Node's own lookup
// order actually resolves it to on this machine (`::1` first, observed independently in review). This is the
// scenario the old code got wrong: it allowed `127.0.0.1` as a front-door origin even though Vite itself was
// never reachable on that family, so a same-port listener on the family Vite did NOT bind could pass as the
// dev server's own page.
describe('the front door with Vite\'s default host (no host set — the plain "npm run dev" case)', () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  let vite: ViteDevServer;
  let alias: http.Server | null;
  let ownOrigin: string;
  let aliasOrigin: string;
  // The literal, unambiguous address to actually open every real connection against in this block —
  // `127.0.0.1` or `[::1]`, whichever family Vite really bound — never the `localhost` name in `ownOrigin`.
  // `ownOrigin`/`aliasOrigin` stay hostnames because they are exactly the Origin/Referer *header values* under
  // test; but once this block also plants a foreign listener on the opposite family at the same port (the
  // `alias` below), `localhost` resolves to both, and Node's fetch()/http.request() race those two connections
  // (RFC 8305 "Happy Eyeballs", on by default since Node 20) — nondeterministically landing a "real" request on
  // the foreign alias instead of Vite. Pinning the connection target to `devTarget` while leaving the headers
  // exactly as designed removes that race from every guard-behaviour assertion below.
  let devTarget: string;
  let usageCalls: Array<{ refresh: boolean; provider: string | null }>;
  let board: { connections: number; requests: number };
  const priorBoardUrl = process.env.QUESTBOARD_URL;

  beforeAll(async () => {
    usageCalls = [];
    fixture = await startFixture({
      usage: {
        listProviderIds: () => ['fake'],
        report: async (opts: { refresh: boolean; provider: string | null }) => {
          usageCalls.push(opts);
          return { generatedAt: new Date().toISOString(), providers: [] };
        },
      },
    });
    board = { connections: 0, requests: 0 };
    fixture.server.on('connection', () => { board.connections += 1; });
    fixture.server.prependListener('request', () => { board.requests += 1; });
    process.env.QUESTBOARD_URL = fixture.base;
    vite = await createViteServer({
      configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
      root: fileURLToPath(new URL('.', import.meta.url)),
      server: { port: 0, strictPort: false },
      logLevel: 'silent',
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('vite dev server did not bind a port');
    if (address.family === 'IPv6' && address.address === '::1') {
      ownOrigin = `http://localhost:${address.port}`;
      aliasOrigin = `http://127.0.0.1:${address.port}`;
      alias = await listenOnAlias(address.port, '127.0.0.1');
    } else if (address.family === 'IPv4' && address.address === '127.0.0.1') {
      // The fix under test: on an IPv4-first machine, Vite still binds one family (127.0.0.1) but prints
      // (and a browser still opens) `http://localhost:P/`. That printed name — not the opposite address
      // family — is this server's own front door; `[::1]` is the truly foreign alias nothing here bound.
      ownOrigin = `http://localhost:${address.port}`;
      aliasOrigin = `http://[::1]:${address.port}`;
      alias = await listenOnAlias(address.port, '::1');
    } else {
      throw new Error(`unexpected default-host bind address ${JSON.stringify(address)}`);
    }
    devTarget = address.family === 'IPv6' ? `http://[${address.address}]:${address.port}` : `http://${address.address}:${address.port}`;
  }, 60000);

  afterAll(async () => {
    await vite?.close();
    await new Promise<void>((resolve) => (alias ? alias.close(() => resolve()) : resolve()));
    await fixture?.close();
    if (priorBoardUrl === undefined) delete process.env.QUESTBOARD_URL;
    else process.env.QUESTBOARD_URL = priorBoardUrl;
  });

  function rawRequest(headers: http.OutgoingHttpHeaders): Promise<{ status?: number; body: string }> {
    return new Promise((resolve, reject) => {
      // Connect to the literal `devTarget`, not `ownOrigin` (the `localhost` name) — see the `devTarget`
      // declaration above for why a `localhost` connection target races against the foreign alias.  The
      // `Host` header is still `ownOrigin`'s, exactly what a real page opened at `ownOrigin` would send.
      const target = new URL(devTarget);
      const req = http.request(
        {
          host: target.hostname,
          port: target.port,
          method: 'GET',
          path: '/api/usage?refresh=1',
          headers: { host: new URL(ownOrigin).host, ...headers },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('the actual bound origin succeeds: forwards to the board', async () => {
    const before = usageCalls.length;
    // Connect to `devTarget` (the literal bound address), not `ownOrigin` — see the `devTarget` declaration
    // above. The Origin/Referer headers are still `ownOrigin`, exactly the case under test.
    const response = await fetch(`${devTarget}/api/usage?refresh=1`, {
      headers: { origin: ownOrigin, referer: `${ownOrigin}/usage` },
    });
    expect(response.status).toBe(200);
    expect(usageCalls.length).toBe(before + 1);
  });

  it('refuses the opposite-family alias origin (absent Fetch metadata): zero board connections/provider calls', async () => {
    const beforeConn = board.connections;
    const beforeReq = board.requests;
    const beforeCalls = usageCalls.length;
    const response = await fetch(`${devTarget}/api/usage?refresh=1`, {
      headers: { origin: aliasOrigin, referer: `${aliasOrigin}/usage` },
    });
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'origin refused' });
    expect(usageCalls.length).toBe(beforeCalls);
    expect(board.connections).toBe(beforeConn);
    expect(board.requests).toBe(beforeReq);
  });

  it('refuses the opposite-family alias origin under Expect: 100-continue too: zero board connections', async () => {
    const beforeConn = board.connections;
    const beforeReq = board.requests;
    const response = await rawRequest({ origin: aliasOrigin, expect: '100-continue' });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'origin refused' });
    expect(board.connections).toBe(beforeConn);
    expect(board.requests).toBe(beforeReq);
  });

  it('the alias really is a different server on this platform (threat context, not the guard itself)', async () => {
    if (!alias) return; // platform refused the dual-stack same-port bind; nothing to demonstrate here
    const res = await fetch(`${aliasOrigin}/`);
    expect(res.headers.get('x-probe')).toBe('foreign');
  });
});

// The describe block above only exercises whichever family *this* machine's own resolver prefers — on an
// IPv6-first box (review's own test machine) the IPv4 branch above never actually runs. These cases build
// the `httpServer.address()`/`resolvedUrls.local` shape directly instead of trusting local DNS order, so the
// IPv4-first regression review found (default host, bound 127.0.0.1, printed `localhost` origin refused) is
// proven fixed on every machine this suite runs on, not just one whose resolver happens to prefer IPv4.
describe('boundDevOrigins: IPv4-first default host (built directly, not dependent on this machine\'s DNS order)', () => {
  function fakeServer(local: string[]): ViteDevServer {
    return {
      httpServer: { address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 6891 }) },
      resolvedUrls: { local, network: [] },
    } as unknown as ViteDevServer;
  }

  it('default host (unset): trusts both the literal 127.0.0.1 bind and the localhost name Vite printed', () => {
    const origins = boundDevOrigins(fakeServer(['http://localhost:6891/']));
    expect(origins.sort()).toEqual(['http://127.0.0.1:6891', 'http://localhost:6891'].sort());
  });

  it('evaluateProxyRequest allows a request from the printed localhost origin — the exact case review found refused', () => {
    const origins = boundDevOrigins(fakeServer(['http://localhost:6891/']));
    const decision = evaluateProxyRequest(
      { origin: 'http://localhost:6891', referer: 'http://localhost:6891/usage' },
      origins,
      BOARD,
    );
    expect(decision.allow).toBe(true);
    expect(decision.overrides.origin).toBe(BOARD);
  });

  it('still refuses the opposite address family even though the port matches', () => {
    const origins = boundDevOrigins(fakeServer(['http://localhost:6891/']));
    expect(evaluateProxyRequest({ origin: 'http://[::1]:6891' }, origins, BOARD).allow).toBe(false);
  });

  it('explicit --host 127.0.0.1 stays exactly as strict as before: no localhost alias is added', () => {
    const origins = boundDevOrigins(fakeServer(['http://127.0.0.1:6891/']));
    expect(origins).toEqual(['http://127.0.0.1:6891']);
    expect(evaluateProxyRequest({ origin: 'http://localhost:6891' }, origins, BOARD).allow).toBe(false);
  });
});
