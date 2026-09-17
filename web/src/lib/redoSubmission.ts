import type { Quest } from '../api/types';
import { STATUS } from './labels';
import { t } from './i18n';

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
  get package() { return t('redo.field.package'); },
  get brief() { return t('redo.field.brief'); },
  get kind() { return t('redo.field.kind'); },
  get reviewPage() { return t('redo.field.reviewPage'); },
  get parents() { return t('redo.field.parents'); },
  get conflicts() { return t('redo.field.conflicts'); },
  get allowedLanes() { return t('redo.field.allowedLanes'); },
  get priority() { return t('redo.field.priority'); },
};

export const GENERIC_FIELD_ERROR_ZH = '这里填写的内容有误，请检查后重试。';

function genericFieldError(): string {
  return t('redo.genericFieldError');
}

function describeField(name: RedoFieldName, message: string): string {
  const text = message.trim();
  // Feedback 11 round 3 (L3): the server attaches the worker-held message to several fields
  // (title/brief/parents/conflicts/allowedLanes as well as package), so it maps for any field.
  if (text.includes('有 worker 占着')) {
    return t('redo.workerHeld');
  }
  if (name === 'package') {
    if (text.startsWith('package must match')) {
      // Feedback 11 round 3 (N1): the id pattern is per project (config.briefs.packagePattern), so the
      // advice must stay pattern-neutral and suggest an id the default project accepts.
      return t('redo.packagePatternError');
    }
    if (text.includes('is running; cancel it')) {
      return t('redo.packageRunning');
    }
  }
  if (name === 'brief') {
    if (text === 'brief is required') return t('redo.briefRequired');
    if (text.startsWith('brief must be')) {
      const marker = 'one of ';
      const idx = text.indexOf(marker);
      const dirs = idx !== -1 ? text.slice(idx + marker.length).trim() : '';
      if (dirs.length > 0) {
        return t('redo.briefDirs', { dirs });
      }
      return t('redo.briefNotAllowed');
    }
  }
  if (name === 'kind' && text.startsWith('kind must be one of')) {
    return t('redo.kindArtOnly');
  }
  if (name === 'parents' && text.startsWith('parents must be package ids')) {
    return t('redo.parentsInvalid');
  }
  if (name === 'conflicts' && text.startsWith('conflicts must be package ids')) {
    return t('redo.conflictsInvalid');
  }
  if (name === 'allowedLanes' && text.startsWith('unknown lane')) {
    return t('redo.laneUnknown');
  }
  if (name === 'priority' && text === 'priority must be 1, 2 or 3') {
    return t('redo.priorityInvalid');
  }
  return genericFieldError();
}

export function describeRedoFieldErrors(fields: unknown): RedoFieldErrors {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return {};
  const record = fields as Record<string, unknown>;
  const result: RedoFieldErrors = {};
  for (const name of REDO_FIELD_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) continue;
    const value = record[name];
    if (typeof value !== 'string') {
      result[name] = genericFieldError();
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
    return t('redo.notFound');
  }
  if (message === 'validation failed') return t('redo.validationFailed');
  if (HTTP_STATUS_RE.test(message)) return t('redo.httpError', { message });
  if (message.startsWith('cross-site request refused')) {
    return t('redo.crossSiteRefused');
  }
  if (message.startsWith('origin ') && message.endsWith(' refused')) {
    return t('redo.originRefused');
  }
  return t('redo.submitRefused');
}

// F1: POST /api/quests is an upsert for any existing package nobody holds, so a typed id that is
// already on the board would silently rewrite that quest. The dialog refuses those ids outright.
export function findQuestByPackage(quests: readonly Quest[] | undefined, packageId: string): Quest | null {
  const id = packageId.trim();
  if (id.length === 0 || !quests) return null;
  return quests.find((quest) => quest.id === id) ?? null;
}

export function describeExistingPackageRefusal(quest: Quest): string {
  const status = STATUS[quest.status] ?? t('redo.unknownStatus');
  return t('redo.existingPackage', { status });
}
