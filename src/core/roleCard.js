// Immutable per-attempt worker identity. The role card is deliberately a small, readable artifact: it keeps
// the package boundary and brief digest beside the canonical brief without putting the card text into argv or
// an environment variable.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_BRIEF_BYTES, briefUsable, briefUnusableInfo } from './briefs.js';
import { lexicalContainmentIssue, realpathContainmentIssue } from './config.js';
import { safeAttemptTarget, writeExclusiveFile } from './annotationSnapshot.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export class RoleCardError extends Error {
  constructor(message, code = 'role_card') {
    super(message);
    this.name = 'RoleCardError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new RoleCardError(message, code);
}

function relative(root, file) {
  const value = path.relative(root, file).split(path.sep).join('/');
  if (value === '..' || value.startsWith('../')) fail('角色卡路径在项目之外', 'role_card_containment');
  return value;
}

function readCanonicalBrief(config, quest) {
  const briefPath = String(quest.brief || '').trim().replaceAll('\\', '/');
  if (!briefPath || !briefUsable(config, briefPath)) {
    const unusable = briefUnusableInfo(config, briefPath);
    fail(unusable ? `简报文件不可用：${unusable.reason}` : `找不到简报文件：${briefPath || '（未填写）'}`, unusable ? 'brief_unusable' : 'brief_missing');
  }
  const absolute = path.resolve(config.root, briefPath);
  const lexical = lexicalContainmentIssue(config.root, absolute);
  if (lexical) fail(`简报在项目之外：${lexical}`, 'brief_containment');
  const issue = realpathContainmentIssue(config.root, absolute);
  if (issue) fail(`简报不能安全读取：${issue}`, 'brief_containment');
  let stat;
  try { stat = fs.statSync(absolute); } catch (error) { fail(`无法读取简报：${error.code || error.message}`, 'brief_unreadable'); }
  if (!stat.isFile()) fail(`简报不是文件：${briefPath}`, 'brief_unreadable');
  if (stat.size > MAX_BRIEF_BYTES) fail(`简报超过 ${MAX_BRIEF_BYTES} 字节上限`, 'brief_oversized');
  let bytes;
  try { bytes = fs.readFileSync(absolute); } catch (error) { fail(`无法读取简报：${error.code || error.message}`, 'brief_unreadable'); }
  return { path: briefPath, digest: createHash('sha256').update(bytes).digest('hex') };
}

function reportPathFor(config, attempt) {
  const lane = config.lanes && config.lanes[attempt.lane];
  const directory = lane && (lane.deliveryDir || lane.outputDir);
  return directory ? path.join(directory, `${attempt.name}.md`).split(path.sep).join('/') : null;
}

export function renderRoleCard({ packageId, kind, workerName, attemptId, at, lane, briefPath, briefDigest, reportPath }) {
  const destination = reportPath || '未配置报告位置';
  const statement = `你是委托 ${packageId} 的 worker。只按简报改文件，不改别的文件，不提交，不读其他 worker 的交差文件；完成后把报告写到 ${destination}。`;
  return [
    '# Role card',
    '',
    `- package: ${packageId}`,
    `- kind: ${kind}`,
    `- worker: ${workerName}`,
    `- attempt: ${attemptId}`,
    `- dispatched at: ${at}`,
    `- lane: ${lane}`,
    `- canonical brief: ${briefPath}`,
    `- brief SHA-256: ${briefDigest}`,
    `- report: ${destination}`,
    '',
    '## 角色说明',
    '',
    statement,
    '',
  ].join('\n');
}

export function validateRoleCard(config, questId, attemptId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('roleCard 必须是对象');
  if (typeof value.path !== 'string' || !value.path.trim() || value.path.includes('\0') || path.isAbsolute(value.path)) {
    throw new Error('roleCard.path 必须是相对路径');
  }
  if (typeof value.digest !== 'string' || !DIGEST_PATTERN.test(value.digest)) throw new Error('roleCard.digest 必须是 SHA-256 十六进制摘要');
  const expected = path.join(config.paths.data, 'dispatch-briefs', questId, `${questId}-${attemptId}.role.md`);
  const absolute = path.resolve(config.root, value.path);
  const normalized = (item) => process.platform === 'win32' ? item.toLowerCase() : item;
  if (normalized(absolute) !== normalized(expected)) throw new Error('roleCard.path 必须指向本次尝试的角色卡');
  if (realpathContainmentIssue(config.root, absolute)) throw new Error('roleCard.path 必须位于项目内');
  if (realpathContainmentIssue(config.paths.data, absolute)) throw new Error('roleCard.path 必须位于派遣数据目录内');
  return { path: value.path, digest: value.digest };
}

export function writeRoleCard({ config, quest, attempt }) {
  const brief = readCanonicalBrief(config, quest);
  const reportPath = reportPathFor(config, attempt);
  const content = renderRoleCard({
    packageId: quest.id,
    kind: quest.kind,
    workerName: attempt.name,
    attemptId: attempt.attemptId,
    at: attempt.at,
    lane: attempt.lane,
    briefPath: brief.path,
    briefDigest: brief.digest,
    reportPath,
  });
  const target = safeAttemptTarget(config, quest.id, attempt.attemptId, '.role.md');
  try {
    writeExclusiveFile(target.file, content);
  } catch (error) {
    if (error.code === 'EEXIST') fail('这次派遣的角色卡已经存在，不会覆盖', 'role_card_exists');
    fail(`角色卡写入失败：${error.code || error.message}`, 'role_card_write_failed');
  }
  return { path: relative(config.root, target.file), digest: createHash('sha256').update(content, 'utf8').digest('hex') };
}

export function readRoleCard(config, rolePath) {
  const absolute = path.resolve(config.root, rolePath);
  if (path.isAbsolute(rolePath) || realpathContainmentIssue(config.root, absolute)) throw new Error('角色卡路径不在项目内');
  try { return fs.readFileSync(absolute, 'utf8'); }
  catch (error) { throw new Error(`无法读取角色卡：${error.code || error.message}`); }
}
