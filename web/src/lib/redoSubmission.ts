import type { Quest } from '../api/types';
import { STATUS } from './labels';

// Fixed Chinese for everything the redo dialog refuses. Same rules as threadBatch (R5-5): both the
// field errors and the top-level message arrive as untrusted runtime data, so the server's own text is
// never rendered — only fixed strings keyed by allowlisted field names and known message prefixes.

export type RedoFieldName =
  | 'package'
  | 'brief'
  | 'kind'
  | 'reviewPage'
  | 'parents'
  | 'conflicts'
  | 'allowedLanes'
  | 'priority';

export type RedoFieldErrors = Partial<Record<RedoFieldName, string>>;

const REDO_FIELD_ORDER: RedoFieldName[] = [
  'package',
  'brief',
  'kind',
  'reviewPage',
  'parents',
  'conflicts',
  'allowedLanes',
  'priority',
];

export const REDO_FIELD_LABELS: Record<RedoFieldName, string> = {
  package: '委托编号',
  brief: '简报路径',
  kind: '类型',
  reviewPage: '评审页',
  parents: '前置委托',
  conflicts: '不能同时做',
  allowedLanes: '限定通道',
  priority: '优先级',
};

export const GENERIC_FIELD_ERROR_ZH = '这里填写的内容有误，请检查后重试。';

function describeField(name: RedoFieldName, message: string): string {
  const text = message.trim();
  // Feedback 11 round 3 (L3): the server attaches the worker-held message to several fields
  // (title/brief/parents/conflicts/allowedLanes as well as package), so it maps for any field.
  if (text.includes('有 worker 占着')) {
    return '这个委托还有 worker 占着，先确认它已停止并释放，再重新提交。';
  }
  if (name === 'package') {
    if (text.startsWith('package must match')) {
      // Feedback 11 round 3 (N1): the id pattern is per project (config.briefs.packagePattern), so the
      // advice must stay pattern-neutral and suggest an id the default project accepts.
      return '委托编号不符合这个项目的编号规则，请照简报文件名开头的编号来写（例如 ART-REDO-1）。';
    }
    if (text.includes('is running; cancel it')) {
      return '这个委托还有 worker 在跑，先取消它再重新提交。';
    }
  }
  if (name === 'brief') {
    if (text === 'brief is required') return '请填写简报路径。';
    if (text.startsWith('brief must be')) {
      const marker = 'one of ';
      const idx = text.indexOf(marker);
      const dirs = idx !== -1 ? text.slice(idx + marker.length).trim() : '';
      if (dirs.length > 0) {
        return `简报要放在这些目录里，文件名以 .md 结尾：${dirs}`;
      }
      return '简报路径不在这个项目允许的简报目录里。';
    }
  }
  if (name === 'kind' && text.startsWith('kind must be one of')) {
    return '类型只能是美术。';
  }
  if (name === 'parents' && text.startsWith('parents must be package ids')) {
    return '前置委托里出现了不是委托编号的内容。';
  }
  if (name === 'conflicts' && text.startsWith('conflicts must be package ids')) {
    return '「不能同时做」里出现了不是委托编号的内容。';
  }
  if (name === 'allowedLanes' && text.startsWith('unknown lane')) {
    return '这个通道不在项目设置里。';
  }
  if (name === 'priority' && text === 'priority must be 1, 2 or 3') {
    return '优先级只能是 1、2 或 3。';
  }
  return GENERIC_FIELD_ERROR_ZH;
}

export function describeRedoFieldErrors(fields: unknown): RedoFieldErrors {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return {};
  const record = fields as Record<string, unknown>;
  const result: RedoFieldErrors = {};
  for (const name of REDO_FIELD_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) continue;
    const value = record[name];
    if (typeof value !== 'string') {
      result[name] = GENERIC_FIELD_ERROR_ZH;
      continue;
    }
    if (value.trim().length === 0) continue;
    result[name] = describeField(name, value);
  }
  return result;
}

const HTTP_STATUS_RE = /^HTTP \d{3}$/;

export function describeRedoProblem(input: { message?: string; status?: number }): string {
  const message = (input.message ?? '').trim();
  if (input.status === 404 || message === 'not found' || message === 'HTTP 404') {
    return '看板服务没有这个接口（可能是旧版本），无法发起重做。';
  }
  if (message === 'validation failed') return '填写内容有误，请检查后再试。';
  if (HTTP_STATUS_RE.test(message)) return `看板服务返回了错误：${message}。`;
  if (message.startsWith('cross-site request refused')) {
    return '跨站请求被拒绝：只有本机打开的看板页面能写入。';
  }
  if (message.startsWith('origin ') && message.endsWith(' refused')) {
    return '该来源被拒绝：只有本机打开的看板页面能写入。';
  }
  return '服务器拒绝了这次提交，请检查后再试。';
}

// F1: POST /api/quests is an upsert for any existing package nobody holds, so a typed id that is
// already on the board would silently rewrite that quest. The dialog refuses those ids outright.
export function findQuestByPackage(quests: readonly Quest[] | undefined, packageId: string): Quest | null {
  const id = packageId.trim();
  if (id.length === 0 || !quests) return null;
  return quests.find((quest) => quest.id === id) ?? null;
}

export function describeExistingPackageRefusal(quest: Quest): string {
  const status = STATUS[quest.status] ?? '未知状态';
  return `这个编号已经在看板上（状态：${status}），继续提交会覆盖它原来的内容。请换一个新编号再提交。`;
}
