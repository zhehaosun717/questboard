// Antigravity (agy) quota, read from the IDE's own language server on this machine — the way the
// antigravity-cockpit extension does it. The server takes a CSRF token that only appears on its command line;
// we read it from the process list into memory, send it in one header, and never store or print it. Owner
// consent for reading another app's login: 2026-09-13.
import https from 'node:https';
import path from 'node:path';
import { UsageError, isoOrNull, safeLabel } from './common.js';

const PROCESS_NAME = 'language_server_windows_x64.exe';
const STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
// Model labels like "Gemini 3 Pro (High)"; anything long enough to be a token is dropped.
const LABEL_PATTERN = /^[\w .()/+-]{1,40}$/;
const TOKEN_PATTERN = /--csrf_token[=\s]+([a-f0-9-]{8,64})/i;
const PORT_PATTERN = /^\d{2,5}$/;
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]/.test(process.env.SystemRoot || process.env.SYSTEMROOT || '')
  ? (process.env.SystemRoot || process.env.SYSTEMROOT)
  : 'C:\\Windows';
export const POWERSHELL_PATH = path.win32.join(WINDOWS_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// PowerShell, because the token lives in CommandLine and Get-NetTCPConnection maps ports to a pid.
const LIST_PROCESSES = ['-NoProfile', '-NonInteractive', '-Command',
  '"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'csrf_token\' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"'];
const listPorts = (pid) => ['-NoProfile', '-NonInteractive', '-Command',
  `"Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique"`];

// Finds the Antigravity language server: pid and token. Other processes that mention csrf_token are skipped.
export function findLanguageServer(processJson) {
  let parsed;
  try { parsed = JSON.parse(String(processJson || '').trim() || 'null'); } catch { return null; }
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  for (const item of list) {
    const name = String(item && item.Name || '');
    const commandLine = String(item && item.CommandLine || '');
    const match = commandLine.match(TOKEN_PATTERN);
    if (!match || !Number.isInteger(item.ProcessId)) continue;
    if (name.toLowerCase() === PROCESS_NAME || /language_server/i.test(name)) return { pid: item.ProcessId, token: match[1] };
  }
  return null;
}

export function parsePorts(text) {
  return [...new Set(String(text || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => PORT_PATTERN.test(line)).map(Number))].filter((p) => p > 0 && p <= 65535);
}

// One POST to the local server; self-signed certificate, so verification is off for 127.0.0.1 only.
export function postLocalJson(port, body, headers, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = https.request({
      hostname: '127.0.0.1', port, path: STATUS_PATH, method: 'POST', rejectUnauthorized: false, agent: false, timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'connect-protocol-version': '1', ...headers },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new UsageError('local_http_status', { status: response.statusCode })); return; }
        try { resolve(JSON.parse(text)); } catch { reject(new UsageError('local_not_json')); }
      });
    });
    request.on('timeout', () => request.destroy(new UsageError('local_timeout')));
    request.on('error', (error) => reject(error instanceof UsageError ? error : new UsageError('local_unreachable')));
    request.end(data);
  });
}

export function decodeUserStatus(body) {
  const status = body && body.userStatus;
  if (!status || typeof status !== 'object') throw new UsageError('no_account_status');
  const configs = status.cascadeModelConfigData && Array.isArray(status.cascadeModelConfigData.clientModelConfigs) ? status.cascadeModelConfigData.clientModelConfigs : [];
  const windows = [];
  for (const model of configs) {
    const quota = model && model.quotaInfo;
    const label = safeLabel(model && model.label, LABEL_PATTERN);
    if (!quota || typeof quota.remainingFraction !== 'number' || !label) continue;
    windows.push({ label, usedPercent: Math.round((1 - Math.max(0, Math.min(1, quota.remainingFraction))) * 1000) / 10, resetsAt: isoOrNull(quota.resetTime) });
  }
  const plan = status.planStatus && status.planStatus.planInfo;
  const planName = safeLabel(plan && plan.planName, LABEL_PATTERN);
  const monthly = Number(plan && plan.monthlyPromptCredits);
  const available = Number(status.planStatus && status.planStatus.availablePromptCredits);
  const credits = monthly > 0 && Number.isFinite(available) ? `额度 ${available} / ${monthly}` : '';
  return { windows, plan: [planName, credits].filter(Boolean).join(' · '), note: windows.length ? '' : '这个账户没有按模型的额度信息' };
}

export function createAntigravityProvider({ post = postLocalJson, platform = process.platform } = {}) {
  return {
    id: 'agy',
    name: 'Antigravity（agy）',
    source: 'local-app',
    access: 'local-app',
    credentialType: 'antigravity-local-csrf',
    async fetch({ exec }) {
      if (platform !== 'win32') return { ok: false, configured: false, code: 'windows_only' };
      const found = findLanguageServer(await exec(POWERSHELL_PATH, LIST_PROCESSES, { timeoutMs: 20000 }));
      if (!found) return { ok: false, configured: false, code: 'process_not_found' };
      const ports = parsePorts(await exec(POWERSHELL_PATH, listPorts(found.pid), { timeoutMs: 20000 }));
      if (!ports.length) throw new UsageError('no_listening_port');
      let lastError = null;
      for (const port of ports) {
        try {
          const body = await post(port, { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }, { 'x-codeium-csrf-token': found.token });
          return decodeUserStatus(body);
        } catch (error) {
          lastError = error instanceof UsageError ? error : new UsageError('local_unreachable');
        }
      }
      throw lastError || new UsageError('local_unreachable');
    },
  };
}
