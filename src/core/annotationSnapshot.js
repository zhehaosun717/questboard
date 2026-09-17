// Captures the current review annotations alongside an art dispatch. The capture is deliberately separate
// from reviewPages(): dispatch must fail closed on malformed input, and its output must be immutable per
// attempt rather than a live view of the annotation log.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_BRIEF_BYTES } from './briefs.js';
import { briefPathAllowed, packageIdPattern } from './patterns.js';
import { lexicalContainmentIssue, realpathContainmentIssue } from './config.js';

// Keep dispatch-time annotation reads bounded even when a page has accumulated a damaged or runaway log.
// This is intentionally documented and fixed, like MAX_BRIEF_BYTES: changing it changes what a dispatch can
// safely send to a worker.
export const MAX_ANNOTATION_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_ANNOTATION_ITEMS = 2000;
export const MAX_ANNOTATION_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const PAGE_PATTERN = /^[a-z0-9_-]{1,64}$/;
const ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MANIFEST_PATTERN = /<script[^>]*\bid="review-data"[^>]*>([\s\S]*?)<\/script>/;

export class AnnotationSnapshotError extends Error {
  constructor(message, code = 'annotation_snapshot') {
    super(message);
    this.name = 'AnnotationSnapshotError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new AnnotationSnapshotError(message, code);
}

function pagePath(config, page) {
  if (!PAGE_PATTERN.test(page)) fail(`评审页面编号 ${page || '（空）'} 不符合页面编号格式`, 'invalid_page');
  const file = path.join(config.paths.data, 'annotations', `${page}.jsonl`);
  if (fs.existsSync(config.paths.data)) {
    const issue = realpathContainmentIssue(config.paths.data, file);
    if (issue) fail(`评审页的批注记录不能用：${issue}`, 'annotation_log_containment');
  }
  return file;
}

function reviewRoot(config) {
  if (!config.reviewPages) fail('项目没有配置评审目录', 'review_pages_unconfigured');
  const root = config.reviewPages.dir;
  const lexical = lexicalContainmentIssue(config.root, root);
  if (lexical) fail(`评审目录不能用：${lexical}`, 'review_dir_containment');
  if (fs.existsSync(root)) {
    const issue = realpathContainmentIssue(config.root, root);
    if (issue) fail(`评审目录不能用：${issue}`, 'review_dir_containment');
  }
  return root;
}

function matchingReviewFiles(root, pattern) {
  const found = [];
  function walk(directory) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { fail(`评审目录读取失败：${error.code || error.message}`, 'review_dir_unreadable'); }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      pattern.lastIndex = 0;
      if (pattern.test(entry.name) && !entry.name.includes('_static')) {
        const issue = realpathContainmentIssue(root, file);
        if (issue) fail(`评审文件不能用：${issue}`, 'review_file_containment');
        found.push(file);
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return found.sort((a, b) => a.localeCompare(b));
}

function readManifest(file, root) {
  let stat;
  try { stat = fs.statSync(file); } catch (error) { fail(`评审文件读取失败：${error.code || error.message}`, 'review_file_unreadable'); }
  if (!stat.isFile()) fail(`评审文件不是文件：${path.relative(root, file)}`, 'review_file_unreadable');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { fail(`评审文件读取失败：${error.code || error.message}`, 'review_file_unreadable'); }
  const match = text.match(MANIFEST_PATTERN);
  if (!match) return null;
  try {
    const manifest = JSON.parse(match[1]);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    return { ...manifest, title: typeof manifest.title === 'string' ? manifest.title : path.relative(root, file).split(path.sep).join('/') };
  } catch {
    return null;
  }
}

// Resolves exactly one manifest page. A page id is never inferred from a filename or from recency.
export function resolveReviewPage(config, page) {
  const root = reviewRoot(config);
  if (!PAGE_PATTERN.test(page)) fail(`评审页面编号 ${page || '（空）'} 不符合页面编号格式`, 'invalid_page');
  const matches = [];
  for (const file of matchingReviewFiles(root, config.reviewPages.filePattern)) {
    const manifest = readManifest(file, root);
    if (manifest && manifest.page === page) matches.push({ file, manifest });
  }
  if (!matches.length) fail(`找不到编号为 ${page} 的评审页面`, 'review_page_missing');
  if (matches.length > 1) fail(`评审页面编号 ${page} 对应多个文件`, 'review_page_ambiguous');
  const match = matches[0];
  if (!PAGE_PATTERN.test(String(match.manifest.page))) fail(`评审页面编号 ${page} 不符合页面编号格式`, 'invalid_page');
  return {
    page,
    title: String(match.manifest.title || '').slice(0, 1000) || path.relative(root, match.file).split(path.sep).join('/'),
    file: match.file,
    manifest: match.manifest,
  };
}

function validateAnnotationItem(item, lineNumber, itemNumber) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`批注日志第 ${lineNumber} 行的第 ${itemNumber} 项格式错误`, 'annotation_log_malformed');
  if (typeof item.id !== 'string' || !item.id.length || item.id.length > 128 || /[\0\r\n]/u.test(item.id)) {
    fail(`批注日志第 ${lineNumber} 行的批注编号格式错误`, 'annotation_log_malformed');
  }
  if (item.note !== undefined && (typeof item.note !== 'string' || item.note.length > 4000)) fail(`批注日志第 ${lineNumber} 行的备注（note）格式不对`, 'annotation_log_malformed');
  if (item.verdict !== undefined && (typeof item.verdict !== 'string' || item.verdict.length > 100)) fail(`批注日志第 ${lineNumber} 行的结论（verdict）格式不对`, 'annotation_log_malformed');
  if (item.updatedAt !== undefined && (typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)))) {
    fail(`批注日志第 ${lineNumber} 行的更新时间（updatedAt）格式不对`, 'annotation_log_malformed');
  }
  return { id: item.id, verdict: item.verdict === undefined ? '' : item.verdict, note: item.note === undefined ? '' : item.note };
}

// Strictly folds the append log. Unlike the review progress view, dispatch cannot silently skip a malformed
// line: the worker must know whether it received the complete current annotation state.
export function foldAnnotations(config, page) {
  const file = pagePath(config, page);
  if (!fs.existsSync(file)) return [];
  let stat;
  try { stat = fs.statSync(file); } catch (error) { fail(`批注日志读取失败：${error.code || error.message}`, 'annotation_log_unreadable'); }
  if (stat.size > MAX_ANNOTATION_LOG_BYTES) fail(`批注日志过大（上限 ${MAX_ANNOTATION_LOG_BYTES} 字节）`, 'annotation_log_oversized');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { fail(`批注日志读取失败：${error.code || error.message}`, 'annotation_log_unreadable'); }
  const latest = new Map();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let record;
    try { record = JSON.parse(lines[index]); }
    catch { fail(`批注日志第 ${index + 1} 行不是有效 JSON`, 'annotation_log_malformed'); }
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.page !== 'string' || !PAGE_PATTERN.test(record.page) || !Array.isArray(record.items) || record.items.length > 500) {
      fail(`批注日志第 ${index + 1} 行格式错误`, 'annotation_log_malformed');
    }
    for (let itemIndex = 0; itemIndex < record.items.length; itemIndex += 1) {
      const item = validateAnnotationItem(record.items[itemIndex], index + 1, itemIndex + 1);
      if (record.page === page) latest.set(item.id, item);
    }
    if (latest.size > MAX_ANNOTATION_ITEMS) fail(`批注数量超过上限 ${MAX_ANNOTATION_ITEMS}`, 'annotation_log_oversized');
  }
  return [...latest.values()];
}

// Checked at the start of prepareAnnotationSnapshot, before assign: a dataDir that escapes the project, or a
// dispatch-briefs junction that resolves outside the data folder, would otherwise only be discovered by
// safeAttemptTarget after store.assign had already minted an attempt — settling it failed, but still leaving
// a failed dispatch row behind for something the filesystem or config already made impossible. The refusal
// names the offending path exactly as the config writes it and says what is wrong: a plain folder sitting
// outside the project is not a link and is never called one, while a link (junction or symlink) that
// redirects elsewhere is named as a link. A link to a missing target is reported as exactly that name+path
// before any containment comparison, because a target that does not exist has no real path to compare.
// Nothing here creates anything: a data folder or dispatch-briefs folder that simply does not exist yet is
// not an escape, just nothing to check yet, and is left for safeAttemptTarget to create when the write
// actually happens.
function linkState(target) {
  let stat;
  try { stat = fs.lstatSync(target); }
  catch { return 'missing'; }
  return stat.isSymbolicLink() ? 'link' : 'plain';
}

function linkResolves(target) {
  try { fs.statSync(target); return true; }
  catch { return false; }
}

function snapshotTargetContainmentIssue(config) {
  const data = config.paths.data;
  const dataLexical = lexicalContainmentIssue(config.root, data);
  const dataReal = realpathContainmentIssue(config.root, data);
  // Outside as written but inside by real path: only a link back into the project can do that, and the
  // snapshot reference would still record the ".." the config wrote (see writeAnnotationSnapshot), so it is
  // refused here, before an attempt exists, with the path as written.
  if (dataLexical && !dataReal) return `批注快照路径在项目之外：${data}`;
  if (dataLexical && dataReal) {
    return linkState(data) === 'link' ? `派遣数据目录里的联接点指向项目之外：${data}` : `派遣数据目录在项目之外：${data}`;
  }
  // Inside as written, outside by real path: a link redirects the data folder out of the project.
  if (dataReal) return `派遣数据目录里的联接点指向项目之外：${data}`;
  const dataKind = linkState(data);
  if (dataKind === 'missing') return null;
  if (dataKind === 'link' && !linkResolves(data)) return `派遣数据目录是一个指向不存在位置的联接点：${data}`;
  const briefsDir = path.join(data, 'dispatch-briefs');
  const briefsKind = linkState(briefsDir);
  if (briefsKind === 'missing') return null;
  if (briefsKind === 'link' && !linkResolves(briefsDir)) return `派遣简报目录是一个指向不存在位置的联接点：${briefsDir}`;
  const briefsIssue = realpathContainmentIssue(data, briefsDir);
  if (briefsIssue) {
    return briefsKind === 'link' ? `派遣数据目录里的联接点指向项目之外：${briefsDir}` : `派遣数据目录在项目之外：${briefsDir}`;
  }
  return null;
}

function quote(value) { return JSON.stringify(String(value)); }

function normalizeLineSeparators(value) {
  return String(value).replace(/\r\n?|\u2028|\u2029/g, '\n');
}

function fencedNote(note) {
  const normalized = normalizeLineSeparators(note);
  const runs = normalized.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}text\n${normalized}\n${fence}`.split('\n').map((line) => `  ${line}`).join('\n');
}

export function renderAnnotationSnapshot({ briefText, page, title, capturedAt, items }) {
  const prefix = String(briefText);
  const separator = prefix.endsWith('\n') ? '\n' : '\n\n';
  const rows = items.map((item, index) => [
    `- 批注 ${index + 1}（引用数据）：id=${quote(item.id)}；verdict=${quote(item.verdict)}；note：`,
    fencedNote(item.note),
  ].join('\n'));
  return `${prefix}${separator}## 当前批注快照\n\n`
    + `- 页面编号（引用数据）：${quote(page)}\n`
    + `- 页面标题（引用数据）：${quote(title)}\n`
    + `- 捕获时间（引用数据）：${quote(capturedAt)}\n`
    + `- 批注数量（引用数据）：${items.length}\n\n`
    + (rows.length ? `${rows.join('\n\n')}\n` : '（批注数量为 0；当前页面没有已保存批注。）\n');
}

// Shared by all immutable per-attempt artifacts. The suffix is deliberately allowlisted: callers may choose
// the annotation snapshot or role-card name, but may not turn this helper into an arbitrary file writer.
export function safeAttemptTarget(config, packageId, attemptId, suffix = '.md') {
  const packagePattern = packageIdPattern(config);
  if (!packagePattern.test(packageId)) fail(`委托编号 ${packageId} 不符合这个项目的编号规则`, 'invalid_package');
  if (!ATTEMPT_PATTERN.test(attemptId)) fail('这次派遣的编号格式不对', 'invalid_attempt');
  if (!['.md', '.role.md'].includes(suffix)) fail('内部错误：不支持的快照文件类型', 'snapshot_write_failed');
  const directory = path.join(config.paths.data, 'dispatch-briefs', packageId);
  const file = path.join(directory, `${packageId}-${attemptId}${suffix}`);
  const assertContainment = (target) => {
    const dataIssue = realpathContainmentIssue(config.paths.data, target);
    if (dataIssue) fail(`批注快照路径不能用：${dataIssue}`, 'snapshot_containment');
    const projectIssue = realpathContainmentIssue(config.root, target);
    if (projectIssue) fail(`批注快照路径在项目外：${projectIssue}`, 'snapshot_containment');
  };
  // The first role card for a fresh project may be the first artifact under data. Validate the data root
  // from the project before creating it, then the realpath checks below can safely inspect it.
  const dataRootIssue = realpathContainmentIssue(config.root, config.paths.data);
  if (dataRootIssue) fail(`派遣数据目录不能用：${dataRootIssue}`, 'snapshot_containment');
  try { fs.mkdirSync(config.paths.data, { recursive: true }); }
  catch (error) { fail(`派遣数据目录创建失败：${error.code || error.message}`, 'snapshot_write_failed'); }
  // Check before mkdir so an existing dispatch-briefs junction cannot create a package folder outside data.
  assertContainment(directory);
  try { fs.mkdirSync(directory, { recursive: true }); }
  catch (error) { fail(`批注快照目录创建失败：${error.code || error.message}`, 'snapshot_write_failed'); }
  const issue = realpathContainmentIssue(config.paths.data, file);
  if (issue) fail(`批注快照路径不能用：${issue}`, 'snapshot_containment');
  // Check again after mkdir in case a link appears during the filesystem operation.
  assertContainment(directory);
  assertContainment(file);
  return { directory, file };
}

// Exclusive create plus a full write and fsync. Item 39 uses this for annotation snapshots; role cards use
// the same primitive so a retry can never clobber the first bytes recorded for an attempt.
export function writeExclusiveFile(file, content) {
  let fd = null;
  let created = false;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    created = true;
    const buffer = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    fs.fsyncSync(fd);
  } catch (error) {
    if (created) { try { fs.unlinkSync(file); } catch { /* preserve the original failure */ } }
    throw error;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* the write result is already known */ } }
  }
}

export function writeAnnotationSnapshot({ config, packageId, attemptId, briefText, page, title, capturedAt = new Date().toISOString(), items, content: preparedContent }) {
  // prepareAnnotationSnapshot renders once before assign. The attempt id changes only the destination path,
  // so the size check cannot become a post-assign refusal. Direct callers still get the same bound when they
  // do not provide the prepared rendering.
  const content = typeof preparedContent === 'string'
    ? preparedContent : renderAnnotationSnapshot({ briefText, page, title, capturedAt, items });
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_ANNOTATION_SNAPSHOT_BYTES) fail(`批注快照过大（上限 ${MAX_ANNOTATION_SNAPSHOT_BYTES} 字节）`, 'snapshot_oversized');
  const target = safeAttemptTarget(config, packageId, attemptId);
  try {
    // writeExclusiveFile's wx is the immutable-attempt guard. A repeated attempt id can never replace the
    // first capture.
    writeExclusiveFile(target.file, content);
  } catch (error) {
    if (error.code === 'EEXIST') fail('这次派遣的批注快照已经存在，不会覆盖', 'snapshot_exists');
    fail(`批注快照写入失败：${error.code || error.message}`, 'snapshot_write_failed');
  }
  // safeAttemptTarget has already asserted containment of both target.directory and target.file (against the
  // data folder and the project root, both before and after the mkdir calls), but those checks compare real
  // paths: a data folder that is outside as written yet inside by real path (a junction planted back into
  // the project) passes every one of them, while the reference stored below still carries the ".." the
  // config wrote. That case is reachable — the pre-assign check refuses it on the dispatcher path, but a
  // direct caller, or a target swapped after the pre-check ran, still arrives here — so this check stays.
  const relative = path.relative(config.root, target.file).split(path.sep).join('/');
  if (relative === '..' || relative.startsWith('../')) fail('批注快照路径在项目之外', 'snapshot_containment');
  return { page, title, count: items.length, capturedAt, digest: createHash('sha256').update(content, 'utf8').digest('hex'), path: relative };
}

export function prepareAnnotationSnapshot({ config, quest }) {
  const targetIssue = snapshotTargetContainmentIssue(config);
  if (targetIssue) fail(targetIssue, 'snapshot_containment');
  const page = String(quest.reviewPage || '').trim();
  const resolved = resolveReviewPage(config, page);
  const brief = String(quest.brief || '').replaceAll('\\', '/');
  if (!briefPathAllowed(config, brief, 'art')) fail(`简报不在设置里的简报目录中：${brief}`, 'brief_containment');
  const absolute = path.join(config.root, brief);
  const briefDirectory = path.join(config.root, brief.slice(0, brief.lastIndexOf('/')));
  const containment = realpathContainmentIssue(briefDirectory, absolute);
  if (containment) fail(`简报文件不能用：${containment}`, 'brief_containment');
  let stat;
  try { stat = fs.statSync(absolute); } catch (error) { fail(`简报文件读取失败：${error.code || error.message}`, 'brief_unreadable'); }
  if (!stat.isFile()) fail(`简报文件不是文件：${brief}`, 'brief_unreadable');
  if (stat.size > MAX_BRIEF_BYTES) fail(`简报文件过大（上限 ${MAX_BRIEF_BYTES} 字节）`, 'brief_oversized');
  let briefText;
  try { briefText = fs.readFileSync(absolute, 'utf8'); } catch (error) { fail(`简报文件读取失败：${error.code || error.message}`, 'brief_unreadable'); }
  const items = foldAnnotations(config, page);
  const capturedAt = new Date().toISOString();
  const content = renderAnnotationSnapshot({ briefText, page, title: resolved.title, capturedAt, items });
  if (Buffer.byteLength(content, 'utf8') > MAX_ANNOTATION_SNAPSHOT_BYTES) {
    fail(`\u6279\u6ce8\u5feb\u7167\u8fc7\u5927\uff08\u4e0a\u9650 ${MAX_ANNOTATION_SNAPSHOT_BYTES} \u5b57\u8282\uff09`, 'snapshot_oversized');
  }
  return { page, title: resolved.title, capturedAt, items, briefText, content };
}
