// Suggestion S2: structured, attempt-bound evidence for a quest's CURRENT dispatch attempt — what the
// worker itself reported, what the project's own verification strip showed, and any verification hook run.
// Each item names whether it actually belongs to this attempt (`bound`); a record left over from an earlier
// attempt is never dropped silently, and it is never styled as if it passed. Nothing here executes a command,
// reads outside the directories the project already configured, or changes a quest's status — this is a
// read-only view over evidence other code already produced.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { attemptOf, questReportView } from './reportEvidence.js';

export const EVIDENCE_VERSION = 1;

const HOOK_STATES = new Set(['queued', 'running', 'passed', 'failed', 'timedout', 'unknown']);
const HOOK_FIELDS = new Set(['state', 'commandRef', 'startedAt', 'endedAt', 'exitCode', 'logPath', 'logDigest', 'attemptId']);
const STALE_REASON = '这是上一次尝试之前的记录，不算本次证据';
const NEVER_DISPATCHED_REASON = '还没有派遣，无法绑定';
const DIGEST_RE = /^[0-9a-f]{16,128}$/i;

function baseItem(kind, label, attempt, extra) {
  return {
    kind, label, source: null, ref: null, digest: null, capturedAt: null,
    attemptId: attempt?.attemptId || null, bound: false, ...extra,
  };
}

// report item: the current attempt's own captured reference (source, ref, digest, capturedAt), read through
// reportEvidence.js so the anti-inheritance rule (a stale attempt's report never counts for this one) lives
// in exactly one place. The verdict already gone through capture-time gating (a truncated read or a `.out`
// transcript is 'unknown' with a reason) becomes this item's state.
function reportItem(quest, attempt) {
  const view = questReportView(quest);
  if (!view || view.source === 'none') {
    return baseItem('report', '工作者报告', attempt, { state: 'missing', reason: '没有本次尝试的报告' });
  }
  const raw = view.verdict ? view.verdict.verdict : 'unknown';
  const state = raw === 'PASS' ? 'passed' : raw === 'FAIL' ? 'failed' : raw === 'findings' ? 'findings' : 'unknown';
  return {
    kind: 'report', label: '工作者报告', state,
    source: view.source, ref: view.ref, digest: view.digest, capturedAt: view.capturedAt,
    attemptId: view.attemptId || null, bound: true,
    ...(view.verdict?.reason ? { reason: view.verdict.reason } : {}),
  };
}

function digestOf(file) {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

// A NUnit total only decides the state when its own file is at least as new as the attempt — an edit.xml or
// play.xml left over from an earlier run must never fail the current attempt just because progress.txt was
// refreshed beside it. `attemptAtMs` not being a finite time (no attempt at all) means nothing can be shown
// fresh, so it is treated as stale rather than trusted.
function nunitFresh(dir, filename, attemptAtMs) {
  if (!Number.isFinite(attemptAtMs)) return false;
  try { return fs.statSync(path.join(dir, filename)).mtimeMs >= attemptAtMs; } catch { return false; }
}

// project-verification item: the newest progress.txt among config.verification.progressDirs (src/lanes/
// progress.js latestProgress, already collected by the caller — never re-scanned here). Bound only when the
// file is at least as new as the current attempt's own dispatch time AND this attempt is the project-wide
// latest dispatch (`latestDispatchAt`, the caller's own max over every quest's current attempt) — progress.txt
// is shared by the whole project, so a run made for a later dispatch of ANOTHER quest must never count as this
// quest's own evidence just because it is newer than this quest's (older) attempt. An attempt-less quest
// (nothing to bind against yet) is honestly unbound too, not styled as current.
function verificationItem(config, attempt, verification, latestDispatchAt) {
  const dirs = config.verification?.progressDirs;
  if (!dirs || !dirs.length) {
    return baseItem('project-verification', '项目验证记录', attempt, { state: 'not_configured', reason: '项目没有配置验证目录' });
  }
  if (!verification) {
    return baseItem('project-verification', '项目验证记录', attempt, { state: 'missing', reason: '在配置的目录里没有找到验证记录文件' });
  }
  const file = path.join(verification.dir, 'progress.txt');
  const ref = path.relative(config.root, file).split(path.sep).join('/');
  const attemptAtMs = attempt?.at ? Date.parse(attempt.at) : NaN;
  const isLatest = !Number.isFinite(latestDispatchAt) || attemptAtMs >= latestDispatchAt;
  const bound = Boolean(attempt) && Number.isFinite(attemptAtMs) && verification.mtime >= attemptAtMs && isLatest;
  const failedStep = (verification.steps || []).some((step) => (
    (step.kind === 'exit' && step.value.trim() !== '0' && step.value.trim() !== '')
    || (step.kind === 'errorCS' && Number(step.value) > 0)
  ));
  const editFresh = verification.editXml && nunitFresh(verification.dir, 'edit.xml', attemptAtMs);
  const playFresh = verification.playXml && nunitFresh(verification.dir, 'play.xml', attemptAtMs);
  const failedTests = (editFresh && verification.editXml.failed > 0) || (playFresh && verification.playXml.failed > 0);
  const state = failedStep || failedTests ? 'failed' : verification.done ? 'passed' : 'unknown';
  return {
    kind: 'project-verification', label: '项目验证记录', state,
    source: 'progress-strip', ref, digest: digestOf(file), capturedAt: new Date(verification.mtime).toISOString(),
    attemptId: attempt?.attemptId || null, bound,
    ...(bound ? {} : { reason: attempt ? STALE_REASON : NEVER_DISPATCHED_REASON }),
  };
}

// A hook record must stay inside the whitelisted fields and its logPath, if any, must be a relative path that
// resolves inside the project's own data directory — never absolute, never escaping with `..`. This is the
// only guard standing between a future hook writer and smuggling raw stdout or an outside path into what the
// UI shows as a short reference; both are refused as an 'unknown' item rather than trusted as-is.
function withinDataDir(config, relPath) {
  // A colon rejects both a drive-relative Windows path (`C:x.log`, which `path.isAbsolute` does NOT consider
  // absolute — it still resolves inside the data dir lexically) and an NTFS alternate-data-stream path; no
  // legitimate relative logPath needs one.
  if (typeof relPath !== 'string' || !relPath || path.isAbsolute(relPath) || relPath.includes(':')) return false;
  const resolved = path.resolve(config.paths.data, relPath);
  const rel = path.relative(config.paths.data, resolved);
  return rel !== '' && rel !== '.' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function validHook(config, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (!Object.keys(record).every((key) => HOOK_FIELDS.has(key))) return false;
  if (!HOOK_STATES.has(record.state)) return false;
  if (typeof record.commandRef !== 'string' || !record.commandRef.trim() || record.commandRef.length > 300 || /[\r\n]/.test(record.commandRef)) return false;
  for (const field of ['startedAt', 'endedAt']) {
    const value = record[field];
    if (value !== null && value !== undefined && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) return false;
  }
  if (record.exitCode !== null && record.exitCode !== undefined && !Number.isInteger(record.exitCode)) return false;
  if (record.logPath !== null && record.logPath !== undefined) {
    if (typeof record.logPath !== 'string' || !withinDataDir(config, record.logPath)) return false;
  }
  if (record.logDigest !== null && record.logDigest !== undefined) {
    if (typeof record.logDigest !== 'string' || !DIGEST_RE.test(record.logDigest)) return false;
  }
  if (record.attemptId !== null && record.attemptId !== undefined && typeof record.attemptId !== 'string') return false;
  return true;
}

// hook item: a reserved slot (S1 owns the producer). No producer exists today, so this is 'not_configured'
// for every real project; the validation above exists so a future writer is held to the same "reference plus
// hash, never the transcript itself" rule the report item already follows.
function hookItem(config, attempt) {
  const hooks = Array.isArray(attempt?.hooks) ? attempt.hooks : null;
  if (!hooks || !hooks.length) {
    return baseItem('hook', '验证钩子', attempt, { state: 'not_configured', reason: '项目没有启用验证钩子' });
  }
  const record = hooks[hooks.length - 1];
  if (!validHook(config, record)) {
    return baseItem('hook', '验证钩子', attempt, { state: 'unknown', reason: '钩子记录的格式不对，无法展示' });
  }
  const bound = Boolean(attempt?.attemptId) && record.attemptId === attempt.attemptId;
  return {
    kind: 'hook', label: '验证钩子', state: record.state,
    source: record.commandRef, ref: record.logPath ?? null, digest: record.logDigest ?? null,
    capturedAt: record.endedAt ?? record.startedAt ?? null,
    attemptId: attempt?.attemptId || null, bound,
    commandRef: record.commandRef, startedAt: record.startedAt ?? null, endedAt: record.endedAt ?? null,
    exitCode: record.exitCode ?? null, logPath: record.logPath ?? null, logDigest: record.logDigest ?? null,
    ...(bound ? {} : { reason: '这是上一次尝试的钩子记录，不算本次证据' }),
  };
}

// The quest's current-attempt evidence, ordered report, project-verification, hook (requirement 1). `now` is
// accepted for signature symmetry with the rest of the read-only evidence surfaces (see src/lanes/workers.js
// workerState) and future time-based staleness checks; nothing here depends on it yet. `latestDispatchAt` is
// the project-wide latest dispatch time (ms epoch), computed by the caller over every quest's current attempt
// (never re-derived here) — see F2: it gates whether project-verification may bind at all.
export function questEvidence({ config, quest, verification = null, now = Date.now(), latestDispatchAt = null }) {
  void now;
  const attempt = attemptOf(quest);
  return {
    version: EVIDENCE_VERSION,
    attemptId: attempt?.attemptId || null,
    attemptAt: attempt?.at || null,
    attemptName: attempt?.name || null,
    items: [reportItem(quest, attempt), verificationItem(config, attempt, verification, latestDispatchAt), hookItem(config, attempt)],
  };
}
