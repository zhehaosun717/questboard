import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Connect, Plugin, ViteDevServer } from 'vite';

// The board server only accepts same-origin JSON writes, and same-origin for GETs with a side effect (a
// usage refresh that calls providers and spends quota). In development the page comes from Vite while the
// API lives on the board server, so this proxy is the front door those requests actually cross: only a
// request whose Origin/Referer genuinely came from Vite's own dev page may be re-addressed as the board's
// origin — a foreign page's request is refused right here, before it ever reaches the board.
const BOARD = process.env.QUESTBOARD_URL || 'http://127.0.0.1:6097';

// Paths this front door actually guards — kept identical to the `server.proxy` keys below (Vite matches a
// proxy context with a plain `url.startsWith(context)`), so nothing the proxy would forward can skip the
// guard, and nothing outside its scope gets needlessly blocked.
const GUARDED_PATH_PREFIXES = ['/api', '/review'];

function isGuardedPath(url: string): boolean {
  return GUARDED_PATH_PREFIXES.some((prefix) => url.startsWith(prefix));
}

// The dev server's own front door, read live from the http.Server Vite actually bound — never a hardcoded
// port, and never every loopback spelling for that port regardless of which address family is actually
// listening. Before `listen()` resolves, `address()` is null and no origin is genuinely ours yet, so the
// door stays closed to everyone. Once bound, only the loopback name(s) that address itself actually answers
// to are allowed: a plain IPv4 loopback bind does not also make `localhost`/`::1` this server's front door
// merely because the port number matches — some unrelated process could be squatting the other address
// family on that same port number, and a browser resolving `localhost` to that family would then be shown
// a foreign page whose Origin this guard would otherwise have trusted (this is exactly the gap review found:
// a same-port alias on a family Vite never bound was being treated as the dev server's own origin).
export function boundDevOrigins(server: ViteDevServer): string[] {
  const httpServer = server.httpServer;
  const address = httpServer && typeof httpServer.address === 'function' ? httpServer.address() : null;
  if (!address || typeof address === 'string') return [];
  const { address: host, family, port } = address;

  let strict: string;
  if (family === 'IPv4' && host === '127.0.0.1') {
    strict = `http://127.0.0.1:${port}`;
  } else if (family === 'IPv6' && host === '::1') {
    strict = `http://[::1]:${port}`;
  } else {
    // Any other bound address — a wildcard host (`0.0.0.0`/`::`, e.g. from `host: true`), a LAN interface, or
    // a loopback spelling this guard has not verified — is not a case where "which loopback names actually
    // reach this server" is known here without probing the other address family at runtime, which this guard
    // deliberately does not do. Fail closed (no Origin is trusted) rather than guess, and say why so the
    // refusal is diagnosable instead of a silent 403 on every request.
    // eslint-disable-next-line no-console
    console.warn(
      `[questboard] dev proxy front door: cannot determine a safe front-door origin for bound address ` +
        `${JSON.stringify(host)} (family ${family}, port ${port}) — refusing every Origin. Run "npm run dev" ` +
        `with the default host, or an explicit --host 127.0.0.1, to use the proxy.`,
    );
    return [];
  }

  // The bare bind address alone is not always what a developer actually has open: when `server.host` is left
  // at its default (or set to the literal `"localhost"`), Vite resolves that name through Node's own DNS
  // order and binds to *one* family — but still prints (and the browser still navigates to) `http://localhost:
  // P/` regardless of whether that resolution landed on `127.0.0.1` or `::1`. `server.resolvedUrls.local` is
  // exactly the "Local:" line Vite itself already computed and printed for this bind, so trusting it (rather
  // than re-deriving Vite's own hostname-resolution rules here) can never allow more than what Vite itself
  // considers this server's own address: an explicit `--host 127.0.0.1`/`--host ::1` makes Vite resolve and
  // print that literal address too, so this stays exactly as strict as the bare bind check above in that case
  // (no `localhost` alias is added), while a default/explicit-`localhost` host adds the one alias a real
  // browser will actually be pointed at. Filtered to this exact port and origin-parsed defensively — never
  // trusted as a raw string — even though `resolvedUrls` is always derived from this same bound address.
  const resolvedLocal = server.resolvedUrls?.local ?? [];
  const origins = new Set<string>([strict]);
  for (const url of resolvedLocal) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.port === String(port)) origins.add(parsed.origin);
  }
  return [...origins];
}

// A value counts as this dev server's own front door only if it is *exactly* one of the live-bound origin
// strings — scheme, host, port, nothing else. Deliberately no `new URL()`/parsing round-trip for this
// comparison: parsing normalizes away precisely the differences that must stay significant here — it
// lowercases a host (`LOCALHOST`), collapses a leading-zero port (`:05173`), folds an alternate IPv4 spelling
// (`0x7f.0.0.1`) into the canonical form, and gives a bare origin and one with a trailing slash the same
// `pathname` — silently turning all of those into "the same origin" a real browser never actually sends. A
// plain string-equality check against the live-bound set has none of that surface.
function isFrontDoorOrigin(value: string, origins: string[]): boolean {
  return origins.includes(value);
}

// A Referer is allowed only when it is exactly one bound origin, or that origin followed by `/` and a path —
// never a same-prefix-but-different-origin string (`http://localhost:51730/x` must not match `:5173`), which
// is why this checks for the separator rather than a bare `startsWith`.
function isFrontDoorReferer(value: string, origins: string[]): string | null {
  for (const origin of origins) {
    if (value === origin || value.startsWith(`${origin}/`)) return origin;
  }
  return null;
}

// Decides, from the request's own Origin/Referer/Sec-Fetch-Site, whether this proxy may forward the request
// at all, and if so what (if anything) to rewrite. A header that is present but does not match the dev
// server's own live-bound front door — foreign, on a foreign port, a non-http scheme, malformed, contradictory
// with another header — gets the whole request refused right here rather than forwarded with the header
// silently dropped or laundered into the board's origin: an absent header is accepted (the existing route
// contract already treats a missing Origin/Referer as CLI-compatible, so there is nothing to launder by
// leaving it absent), but turning a foreign header into "no header" would be exactly the same laundering with
// extra steps. Exported as a pure function (headers + the live origin set in, a decision out) so it is
// unit-testable without a real Vite dev server; the actual wiring below (and vite.config.test.ts's forwarding
// tests) is what proves it also holds through a real proxy and a real board backend.
export function evaluateProxyRequest(
  headers: { origin?: string; referer?: string; 'sec-fetch-site'?: string },
  origins: string[],
  boardOrigin: string,
) {
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return { allow: false as const };

  const originHeader = headers.origin;
  if (originHeader !== undefined && !isFrontDoorOrigin(originHeader, origins)) return { allow: false as const };

  let rewrittenReferer: string | undefined;
  const refererHeader = headers.referer;
  if (refererHeader !== undefined) {
    const matchedOrigin = isFrontDoorReferer(refererHeader, origins);
    if (matchedOrigin === null) return { allow: false as const };
    rewrittenReferer = boardOrigin + refererHeader.slice(matchedOrigin.length);
  }

  const overrides: Record<string, string> = {};
  if (originHeader !== undefined) overrides.origin = boardOrigin;
  if (rewrittenReferer !== undefined) overrides.referer = rewrittenReferer;
  return { allow: true as const, overrides };
}

// Fixed text only: never echoes back whatever Origin/Referer the caller sent (see src/server/http.js's own
// crossSiteRefusal, which the same principle already applies to on the backend side).
const FRONT_DOOR_REFUSAL_BODY = JSON.stringify({ error: 'origin refused' });

// Registered from `configureServer` with a direct `server.middlewares.use(...)` call (not a returned post
// hook), so Vite adds it to the connect stack immediately — before it appends its own built-in proxy
// middleware for `server.proxy`. That ordering is what actually closes the two gaps a `proxy.on('proxyReq',
// ...)` handler could not: `proxyReq` only fires *after* http-proxy has already opened the upstream TCP
// connection (so a refused request still cost the board a connection), and it is skipped entirely for a
// request carrying `Expect: 100-continue` (Node auto-answers 100 Continue and dispatches to this same
// connect stack either way, so a plain middleware sees it like any other request). A request this middleware
// refuses never reaches `proxy.web()` at all: zero upstream connections, zero bytes, zero board-side effect.
function frontDoorGuardPlugin(): Plugin {
  let devServer: ViteDevServer | null = null;
  return {
    name: 'questboard-front-door-guard',
    configureServer(server) {
      devServer = server;
      const guard: Connect.NextHandleFunction = (req, res, next) => {
        if (!req.url || !isGuardedPath(req.url)) { next(); return; }
        const origins = devServer ? boundDevOrigins(devServer) : [];
        const decision = evaluateProxyRequest(
          {
            origin: req.headers.origin,
            referer: req.headers.referer,
            'sec-fetch-site': req.headers['sec-fetch-site'] as string | undefined,
          },
          origins,
          BOARD,
        );
        if (!decision.allow) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          res.end(FRONT_DOOR_REFUSAL_BODY);
          return;
        }
        // Mutated before `next()` hands off to Vite's own proxy middleware further down the same stack,
        // which reads `req.headers` at forward time — so the board sees the rewritten values, never the
        // caller's raw ones, and no foreign header is ever laundered into "absent".
        for (const [name, value] of Object.entries(decision.overrides)) {
          req.headers[name] = value;
        }
        next();
      };
      server.middlewares.use(guard);
    },
  };
}

export default defineConfig({
  plugins: [react(), frontDoorGuardPlugin()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: BOARD, changeOrigin: true },
      '/review': { target: BOARD, changeOrigin: true },
    },
  },
});
