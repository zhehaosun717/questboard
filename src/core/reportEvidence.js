// Binds one dispatch attempt to the report it actually produced. Resolution only ever looks at the lane's own
// configured delivery/output directories plus the attempt's own worker name — never at a caller-supplied path.
// Reads are bounded and the digest is of the bytes actually read, so a too-large report is shown as truncated
// instead of pretending completeness. Nothing here decides a quest's status: a verdict is recorded, not obeyed,
// and it is only ever read from a final report file read in full — never from a truncated read or a `.out`
// transcript.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sameAttempt } from './store.js';

export const REPORT_READ_CAP = 2 * 1024 * 1024; // 2 MB per report; larger files are flagged truncated
export const SUMMARY_MAX = 400; // characters of the first heading/paragraph exposed to the UI and event detail
export const VERDICT_LINE_MAX = 200;
export const SUMMARY_VERDICT_REASON = '这是 worker 的运行记录（.out），不是最终报告，不能从里面读结论';

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*$/;
// Case-sensitive on purpose: only an exact uppercase `VERDICT:` line counts. Prose and templates that spell
// it differently are not this attempt's verdict — 'unknown' is the honest answer for them. The review
// template offers a third choice, `PASS WITH FINDINGS` (src/core/reviewRequest.js) — tried before the plain
// `PASS` alternative so it is never left as a `PASS` match with trailing text unconsumed.
const VERDICT_RE = /^\s{0,3}(?:#{1,6}\s+)?(?:(?:\*\*|__)\s*)?VERDICT\s*[:：]\s*(PASS WITH FINDINGS|PASS|FAIL)\s*(?:(?:\*\*|__)\s*)?$/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const INDENT_RE = /^(?: {4,}|\t)/;
const LIST_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

// CommonMark fence tracking. A fence opens with three or more backticks or tildes (a backtick fence's info
// string may not itself contain a backtick) and only closes with the SAME character and at least the SAME
// length — so a ``` block containing a ~~~ line, or a longer fence containing a shorter one, never closes
// early. Toggling on any marker (the round-1 behaviour) let exactly that block invert which VERDICT line
// looked genuine.
function fenceOpen(line) {
  const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  if (match[1][0] === '`' && match[2].includes('`')) return null;
  return { char: match[1][0], length: match[1].length };
}

function fenceClose(line, open) {
  const match = /^\s{0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(match) && match[1][0] === open.char && match[1].length >= open.length;
}

// Given the index of an opening fence line, the index just past its block — or lines.length when it never
// closes, because an unterminated fence runs to the end of the text like every other CommonMark reader.
function fenceBlockEnd(lines, start) {
  const open = fenceOpen(lines[start]);
  let i = start + 1;
  while (i < lines.length && !(open && fenceClose(lines[i], open))) i += 1;
  return i < lines.length ? i + 1 : i;
}

// The attempt a quest is currently about: the live assignee, or for a quest already settled (assignee cleared
// by failed/bounced) the last dispatch row. Both carry {name, lane, at, attemptId}.
export function attemptOf(quest) {
  if (!quest) return null;
  if (quest.assignee) return quest.assignee;
  const dispatches = quest.dispatches || [];
  return dispatches.length ? dispatches[dispatches.length - 1] : null;
}

function refOf(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

// A candidate must stay inside the project both lexically and after symlinks resolve, and must be a plain
// file. Anything else (missing, a directory, a symlink pointing out of the project) is refused.
function realFileWithin(root, laneDir, candidate) {
  const rootAbs = path.resolve(root);
  const laneAbs = path.resolve(laneDir);
  const resolved = path.resolve(candidate);
  const lexical = path.relative(laneAbs, resolved);
  if (lexical === '' || lexical.startsWith('..') || path.isAbsolute(lexical)) return { ok: false, reason: '报告文件不在 lane 自己的目录内' };
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) return { ok: false, reason: '报告文件是链接，不作为报告读取' };
  } catch {
    return { ok: false, reason: '报告文件不存在或不是普通文件' };
  }
  let realRoot;
  let realLane;
  let realFile;
  try {
    realRoot = fs.realpathSync(rootAbs);
    realLane = fs.realpathSync(laneAbs);
    realFile = fs.realpathSync(resolved);
  } catch {
    return { ok: false, reason: '报告文件不存在或不是普通文件' };
  }
  const laneRel = path.relative(realRoot, realLane);
  if (laneRel === '' || laneRel.startsWith('..') || path.isAbsolute(laneRel)) return { ok: false, reason: '报告目录不在项目内' };
  const realRel = path.relative(realLane, realFile);
  if (realRel === '' || realRel.startsWith('..') || path.isAbsolute(realRel)) return { ok: false, reason: '报告文件不在 lane 自己的目录内' };
  let stats;
  try {
    stats = fs.statSync(realFile);
  } catch {
    return { ok: false, reason: '报告文件不存在或不是普通文件' };
  }
  return stats.isFile() ? { ok: true, real: realFile } : { ok: false, reason: '报告文件不存在或不是普通文件' };
}

// Reads at most `cap` bytes from the start of the file. The digest and `bytes` describe exactly that slice;
// `sizeBytes` is the full file size, so `truncated` never hides how much was left out.
export function readBounded(file, cap = REPORT_READ_CAP) {
  const sizeBytes = fs.statSync(file).size;
  const truncated = sizeBytes > cap;
  const length = truncated ? cap : sizeBytes;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  let read = 0;
  try {
    while (read < length) {
      const chunk = fs.readSync(fd, buffer, read, length - read, read);
      if (chunk === 0) break;
      read += chunk;
    }
  } finally {
    fs.closeSync(fd);
  }
  const bytes = buffer.subarray(0, read);
  return {
    text: bytes.toString('utf8'),
    digest: createHash('sha256').update(bytes).digest('hex'),
    bytes: read,
    sizeBytes,
    truncated: truncated || read < sizeBytes,
  };
}

// Where a report for this attempt is allowed to live, in trust order: the lane's delivery file (what the
// board wrote for an API lane), the file lane's own exit report, then the worker's raw .out transcript.
function reportCandidates(config, attempt, only) {
  const lane = config.lanes ? config.lanes[attempt.lane] : null;
  const tries = [];
  if (!lane) return { lane: null, tries };
  if (lane.deliveryDir && (!only || only.has('delivery'))) {
    const dir = path.resolve(config.root, lane.deliveryDir);
    tries.push({ source: 'delivery', dir, file: path.join(dir, `${attempt.name}.md`) });
  }
  if (lane.outputDir && (!only || only.has('exit-file'))) {
    const dir = path.resolve(config.root, lane.outputDir);
    tries.push({ source: 'exit-file', dir, file: path.join(dir, `${attempt.name}.md`) });
  }
  if (lane.outputDir && (!only || only.has('summary'))) {
    const dir = path.resolve(config.root, lane.outputDir);
    tries.push({ source: 'summary', dir, file: path.join(dir, `${attempt.name}.out`) });
  }
  return { lane, tries };
}

// Resolves the current attempt's final report reference. Returns the reference metadata plus the bounded text
// when a readable candidate exists; source:'none' carries a reason naming what was looked for and why nothing
// was accepted. `only` restricts the search to a specific source set (used to re-read a stored reference).
export function resolveAttemptReport({ config, quest, only = null }) {
  const attempt = attemptOf(quest);
  const base = {
    attemptId: attempt?.attemptId || null,
    name: attempt?.name || null,
    lane: attempt?.lane || null,
    at: attempt?.at || null,
    capturedAt: new Date().toISOString(),
  };
  const empty = { ...base, source: 'none', ref: null, digest: null, bytes: 0, sizeBytes: 0, truncated: false };
  if (!attempt) return { ...empty, reason: '这个任务还没有派过单，没有可绑定的报告' };
  if (!NAME_OK.test(String(attempt.name || ''))) {
    return { ...empty, reason: `worker 名字 ${attempt.name} 不是一个安全的文件名，不敢用它拼报告路径` };
  }
  const { lane, tries } = reportCandidates(config, attempt, only);
  if (!lane) return { ...empty, reason: `找不到 lane ${attempt.lane} 的配置，无法确定报告目录` };
  if (!tries.length) return { ...empty, reason: `lane ${attempt.lane} 既没有交付目录也没有输出目录，没有地方可以找报告` };
  const notes = [];
  for (const { source, dir, file } of tries) {
    const checked = realFileWithin(config.root, dir, file);
    if (!checked.ok) {
      notes.push(`${refOf(config.root, file)}：${checked.reason}`);
      continue;
    }
    const real = checked.real;
    let read;
    try {
      read = readBounded(real);
    } catch (error) {
      notes.push(`读取 ${refOf(config.root, real)} 失败：${error.message}`);
      continue;
    }
    return {
      ...base,
      source,
      ref: refOf(config.root, real),
      digest: read.digest,
      bytes: read.bytes,
      sizeBytes: read.sizeBytes,
      truncated: read.truncated,
      text: read.text,
    };
  }
  return { ...empty, reason: `这次派遣没有留下可读的报告：${notes.join('；')}` };
}

// Finds the final genuine `VERDICT: PASS|FAIL` line: scans every line that is not inside a fenced code block
// (CommonMark fences only close with the same character and at least the same length), not a blockquote and
// not an indented code sample, and keeps the LAST exact verdict. Only the exact uppercase token counts;
// template lines that list alternatives are skipped; no genuine line means 'unknown'.
// The regex captures the exact literal on the line; only `PASS WITH FINDINGS` maps onto a different stored
// value than the token itself, so a verified 'findings' verdict shares its name with the web-only tail-parse
// fallback (web/src/lib/evidence.ts ReviewVerdict) instead of carrying three spaces.
function verdictValue(raw) {
  return raw === 'PASS WITH FINDINGS' ? 'findings' : raw;
}

export function extractVerdict(text, { source } = {}) {
  if (source === 'summary') return unknownWithReason(SUMMARY_VERDICT_REASON);
  if (typeof text !== 'string' || !text) return { verdict: 'unknown', line: null, position: null };
  const lines = text.split(/\r?\n/);
  const separators = text.match(/\r?\n/g) || [];
  let offset = 0;
  let fence = null;
  let found = null;
  for (const [index, line] of lines.entries()) {
    if (fence) {
      if (fenceClose(line, fence)) fence = null;
      offset += line.length + (separators[index]?.length || 0);
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      fence = open;
      offset += line.length + (separators[index]?.length || 0);
      continue;
    }
    if (!QUOTE_RE.test(line) && !INDENT_RE.test(line)) {
      const match = VERDICT_RE.exec(line);
      if (match) found = { verdict: verdictValue(match[1]), line: line.trim().slice(0, VERDICT_LINE_MAX), position: offset };
    }
    offset += line.length + (separators[index]?.length || 0);
  }
  return found || { verdict: 'unknown', line: null, position: null };
}

function clampToBoundary(text, max) {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max);
  const space = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'), head.lastIndexOf('\t'));
  if (space > max * 0.6) return { text: `${text.slice(0, space).trimEnd()}…`, cut: true };
  return { text: `${Array.from(text).slice(0, max).join('').trimEnd()}…`, cut: true };
}

// The first heading and the first complete paragraph (or first findings item) after it, kept on source line
// boundaries: lines are never re-joined mid-word, CRLF is tolerated, and a cut lands on whitespace (or a
// code-point boundary for a long CJK run) so nothing is chopped inside a surrogate pair.
export function summarizeReport(text, { max = SUMMARY_MAX } = {}) {
  if (typeof text !== 'string' || !text) return { heading: null, paragraph: null, hasMore: false };
  const lines = text.split(/\r?\n/);
  let heading = null;
  let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = HEADING_RE.exec(lines[i]);
    if (match) {
      heading = match[1].replace(/[*_`]+/g, '').trim().slice(0, VERDICT_LINE_MAX);
      cursor = i + 1;
      break;
    }
  }
  let start = -1;
  let end = -1;
  let i = cursor;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i += 1;
      continue;
    }
    if (fenceOpen(lines[i])) {
      i = fenceBlockEnd(lines, i);
      continue;
    }
    if (HR_RE.test(lines[i])) {
      i += 1;
      continue;
    }
    start = i;
    const list = LIST_RE.test(lines[i]);
    end = i;
    while (end + 1 < lines.length && lines[end + 1].trim()) {
      if (list && LIST_RE.test(lines[end + 1])) break;
      if (!list && fenceOpen(lines[end + 1])) break;
      end += 1;
    }
    break;
  }
  if (start === -1) return { heading, paragraph: null, hasMore: false };
  const joined = lines.slice(start, end + 1).map((line) => line.trimEnd()).join('\n');
  const clamped = clampToBoundary(joined, max);
  const rest = lines.slice(end + 1).some((line) => line.trim());
  return { heading, paragraph: clamped.text, hasMore: clamped.cut || rest };
}

// True when the stored reference describes the quest's CURRENT attempt. A same-name later attempt must never
// inherit the previous attempt's report: attempt ids are compared when either side has one.
export function reportMatchesAttempt(stored, attempt) {
  if (!stored || !attempt) return false;
  return sameAttempt(stored, attempt);
}

// B1/B2 (round 2): a verdict may only ever come from a final report file, read in full. A truncated read
// never reached the ending, and a `.out` is the worker's running transcript (echoed briefs and templates
// included) — both stay 'unknown' and say, in Chinese, exactly why there is no final verdict.
function unknownWithReason(reason) {
  return { verdict: 'unknown', line: null, position: null, reason };
}

// Captures what to store on the quest when this attempt reaches a terminal status. One bounded read, one
// digest, plus the verdict and summary. The verdict is gated as above; everything else is extracted from the
// full verified text (never from a tail).
export function captureAttemptReport({ config, quest }) {
  const { text, ...reference } = resolveAttemptReport({ config, quest });
  if (reference.source === 'none') return reference;
  let verdict;
  if (reference.truncated) {
    const cut = reference.sizeBytes > REPORT_READ_CAP
      ? `报告超过 2 MB，只读了前 ${reference.bytes} 字节`
      : `报告没有读完整（${reference.bytes} / ${reference.sizeBytes} 字节）`;
    verdict = unknownWithReason(`${cut}，没有读到结尾，给不出最终结论`);
  } else if (reference.source === 'summary') {
    verdict = unknownWithReason(SUMMARY_VERDICT_REASON);
  } else {
    verdict = extractVerdict(text);
  }
  return { ...reference, verdict, summary: summarizeReport(text) };
}

// Re-reads a stored reference for display. Refuses (with a Chinese reason) when the file is gone, moved, or no
// longer hashes to what was recorded — the caller shows uncertainty instead of guessing.
export function readCapturedReport(config, capture) {
  if (!capture || capture.source === 'none') {
    return { ok: false, code: 'none', reason: capture?.reason || '这次派遣没有留下报告引用' };
  }
  const attempt = { name: capture.name, lane: capture.lane, at: capture.at, attemptId: capture.attemptId };
  const resolved = resolveAttemptReport({ config, quest: { assignee: attempt }, only: new Set([capture.source]) });
  if (resolved.source === 'none') return { ok: false, code: 'gone', reason: resolved.reason };
  if (resolved.ref !== capture.ref || resolved.source !== capture.source) {
    return { ok: false, code: 'changed', reason: `报告引用的位置变了：记录里是 ${capture.ref}，现在是 ${resolved.ref}` };
  }
  if (resolved.digest !== capture.digest) {
    return { ok: false, code: 'changed', reason: '报告内容在记录之后被改过（内容摘要对不上），不敢当作同一份报告展示' };
  }
  return { ok: true, text: resolved.text, truncated: resolved.truncated, ref: resolved.ref, digest: resolved.digest, bytes: resolved.bytes, sizeBytes: resolved.sizeBytes };
}

// The stored reference for the quest's current attempt, or null for legacy quests and stale attempts alike.
export function questReportView(quest) {
  const stored = quest?.attemptReport;
  if (!stored) return null;
  return reportMatchesAttempt(stored, attemptOf(quest)) ? stored : null;
}

// The small, pruned shape the board snapshot and MCP detail may carry: reference and verdict only, never the
// report text, the summary or the internal reason. Null when there is nothing current to point at.
export function reportSnapshot(quest) {
  const view = questReportView(quest);
  if (!view || view.source === 'none') return null;
  return {
    source: view.source,
    ref: view.ref,
    digest: view.digest,
    bytes: view.bytes,
    sizeBytes: view.sizeBytes,
    truncated: view.truncated,
    capturedAt: view.capturedAt,
    attemptId: view.attemptId,
    verdict: view.verdict ? view.verdict.verdict : 'unknown',
    ...(view.verdict?.reason ? { verdictReason: view.verdict.reason } : {}),
  };
}
