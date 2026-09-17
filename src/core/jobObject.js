// A process-local client for the Job Object helper daemon (jobObject.ps1). The daemon owns the job
// handles for its lifetime, so a job stays owned even while the board is between cancellation polls.
// Every operation is a single JSON line in and one JSON line out, with a bounded timeout.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DAEMON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jobObject.ps1');
const OP_TIMEOUT_MS = 15000;

let daemon = null;
let pending = new Map();
let nextSeq = 1;
let buffered = '';

function sendDaemon(op, payload = {}) {
  if (!daemon || daemon.exited) throw new Error('job daemon is not running');
  return new Promise((resolve, reject) => {
    const seq = nextSeq++;
    const timer = setTimeout(() => {
      pending.delete(seq);
      reject(new Error(`job daemon timed out: ${op}`));
    }, OP_TIMEOUT_MS);
    timer.unref?.();
    pending.set(seq, { resolve, reject, timer });
    daemon.stdin.write(`${JSON.stringify({ seq, op, ...payload })}\n`);
  });
}

function handleLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const entry = pending.get(message.seq);
  if (!entry) return;
  pending.delete(message.seq);
  clearTimeout(entry.timer);
  if (message.ok) entry.resolve(message);
  else entry.reject(new Error(message.error || 'job daemon operation failed'));
}

export function startJobDaemon() {
  if (daemon && !daemon.exited) return daemon;
  daemon = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DAEMON_PATH], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  buffered = '';
  daemon.stdout.on('data', (chunk) => {
    buffered += String(chunk);
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) handleLine(line);
  });
  daemon.stderr.resume();
  daemon.on('error', () => {});
  daemon.on('exit', () => {
    daemon.exited = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('job daemon exited'));
    }
    pending.clear();
  });
  return daemon;
}

export function stopJobDaemon() {
  if (daemon && !daemon.exited) {
    try { daemon.stdin.write('{"op":"quit"}\n'); } catch {}
    setTimeout(() => { try { daemon?.kill(); } catch {} }, 1000).unref?.();
  }
}

export async function createJobObject(name) {
  startJobDaemon();
  const result = await sendDaemon('create', { name });
  return result.id;
}

export async function assignJobObject(jobId, pid) {
  await sendDaemon('assign', { id: jobId, pid });
}

export async function terminateJobObject(jobId) {
  await sendDaemon('terminate', { id: jobId });
}

export async function countJobObject(jobId) {
  const result = await sendDaemon('count', { id: jobId });
  return result.active;
}

export async function closeJobObject(jobId) {
  await sendDaemon('close', { id: jobId });
}