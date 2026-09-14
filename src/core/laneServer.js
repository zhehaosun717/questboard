// A server lane (one with `api`, like an OpenCode `serve`) only works while its server runs. When nothing
// answers, a dispatch fails ten seconds later with a bare "fetch failed". This checks the server and starts it
// from the lane's own `serve` command, so the owner can bring it up from the settings page.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WINDOWS_SHIMS = new Set(['', '.cmd', '.bat']);

/** Up means anything answers at the address; a refused or timed-out connection is down. */
export async function laneServerUp(api, { fetchImpl = fetch, timeout = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    await fetchImpl(api, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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

function logTail(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-6).join('\n').slice(-600);
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
    up: await laneServerUp(lane.api, { fetchImpl }),
  })));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startLaneServer({ config, laneId, fetchImpl = fetch, spawnImpl = spawn, waitMs = 20000, pollMs = 500, platform = process.platform, env = process.env }) {
  const lane = config.lanes[laneId];
  if (!lane) return { status: 404, body: { error: `没有通道 ${laneId}` } };
  if (!lane.api) return { status: 400, body: { error: `通道 ${laneId} 不靠服务运行（没有 api），不需要启动` } };
  if (!lane.serve) {
    return { status: 400, body: { error: `通道 ${laneId} 没有填启动命令（serve）。在设置里填上、保存并重启看板后，才能一键启动` } };
  }
  if (await laneServerUp(lane.api, { fetchImpl })) return { status: 200, body: { up: true, started: false } };

  const log = path.join(config.paths.data, `lane-${laneId}-serve.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  // 'w', never 'a': see dispatch.js — an append-only handle breaks some Windows children.
  const fd = fs.openSync(log, 'w');
  let ended = null;
  let child;
  try {
    const { file, args } = serveCommand(lane.serve, { platform, env });
    // Detached and unreferenced: the server outlives this request and the board, like one started in a terminal.
    child = spawnImpl(file, args, { cwd: config.root, stdio: ['ignore', fd, fd], windowsHide: true, detached: true });
  } catch (error) {
    return { status: 500, body: { error: `启动命令没能运行：${error.message}`, log } };
  } finally {
    fs.closeSync(fd);
  }
  child.on('error', (error) => { ended = error.message; });
  child.on('exit', (code) => { ended = `退出码 ${code}`; });
  child.unref();

  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await laneServerUp(lane.api, { fetchImpl })) return { status: 200, body: { up: true, started: true, pid: child.pid, log } };
    if (ended || Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  const output = logTail(log);
  const why = ended ? `启动命令结束了（${ended}），${lane.api} 仍然连不上` : `等了 ${Math.round(waitMs / 1000)} 秒，${lane.api} 还是连不上（命令可能还在启动）`;
  return { status: 502, body: { error: output ? `${why}。输出：${output}` : why, log } };
}
