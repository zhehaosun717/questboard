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
    if (issue) fail(`评审页面 ${page} 的批注日志不安全：${issue}`, 'annotation_log_containment');
  }
  return file;
}

function reviewRoot(config) {
  if (!config.reviewPages) fail('项目没有配置评审目录', 'review_pages_unconfigured');
  const root = config.reviewPages.dir;
  const lexical = lexicalContainmentIssue(config.root, root);
  if (lexical) fail(`评审目录不安全：${lexical}`, 'review_dir_containment');
  if (fs.existsSync(root)) {
    const issue = realpathContainmentIssue(config.root, root);
    if (issue) fail(`评审目录不安全：${issue}`, 'review_dir_containment');
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
        if (issue) fail(`评审文件不安全：${issue}`, 'review_file_containment');
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
  if (item.note !== undefined && (typeof item.note !== 'string' || item.note.length > 4000)) fail(`批注日志第 ${lineNumber} 行的 note 格式错误`, 'annotation_log_malformed');
  if (item.verdict !== undefined && (typeof item.verdict !== 'string' || item.verdict.length > 100)) fail(`批注日志第 ${lineNumber} 行的 verdict 格式错误`, 'annotation_log_malformed');
  if (item.updatedAt !== undefined && (typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)))) {
    fail(`批注日志第 ${lineNumber} 行的 updatedAt 格式错误`, 'annotation_log_malformed');
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
  if (!packagePattern.test(packageId)) fail(`任务编号 ${packageId} 不符合项目编号格式`, 'invalid_package');
  if (!ATTEMPT_PATTERN.test(attemptId)) fail(`派遣尝试编号不符合格式`, 'invalid_attempt');
  if (!['.md', '.role.md'].includes(suffix)) fail('不支持的派遣产物类型', 'snapshot_write_failed');
  const directory = path.join(config.paths.data, 'dispatch-briefs', packageId);
  const file = path.join(directory, `${packageId}-${attemptId}${suffix}`);
  const assertContainment = (target) => {
    const dataIssue = realpathContainmentIssue(config.paths.data, target);
    if (dataIssue) fail(`批注快照路径不安全：${dataIssue}`, 'snapshot_containment');
    const projectIssue = realpathContainmentIssue(config.root, target);
    if (projectIssue) fail(`批注快照路径在项目外：${projectIssue}`, 'snapshot_containment');
  };
  // The first role card for a fresh project may be the first artifact under data. Validate the data root
  // from the project before creating it, then the realpath checks below can safely inspect it.
  const dataRootIssue = realpathContainmentIssue(config.root, config.paths.data);
  if (dataRootIssue) fail(`派遣数据目录不安全：${dataRootIssue}`, 'snapshot_containment');
  try { fs.mkdirSync(config.paths.data, { recursive: true }); }
  catch (error) { fail(`派遣数据目录创建失败：${error.code || error.message}`, 'snapshot_write_failed'); }
  // Check before mkdir so an existing dispatch-briefs junction cannot create a package folder outside data.
  assertContainment(directory);
  try { fs.mkdirSync(directory, { recursive: true }); }
  catch (error) { fail(`批注快照目录创建失败：${error.code || error.message}`, 'snapshot_write_failed'); }
  const issue = realpathContainmentIssue(config.paths.data, file);
  if (issue) fail(`批注快照路径不安全：${issue}`, 'snapshot_containment');
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
    if (error.code === 'EEXIST') fail(`批注快照已经存在，不能覆盖这次派遣`, 'snapshot_exists');
    fail(`批注快照写入失败：${error.code || error.message}`, 'snapshot_write_failed');
  }
  const relative = path.relative(config.root, target.file).split(path.sep).join('/');
  if (relative === '..' || relative.startsWith('../')) fail('批注快照路径在项目之外', 'snapshot_containment');
  return { page, title, count: items.length, capturedAt, digest: createHash('sha256').update(content, 'utf8').digest('hex'), path: relative };
}

export function prepareAnnotationSnapshot({ config, quest }) {
  const page = String(quest.reviewPage || '').trim();
  const resolved = resolveReviewPage(config, page);
  const brief = String(quest.brief || '').replaceAll('\\', '/');
  if (!briefPathAllowed(config, brief, 'art')) fail(`brief 文件不在配置的派遣目录中：${brief}`, 'brief_containment');
  const absolute = path.join(config.root, brief);
  const briefDirectory = path.join(config.root, brief.slice(0, brief.lastIndexOf('/')));
  const containment = realpathContainmentIssue(briefDirectory, absolute);
  if (containment) fail(`brief 文件不安全：${containment}`, 'brief_containment');
  let stat;
  try { stat = fs.statSync(absolute); } catch (error) { fail(`brief 文件读取失败：${error.code || error.message}`, 'brief_unreadable'); }
  if (!stat.isFile()) fail(`brief 文件不是文件：${brief}`, 'brief_unreadable');
  if (stat.size > MAX_BRIEF_BYTES) fail(`brief 文件过大（上限 ${MAX_BRIEF_BYTES} 字节）`, 'brief_oversized');
  let briefText;
  try { briefText = fs.readFileSync(absolute, 'utf8'); } catch (error) { fail(`brief 文件读取失败：${error.code || error.message}`, 'brief_unreadable'); }
  const items = foldAnnotations(config, page);
  const capturedAt = new Date().toISOString();
  const content = renderAnnotationSnapshot({ briefText, page, title: resolved.title, capturedAt, items });
  if (Buffer.byteLength(content, 'utf8') > MAX_ANNOTATION_SNAPSHOT_BYTES) {
    fail(`\u6279\u6ce8\u5feb\u7167\u8fc7\u5927\uff08\u4e0a\u9650 ${MAX_ANNOTATION_SNAPSHOT_BYTES} \u5b57\u8282\uff09`, 'snapshot_oversized');
  }
  return { page, title: resolved.title, capturedAt, items, briefText, content };
}
