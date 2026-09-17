// Process-local adapters for the opt-in generic wrapper.  The board never kills the wrapper itself: it
// sends one tokenized request, waits for the wrapper's matching acknowledgement, then checks the matching
// exit-file metadata.  A timeout or a natural exit is deliberately unknown, not stopped.
import fs from 'node:fs';
import path from 'node:path';
import { attemptEvidence } from '../core/cancellation.js';
import { sessionEnded } from '../lanes/opencode.js';

function exitEvidence(config, laneId, name, requestId) {
  const lane = config.lanes[laneId];
  if (!lane?.outputDir) return null;
  try {
    const text = fs.readFileSync(path.join(config.root, lane.outputDir, `${name}.exit`), 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const metadata = lines[1] ? JSON.parse(lines[1]) : null;
    return metadata && metadata.requestId === requestId && metadata.scope === 'direct-child' ? metadata : null;
  } catch { return null; }
}

// The wrapper reports exactly what it did to the process tree it created: 'ok' means the OS tree kill
// returned success on its still-alive direct child, 'failed' means the bounded attempt did not succeed,
// 'skipped' means the platform or timing made the attempt inapplicable. Breakaway descendants cannot be
// ruled out generically, so none of these ever claims a universal "all stopped".
function wrapperStopDetail(evidence) {
  const treeKill = evidence && evidence.treeKill;
  if (treeKill === 'ok') return '包装脚本已确认并记下：它直接启动的进程及其进程树已停止';
  if (treeKill === 'failed') return '包装脚本已确认它直接启动的进程已停止；进程树清理未成功，脱离子进程无法排除';
  return '包装脚本已确认并记下：它直接启动的进程已停止';
}

export function createGenericWrapperAdapter({ config, timeoutMs = 5000 } = {}) {
  return ({ attempt, request, handle }) => new Promise((resolve) => {
    const child = handle?.child;
    const token = handle?.token;
    if (!child || typeof child.send !== 'function' || !token) {
      resolve({ result: 'manual_required', detail: '这个 worker 的包装脚本不支持可核实的停止，需要手动确认' });
      return;
    }
    let acknowledged = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.('message', onMessage);
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      child.off?.('error', onError);
      resolve(value);
    };
    const onMessage = (message) => {
      if (!message || message.type !== 'questboard-cancel-ack' || message.attemptId !== attempt.attemptId || message.requestId !== request.requestId || message.scope !== 'direct-child') return;
      acknowledged = true;
      // The wrapper sends the ack immediately before killing its direct child. The exit event and the
      // exit-file write are the second, independent fact; ack alone never frees the reservation.
      if (exitEvidence(config, attempt.lane, attempt.name, request.requestId)) finish({
        result: 'stopped_by_wrapper', detail: wrapperStopDetail(exitEvidence(config, attempt.lane, attempt.name, request.requestId)),
        evidence: { kind: 'wrapper', attempt: attemptEvidence(attempt), ack: true, exitRequestId: request.requestId, scope: 'direct-child', treeKill: exitEvidence(config, attempt.lane, attempt.name, request.requestId).treeKill ?? null },
      });
    };
    const onExit = () => {
      const evidence = exitEvidence(config, attempt.lane, attempt.name, request.requestId);
      if (acknowledged && evidence) finish({
        result: 'stopped_by_wrapper', detail: wrapperStopDetail(evidence),
        evidence: { kind: 'wrapper', attempt: attemptEvidence(attempt), ack: true, exitRequestId: evidence.requestId, scope: evidence.scope, treeKill: evidence.treeKill ?? null },
      });
      else finish({ result: 'unknown', detail: 'worker 已退出，但没有对应的取消确认和退出记录' });
    };
    const onError = () => finish({ result: 'unknown', detail: '和 worker 的控制连接在收到确认前断了' });
    const timer = setTimeout(() => finish({ result: 'unknown', detail: '等取消确认超时；worker 仍占着，需要手动处理' }), timeoutMs);
    timer.unref?.();
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('close', onExit);
    child.once('error', onError);
    try {
      child.send({ type: 'questboard-cancel', attemptId: attempt.attemptId, requestId: request.requestId, token }, (error) => {
        if (error) finish({ result: 'unknown', detail: '取消指令没送到；worker 仍占着' });
      });
    } catch {
      finish({ result: 'unknown', detail: '取消指令没送到；worker 仍占着' });
    }
  });
}

const API_TIMEOUT_MS = 5000;
const TIMEOUT = Symbol('timeout');

function isOk(response) {
  return Boolean(response && (response.ok === true || (response.status >= 200 && response.status < 300)));
}

async function responseBody(response) {
  if (!response || typeof response.json !== 'function') return undefined;
  try { return await response.json(); } catch { return undefined; }
}

async function boundedCall(fn, deadline) {
  const remaining = Math.max(0, deadline - Date.now());
  if (!remaining) return TIMEOUT;
  let timer;
  const work = Promise.resolve().then(fn).then((value) => ({ value }), (error) => ({ error }));
  const wait = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), remaining);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([work, wait]);
    if (outcome === TIMEOUT) return TIMEOUT;
    if (outcome && outcome.error) throw outcome.error;
    return outcome?.value;
  } finally { clearTimeout(timer); }
}

function sessionIdOf(assignee) {
  return assignee?.session?.id || assignee?.sessionId || null;
}

function apiUrl(base, sessionId, suffix) {
  return `${String(base).replace(/\/+$/, '')}/session/${encodeURIComponent(sessionId)}${suffix}`;
}

// Opt-in remote control for an OpenCode session. This adapter never receives a process handle and
// never discovers one: its only effects are the lane API POST and the one follow-up session read.
export function createOpenCodeSessionAdapter({ fetchImpl = fetch, timeoutMs = API_TIMEOUT_MS } = {}) {
  return async ({ attempt, assignee = attempt, laneConfig }) => {
    const baseUrl = laneConfig?.api;
    const sessionId = sessionIdOf(assignee);
    if (!baseUrl || !sessionId) return { result: 'manual_required', detail: '没有记录的 session id 或 lane API 地址，无法请求远程停止，需要手动确认' };
    const deadline = Date.now() + Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : API_TIMEOUT_MS);
    const abortPath = apiUrl(baseUrl, sessionId, '/abort');
    try {
      const response = await boundedCall(() => fetchImpl(abortPath, { method: 'POST', signal: AbortSignal.timeout?.(Math.max(1, deadline - Date.now())) }), deadline);
      if (response === TIMEOUT) return { result: 'unknown', detail: '远程停止请求超时，未能确认 session 已结束' };
      if (!isOk(response)) return { result: 'unknown', detail: `远程停止请求未被接受（HTTP ${response?.status || '未知'}），未能确认 session 已结束` };
      const abortAcknowledged = (await responseBody(response)) !== false;
      const followUpPath = apiUrl(baseUrl, sessionId, '/message');
      const followUp = await boundedCall(async () => {
        const read = await fetchImpl(followUpPath, { method: 'GET', signal: AbortSignal.timeout?.(Math.max(1, deadline - Date.now())) });
        return { response: read, body: isOk(read) && typeof read.json === 'function' ? await read.json() : null };
      }, deadline);
      if (followUp === TIMEOUT || !followUp || !isOk(followUp.response) || !sessionEnded(followUp.body)) {
        return { result: 'unknown', detail: abortAcknowledged ? '远程停止请求已被接受，但后续读取没有显示 session 已结束' : '远程停止请求返回 false，未确认取消；后续读取没有显示 session 已结束' };
      }
      if (!abortAcknowledged) {
        return { result: 'unknown', detail: '远程停止请求返回 false，未确认取消；后续读取不能作为停止证明' };
      }
      return {
        result: 'stopped_by_api', detail: '远程停止请求已被接受，后续读取确认 session 已结束',
        evidence: { kind: 'opencode-session', attempt: attemptEvidence(assignee), ack: true, followupEnded: true, sessionId, abortPath },
      };
    } catch (error) {
      const reason = error?.name === 'AbortError' ? '请求超时' : '通信失败';
      return { result: 'unknown', detail: `远程停止请求或后续读取失败（${reason}），未能确认 session 已结束` };
    }
  };
}

// Kept as a descriptive alias for callers that used the earlier API-oriented name while the
// configured lane type remains the explicit `opencode-session` opt-in.
export const createOpenCodeApiAdapter = createOpenCodeSessionAdapter;
