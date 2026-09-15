// A server lane (one with `api`, like an OpenCode `serve`) only works while its server runs. When nothing
// answers, a dispatch fails ten seconds later with a bare "fetch failed". This checks the server and starts it
// from the lane's own `serve` command, so the owner can bring it up from the settings page.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WINDOWS_SHIMS = new Set(['', '.cmd', '.bat']);
const HTML_CONTENT_TYPE_RE = new RegExp('text/html|application/xhtml\\+xml', 'i');
const HTML_BODY_RE = new RegExp('^<(!doctype\\s+html|html[\\s>])', 'i');
const SECRET_KEY_RE = new RegExp('(?:sk-|sk_|ghp_|gho_|github_pat_|xox[baprs]-|AIza|AKIA|glpat-)[a-zA-Z0-9_\\-]{6,}', 'g');
const SECRET_BEARER_RE = new RegExp('(Bearer\\s+)[a-zA-Z0-9._\\-]{10,}', 'gi');
const SECRET_BASIC_RE = new RegExp('(Basic\\s+)[a-zA-Z0-9+/=]{4,}', 'gi');
// Value runs to the next whitespace or quote, not a fixed charset, so punctuation in a real password
// (p@ssw0rd!) doesn't stop the match early and leave the tail exposed.
const SECRET_KV_RE = new RegExp('((?:[\'"]?)(?:api[-_]?key|access[-_]?key|key|token|password|secret|auth(?:orization)?)(?:[\'"]?)\\s*[:=]\\s*[\'"]?)([^\\s\'"]{3,})([\'"]?)', 'gi');
const SECRET_HEADER_RE = new RegExp('((?:x-api-key|api-key)\\s+)([^\\s]{3,})', 'gi');
// user:pass@host inside a URL (e.g. leaked from a lane's own api into a 409/log message).
const SECRET_USERINFO_RE = new RegExp('(://)[^\\s@/]+:[^\\s@/]+@', 'g');
const ADDR_IN_USE_RE = new RegExp('eaddrinuse|address already in use|port is taken|port already in use|端口被占用|已被占用|10048', 'i');

/* In-flight start attempts by projectRoot::laneId::api to guarantee concurrent clicks share one spawn */
export const inFlightStarts = new Map();

export function isHtmlContent(contentType = '', bodyText = '') {
  if (typeof contentType === 'string' && HTML_CONTENT_TYPE_RE.test(contentType)) return true;
  if (typeof bodyText === 'string' && HTML_BODY_RE.test(bodyText.trimStart())) return true;
  return false;
}

// Without a declared health contract (`health` on the lane's config), the board cannot guess what a
// compatible reply looks like for a custom lane — so it keeps its long-standing behaviour: any HTTP reply at
// all means something is listening and reachable. This intentionally does not detect "wrong service on this
// port" for lanes without a contract; that tradeoff is deliberate; see the health field for lanes that want it.
export async function checkServerHealth(api, { fetchImpl = fetch, timeout = 2000, health = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const url = health ? `${api}${health.path}` : api;
  // api can carry userinfo (http://user:pass@host) if someone pastes a URL with embedded credentials into a
  // lane's config; every message below that echoes the URL back must not leak it.
  const redactedUrl = redactSecrets(url);
  try {
    // Manual, not follow: an occupied port that answers with a redirect must not silently pull the probe onto
    // a different host. A 3xx status is then classified below same as any other non-2xx: wrong_service.
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' });
    const status = typeof res.status === 'number' ? res.status : (res.ok ? 200 : (res.ok === false ? 500 : 200));

    if (!health) {
      return { up: true, status: 'up', conflicting: false, httpStatus: status, isHtml: false, detail: '服务有响应' };
    }

    let contentType = '';
    if (res.headers) {
      if (typeof res.headers.get === 'function') {
        contentType = res.headers.get('content-type') || '';
      } else if (typeof res.headers === 'object') {
        contentType = res.headers['content-type'] || res.headers['Content-Type'] || '';
      }
    }

    let bodyText = '';
    try {
      if (typeof res.text === 'function') {
        bodyText = await res.text();
      } else if (typeof res.json === 'function') {
        bodyText = JSON.stringify(await res.json());
      } else if (typeof res.body === 'string') {
        bodyText = res.body;
      }
    } catch {
      /* Body may be unreadable or consumed; bodyText remains empty */
    }

    if (isHtmlContent(contentType, bodyText)) {
      return {
        up: false,
        status: 'wrong_service',
        conflicting: true,
        httpStatus: status,
        isHtml: true,
        detail: `健康检查地址 ${redactedUrl} 返回了 HTML 页面（HTTP ${status}），不是期望的健康检查接口`,
      };
    }

    // 401 and 5xx mean the right server answered but is unhappy (needs auth, or a transient error) — not that a
    // different program owns the port. 404 (and other 4xx) look like the wrong path or the wrong app entirely.
    if (status === 401 || status >= 500) {
      return {
        up: false,
        status: 'unhealthy',
        conflicting: true,
        httpStatus: status,
        isHtml: false,
        detail: `服务在 ${redactedUrl} 应答了（HTTP ${status}），但状态不健康`,
      };
    }

    if (status < 200 || status >= 300) {
      return {
        up: false,
        status: 'wrong_service',
        conflicting: true,
        httpStatus: status,
        isHtml: false,
        detail: `健康检查地址 ${redactedUrl} 返回了 HTTP ${status}，不是期望的健康检查接口`,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return {
        up: false,
        status: 'wrong_service',
        conflicting: true,
        httpStatus: status,
        isHtml: false,
        detail: `健康检查地址 ${redactedUrl} 没有返回 JSON，不是期望的健康检查接口`,
      };
    }

    if (health.json) {
      const mismatch = Object.entries(health.json).find(([key, value]) => !parsed || parsed[key] !== value);
      if (mismatch) {
        const [key, expected] = mismatch;
        const actual = parsed ? parsed[key] : undefined;
        return {
          up: false,
          status: 'unhealthy',
          conflicting: true,
          httpStatus: status,
          isHtml: false,
          detail: `服务在 ${redactedUrl} 应答了，但状态不健康（期望 ${key} 为 ${JSON.stringify(expected)}，实际是 ${JSON.stringify(actual)}）`,
        };
      }
    }

    return { up: true, status: 'up', conflicting: false, httpStatus: status, isHtml: false, detail: '服务正常响应' };
  } catch (error) {
    const isAbort = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return {
      up: false,
      status: 'down',
      conflicting: false,
      httpStatus: null,
      isHtml: false,
      detail: isAbort ? '连接超时' : `无法连接（${redactSecrets(error?.message || 'unreachable')}）`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Up means reachable (or, with a declared health contract, actually healthy at that contract's endpoint). */
export async function laneServerUp(api, { fetchImpl = fetch, timeout = 2000, health = null } = {}) {
  const result = await checkServerHealth(api, { fetchImpl, timeout, health });
  return result.up;
}

// npm installs CLIs on Windows as .cmd shims, which Node will not spawn directly; cmd.exe finds and runs them
// the way a terminal does.
export function serveCommand(args, { platform = process.platform, env = process.env } = {}) {
  const [head, ...rest] = args;
  if (head === 'node') return { file: process.execPath, args: rest };
  if (platform === 'win32' && WINDOWS_SHIMS.has(path.extname(head).toLowerCase())) {
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/c', head, ...rest] };
  }
  return { file: head, args: rest };
}

// Best-effort: catches the shapes seen in practice (known token prefixes, Bearer/Basic auth, key=/key: pairs,
// header-style "x-api-key <value>", URL userinfo). It is not a guarantee that every possible secret shape is
// caught — a value that doesn't look like any of these patterns passes through unchanged.
function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(SECRET_BEARER_RE, '$1[已隐藏]')
    .replace(SECRET_BASIC_RE, '$1[已隐藏]')
    .replace(SECRET_USERINFO_RE, '$1[已隐藏]@')
    .replace(SECRET_KV_RE, '$1[已隐藏]$3')
    .replace(SECRET_HEADER_RE, '$1[已隐藏]')
    .replace(SECRET_KEY_RE, '[已隐藏]');
}

function logTail(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-6).join('\n').slice(-600);
    return redactSecrets(raw);
  } catch {
    return '';
  }
}

/** Every server lane with whether its server answers now and whether the board can start it. */
export async function laneServers(config, { fetchImpl = fetch } = {}) {
  const lanes = Object.values(config.lanes).filter((lane) => lane.api);
  return Promise.all(lanes.map(async (lane) => ({
    id: lane.id,
    api: lane.api,
    serve: lane.serve || null,
    up: await laneServerUp(lane.api, { fetchImpl, health: lane.health || null }),
  })));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Something else is answering the configured health check, honestly — not a service we can safely start over.
// Only reachable when the lane declares a `health` contract; without one, checkServerHealth never reports
// conflicting and this is never called.
function conflictReason(laneId, api, health) {
  const safeApi = redactSecrets(api);
  const detail = health.detail || '健康检查没有通过';
  if (health.status === 'unhealthy') {
    return `${detail}。通道 ${laneId} 在 ${safeApi} 上的服务已经在回应了，但健康检查没有通过，所以没有把它当成可用服务，也没有再启动一次命令`;
  }
  return `${detail}。通道 ${laneId} 配置的地址 ${safeApi} 上已经有其它服务在监听，看起来不是期望的 API，所以没有启动新的命令。检查这个通道的端口有没有被别的服务占用，需要的话在设置里换一个端口，并确认 api 和 serve 用的是同一个端口`;
}

function startFailureReason({ laneId, api, ended, addrInUse, lastHealth, output, waitMs }) {
  const safeApi = redactSecrets(api);
  const base = ended ? `启动命令结束了（${ended}），${safeApi} 仍然连不上` : `等了 ${Math.round(waitMs / 1000)} 秒，${safeApi} 还是连不上（命令可能还在启动）`;
  const withOutput = output ? `${base}。输出：${output}` : base;
  if (addrInUse) {
    return `${withOutput}。这通常是端口被占用（配置的端口和别的服务冲突）：检查设置里这个通道的端口，需要的话换一个端口，并确认 api 和 serve 用的是同一个端口`;
  }
  if (lastHealth && lastHealth.conflicting) {
    // Post-spawn, a conflicting reply must not reuse conflictReason's "所以没有启动新的命令" wording — a
    // command *was* spawned here (that's how we got a log to show). Only the pre-spawn 409 path (in
    // performStart, above) says a command was never started.
    return `${withOutput}。最后一次健康检查：${lastHealth.detail}（可能是端口上的其它服务，也可能是刚启动的服务还没就绪）`;
  }
  return withOutput;
}

async function performStart({ config, lane, laneId, fetchImpl, spawnImpl, waitMs, pollMs, platform, env }) {
  const health = lane.health || null;
  const preCheck = await checkServerHealth(lane.api, { fetchImpl, health });
  if (preCheck.up) return { status: 200, body: { up: true, started: false } };
  if (preCheck.conflicting) {
    return { status: 409, body: { error: conflictReason(laneId, lane.api, preCheck), conflicting: true } };
  }

  const log = path.join(config.paths.data, `lane-${laneId}-serve.log`);
  let fd;
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    // 'w', never 'a': see dispatch.js — an append-only handle breaks some Windows children.
    fd = fs.openSync(log, 'w');
  } catch (error) {
    return { status: 500, body: { error: `准备日志文件失败（${config.paths.data}）：${redactSecrets(error.message)}` } };
  }

  let child;
  try {
    const { file, args } = serveCommand(lane.serve, { platform, env });
    // Detached and unreferenced: the server outlives this request and the board, like one started in a terminal.
    child = spawnImpl(file, args, { cwd: config.root, stdio: ['ignore', fd, fd], windowsHide: true, detached: true });
  } catch (error) {
    return { status: 500, body: { error: `启动命令没能运行：${redactSecrets(error.message)}`, log } };
  } finally {
    fs.closeSync(fd);
  }

  let ended = null;
  const onError = (error) => { ended = redactSecrets(error.message); };
  const onExit = (code) => { ended = `退出码 ${code}`; };
  child.on('error', onError);
  child.on('exit', onExit);
  child.unref();

  const deadline = Date.now() + waitMs;
  let lastHealth = null;
  try {
    for (;;) {
      lastHealth = await checkServerHealth(lane.api, { fetchImpl, health });
      if (lastHealth.up) return { status: 200, body: { up: true, started: true, pid: child.pid, log } };
      // A conflicting/unhealthy reply while we're waiting does not end the wait early: the board's own child
      // may be the one answering while it warms up (e.g. a health endpoint that isn't ready yet). Only the
      // command exiting or the deadline passing ends the attempt.
      if (ended || Date.now() >= deadline) break;
      await sleep(pollMs);
    }
  } finally {
    // The child (if it came up) keeps running past this request; only our own tracking listeners come off.
    child.removeListener('error', onError);
    child.removeListener('exit', onExit);
    // A later 'error' on this detached child must not crash the board — we no longer act on it, but Node
    // throws when an EventEmitter gets an 'error' event with no listener at all, so keep a silent one.
    child.on('error', () => {});
  }

  const output = logTail(log);
  const addrInUse = ADDR_IN_USE_RE.test(output) || (ended && ADDR_IN_USE_RE.test(ended));
  const error = startFailureReason({ laneId, api: lane.api, ended, addrInUse, lastHealth, output, waitMs });
  return { status: 502, body: { error, log } };
}

export async function startLaneServer({ config, laneId, fetchImpl = fetch, spawnImpl = spawn, waitMs = 20000, pollMs = 500, platform = process.platform, env = process.env }) {
  const lane = config.lanes[laneId];
  if (!lane) return { status: 404, body: { error: `没有通道 ${laneId}` } };
  if (!lane.api) return { status: 400, body: { error: `通道 ${laneId} 不靠服务运行（没有 api），不需要启动` } };
  if (!lane.serve) {
    return { status: 400, body: { error: `通道 ${laneId} 没有填启动命令（serve）。在设置里填上、保存并重启看板后，才能一键启动` } };
  }

  // Concurrent clicks for the same project/lane/api share this one attempt: at most one spawn. The entry is
  // gone by the time any awaiter sees the result, so a later explicit request always gets a fresh attempt.
  const key = `${config.root}::${laneId}::${lane.api}`;
  const inFlight = inFlightStarts.get(key);
  if (inFlight) return inFlight;

  const attempt = performStart({ config, lane, laneId, fetchImpl, spawnImpl, waitMs, pollMs, platform, env });
  inFlightStarts.set(key, attempt);
  // Belt and suspenders: performStart already catches its own fs/spawn failures, but nothing should ever let
  // a derived promise reject unhandled and crash the board process.
  attempt.finally(() => { inFlightStarts.delete(key); }).catch(() => {});
  return attempt;
}
