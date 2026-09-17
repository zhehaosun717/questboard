// Batch operations for machine-roster facts. The roster is deliberately kept separate from the status log:
// this module may change a card's facts or append a status record, but it never writes status into roster.json.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { loadRosterOrEmpty, saveRoster, validateAdventurer, validateCardEnv, validateRoster } from './roster.js';
import { foldStatuses, validateStatusRecord } from './status.js';
import { holdsSlot } from './rules.js';

export const MAX_BULK_IDS = 100;
export const BULK_STATUSES = Object.freeze(['available', 'limited', 'paused']);

const ID_PATTERN = /^[a-z0-9-]{1,48}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_VARIANT = 200;
const FACT_FIELDS = Object.freeze([
  'id', 'name', 'provider', 'lane', 'model', 'family', 'variant', 'agent', 'billing', 'maxParallel', 'strengths', 'notes', 'env',
]);
const PATCH_FIELDS = new Set(['action', 'delete', 'status', 'reason', 'variant', 'env', 'removeEnv', 'envRemove']);
const REQUEST_FIELDS = new Set(['ids', 'patch', 'changes', 'revision', 'fingerprint', 'ifRevision', 'actor', 'by', 'setBy', 'action', 'delete', 'status', 'reason', 'variant', 'env', 'removeEnv', 'envRemove']);

const stableJson = (value) => JSON.stringify(sortObject(value));
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sortObject(item)]));
  return value;
}

function fail(message, fields = {}) {
  const error = new RosterBulkValidationError(message);
  error.fields = fields;
  throw error;
}

export class RosterBulkValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RosterBulkValidationError';
    this.code = 'validation_failed';
    this.fields = {};
  }
}

export class RosterBulkStaleError extends Error {
  constructor(message, revision) {
    super(message);
    this.name = 'RosterBulkStaleError';
    this.code = 'stale_revision';
    this.revision = revision;
  }
}

function object(value, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${at} must be an object`);
  return value;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateEnvName(name, at) {
  if (typeof name !== 'string' || !ENV_NAME.test(name)) fail(`${at} must be an UPPER_SNAKE_CASE variable name`);
}

function normalizeEnv(source, at) {
  if (source === undefined) return { set: {}, remove: [] };
  object(source, at);
  const nested = own(source, 'set') || own(source, 'remove');
  const allowed = nested ? new Set(['set', 'remove']) : null;
  if (nested) for (const key of Object.keys(source)) if (!allowed.has(key)) fail(`${at}.${key} is not supported`);
  const set = nested ? (source.set === undefined ? {} : object(source.set, `${at}.set`)) : source;
  const remove = nested ? (source.remove === undefined ? [] : source.remove) : [];
  if (!Array.isArray(remove)) fail(`${at}.remove must be an array`);
  validateCardEnv({ env: set }, at);
  const names = Object.keys(set);
  const seen = new Set();
  for (const name of remove) {
    validateEnvName(name, `${at}.remove`);
    if (seen.has(name)) fail(`${at}.remove repeats ${name}`);
    seen.add(name);
    if (own(set, name)) fail(`${at} cannot set and remove ${name} in one request`);
  }
  if (remove.length > 10) fail(`${at}.remove may contain at most 10 variables`);
  return { set: { ...set }, remove: [...remove] };
}

function normalizePatch(input, body) {
  const source = input === undefined ? body : input;
  object(source, 'patch');
  for (const key of Object.keys(source)) if (!PATCH_FIELDS.has(key)) fail(`patch.${key} is not supported`);

  const statusInput = source.status;
  let status;
  let reason = own(source, 'reason') ? source.reason : undefined;
  if (statusInput !== undefined) {
    if (statusInput && typeof statusInput === 'object' && !Array.isArray(statusInput)) {
      for (const key of Object.keys(statusInput)) if (!['status', 'value', 'reason'].includes(key)) fail(`patch.status.${key} is not supported`);
      status = statusInput.status ?? statusInput.value;
      if (own(statusInput, 'reason')) reason = statusInput.reason;
    } else status = statusInput;
    if (typeof status !== 'string' || !BULK_STATUSES.includes(status)) fail(`patch.status must be one of ${BULK_STATUSES.join('|')}`);
    // A reason that was never sent and an explicit empty string land on the same value on purpose: both mean
    // "this request names no new reason of its own" (see statusChange — repeating a status then keeps the
    // existing reason instead of blanking an acknowledgement; a non-empty reason still replaces it). Bulk
    // deliberately cannot clear a reason; that is a single-card action.
    if (reason === undefined) reason = '';
    if (typeof reason !== 'string' || reason.length > 300) fail('patch.reason must be a string of at most 300 characters');
  } else if (reason !== undefined) fail('patch.reason needs patch.status');

  const hasVariant = own(source, 'variant');
  let variant;
  if (hasVariant) {
    if (typeof source.variant !== 'string' || source.variant.length > MAX_VARIANT) fail(`patch.variant must be a string of at most ${MAX_VARIANT} characters`);
    variant = source.variant.trim();
  }

  const env = normalizeEnv(source.env, 'patch.env');
  const extraRemove = source.removeEnv ?? source.envRemove ?? [];
  if (!Array.isArray(extraRemove)) fail('patch.removeEnv must be an array');
  const remove = [...env.remove];
  for (const name of extraRemove) {
    validateEnvName(name, 'patch.removeEnv');
    if (remove.includes(name)) fail(`patch.removeEnv repeats ${name}`);
    if (own(env.set, name)) fail(`patch.env cannot set and remove ${name} in one request`);
    remove.push(name);
  }
  if (remove.length > 10) fail('patch.removeEnv may contain at most 10 variables');

  const deleting = source.delete === true || source.action === 'delete';
  if (source.delete !== undefined && typeof source.delete !== 'boolean') fail('patch.delete must be boolean');
  if (source.action !== undefined && source.action !== 'delete' && source.action !== 'update') fail('patch.action must be update or delete');
  if (deleting && (status !== undefined || hasVariant || Object.keys(env.set).length || remove.length)) fail('delete cannot be combined with another bulk change');
  if (!deleting && status === undefined && !hasVariant && !Object.keys(env.set).length && !remove.length) fail('patch must contain a change');

  return Object.freeze({
    action: deleting ? 'delete' : 'update',
    ...(status !== undefined ? { status, reason } : {}),
    ...(hasVariant ? { hasVariant: true, variant } : {}),
    ...(Object.keys(env.set).length || remove.length ? { env: { set: { ...env.set }, remove } } : {}),
  });
}

export function validateRosterBulkRequest(input) {
  object(input, 'request');
  for (const key of Object.keys(input)) if (!REQUEST_FIELDS.has(key)) fail(`request.${key} is not supported`);
  if (!Array.isArray(input.ids) || input.ids.length === 0) fail('request.ids must be a non-empty array');
  if (input.ids.length > MAX_BULK_IDS) fail(`request.ids may contain at most ${MAX_BULK_IDS} ids`);
  const ids = [];
  const seen = new Set();
  input.ids.forEach((raw, index) => {
    if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) fail(`request.ids[${index}] must match ${ID_PATTERN}`);
    if (seen.has(raw)) fail(`request.ids[${index}] repeats an earlier id ${raw}`);
    seen.add(raw);
    ids.push(raw);
  });
  if (input.patch !== undefined && input.changes !== undefined) fail('request.patch and request.changes cannot both be supplied');
  const direct = Object.fromEntries(Object.entries(input).filter(([key]) => !['ids', 'patch', 'changes', 'revision', 'fingerprint', 'ifRevision', 'actor', 'by', 'setBy'].includes(key)));
  const patch = normalizePatch(input.patch ?? input.changes, direct);
  const expectedValues = [input.revision, input.fingerprint, input.ifRevision].filter((value) => value !== undefined && value !== null && value !== '');
  if (expectedValues.length > 1 && new Set(expectedValues.map(String)).size !== 1) fail('request.revision and request.fingerprint must agree');
  const expected = expectedValues.length ? String(expectedValues[0]) : undefined;
  const actor = input.actor ?? input.by ?? input.setBy ?? 'owner';
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 40) fail('request.actor must be a non-empty string of at most 40 characters');
  return Object.freeze({ ids, patch, actor: actor.trim(), ...(expected !== undefined ? { expected } : {}) });
}

export const validateBulkRequest = validateRosterBulkRequest;

export function rosterFingerprint(roster, statusRecords = []) {
  validateRoster(roster);
  const records = statusRecords.map(validateStatusRecord);
  return createHash('sha256').update(stableJson({ roster, statusRecords: records })).digest('hex');
}

export const rosterRevision = rosterFingerprint;

function backupRosterFile(file, action, at = new Date()) {
  if (!fs.existsSync(file)) return null;
  const timestamp = at.toISOString().slice(0, 19).replace(/:/g, '-');
  const suffix = action === 'delete' ? '-delete' : '-update';
  for (let attempt = 1; ; attempt += 1) {
    const backup = `${file}.bak-${timestamp}-${attempt}${suffix}`;
    try {
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      return backup;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

function assertFresh(expected, actual) {
  if (expected !== undefined && expected !== actual) throw new RosterBulkStaleError('名册在预览后变过了，请重新预览再操作', actual);
}

function currentStatusMap(statusRecords) {
  return foldStatuses(statusRecords);
}

function factValue(card, field) {
  return own(card, field) ? card[field] : undefined;
}

function changedFacts(card, next) {
  return FACT_FIELDS.filter((field) => stableJson(factValue(card, field)) !== stableJson(factValue(next, field)));
}

function cardFingerprint(card) {
  return createHash('sha256').update(stableJson(card)).digest('hex');
}

function preservedFacts(card, changed) {
  return FACT_FIELDS.filter((field) => !changed.includes(field) && own(card, field));
}

function applyFacts(card, patch) {
  const next = { ...card };
  if (patch.hasVariant) {
    if (patch.variant) next.variant = patch.variant;
    else delete next.variant;
  }
  if (patch.env) {
    const env = { ...(card.env || {}) };
    for (const name of patch.env.remove) delete env[name];
    Object.assign(env, patch.env.set);
    if (Object.keys(env).length) next.env = env;
    else delete next.env;
  }
  return validateAdventurer(next, `adventurer (${next.id})`);
}

function statusChange(cardId, patch, statuses) {
  if (patch.status === undefined) return null;
  const current = statuses.get(cardId);
  const currentStatus = current?.status || 'available';
  const currentReason = current?.reason || '';
  // A bulk request that repeats the status a card is already in, without naming a reason of its own (patch.reason
  // is '' — normalizePatch's default both when none was sent and when an explicit empty string was sent), must
  // not blank an existing reason such as a single-card "已手动确认额度恢复" acknowledgement just because it
  // happened to sweep this already-acknowledged card up too. A real status transition, or an explicit non-empty
  // reason, still applies normally; clearing a reason through bulk is not a supported operation.
  const reason = patch.reason === '' && currentStatus === patch.status ? currentReason : patch.reason;
  if (currentStatus === patch.status && currentReason === reason) return null;
  return { status: patch.status, reason };
}

function protectionFor(id, quests) {
  const holding = quests.filter((quest) => holdsSlot(quest) && quest.assignee?.adventurerId === id);
  const unresolved = quests.filter((quest) => quest.assignee?.adventurerId === id && (quest.assignee.unresolved === true || quest.unresolved === true));
  if (holding.length) {
    const work = holding.map((quest) => `${quest.id} (${quest.status})`).join('、');
    return { code: 'holds_slot', message: `不能批量修改 ${id}：${work} 还有 worker 在用这张卡，先确认它已停止并释放` };
  }
  if (unresolved.length) {
    const work = unresolved.map((quest) => `${quest.id} (${quest.status})`).join('、');
    return { code: 'unresolved_attempt', message: `不能批量修改 ${id}：${work} 的结果还没确定，先手动确认` };
  }
  return null;
}

function quotaEvidenceProtection(id, patch, quotaEvidenceCards) {
  if (patch.action !== 'update' || patch.status !== 'available') return null;
  const evidence = quotaEvidenceCards?.find((card) => card && card.id === id);
  // The evidence probe is an overlay result with only non-available manual statuses neutralized. This
  // keeps a newer single-card available acknowledgement meaningful, while exposing lane evidence that the
  // normal overlay intentionally leaves hidden for manually limited/paused cards.
  if (evidence?.status !== 'limited' || evidence.derived?.from !== 'lanes') return null;
  // A manually limited or paused card never shows the single-card "\u786e\u8ba4\u989d\u5ea6\u5df2\u6062\u590d" button (CardModal only
  // renders it when card.derived is set \u2014 see rosterBulk N-f), so telling the owner to click it here would
  // send them looking for a button that is not there. The single card always lets them switch \u72b6\u6001 to \u7a7a\u95f2
  // by hand, so the refusal names both real paths instead of the one that may not exist for this card.
  return {
    code: 'quota_evidence',
    message: `\u5361\u7247 ${id} \u5f53\u524d\u4ecd\u6709\u5177\u4f53\u7684\u9650\u989d\u8bc1\u636e\uff0c\u4e0d\u80fd\u6279\u91cf\u8bbe\u7f6e\u4e3a\u7a7a\u95f2\uff1b\u8bf7\u5728\u5355\u5361\u4e2d\u786e\u8ba4\u989d\u5ea6\u5df2\u6062\u590d\uff08\u6216\u624b\u52a8\u6539\u4e3a\u7a7a\u95f2\uff09\u540e\u518d\u8bd5`,
  };
}

function notFound(id) {
  return { code: 'not_found', message: `名册里找不到 ${id}` };
}

function summarizeCounts(results) {
  return {
    requested: results.length,
    ready: results.filter((result) => result.ready).length,
    changed: results.filter((result) => result.ok && result.changedFields.length > 0).length,
    unchanged: results.filter((result) => result.ok && result.changedFields.length === 0).length,
    denied: results.filter((result) => !result.ok && result.denied).length,
    failed: results.filter((result) => !result.ok && !result.denied).length,
    partial: results.filter((result) => result.partial).length,
  };
}

function safeResult({ id, changedFields = [], preservedFields = [], ok = false, ready = false, denied = false, reasons = [], ...extra }) {
  return { id, ok, ready, denied, changedFields, preservedFields, ...(reasons.length ? { reasons } : {}), ...extra };
}

export function previewRosterBulk({ roster, statusRecords = [], quests = [], effectiveRoster = null, quotaEvidenceRoster = null, request, revision, fingerprint } = {}) {
  const normalized = validateRosterBulkRequest(request);
  const currentRoster = validateRoster(roster);
  const records = statusRecords.map(validateStatusRecord);
  const currentFingerprint = rosterFingerprint(currentRoster, records);
  assertFresh(normalized.expected ?? fingerprint ?? revision, currentFingerprint);
  const statuses = currentStatusMap(records);
  const byId = new Map(currentRoster.adventurers.map((card) => [card.id, card]));
  const evidenceCards = quotaEvidenceRoster ?? effectiveRoster;
  const results = normalized.ids.map((id) => {
    const card = byId.get(id);
    if (!card) return safeResult({ id, reasons: [notFound(id)] });
    const protection = protectionFor(id, quests);
    if (protection) return safeResult({ id, denied: true, reasons: [protection], changedFields: normalized.patch.action === 'delete' ? ['deleted'] : [], preservedFields: normalized.patch.action === 'delete' ? [] : preservedFacts(card, []) });
    const quotaProtection = quotaEvidenceProtection(id, normalized.patch, evidenceCards);
    if (quotaProtection) return safeResult({ id, denied: true, reasons: [quotaProtection], preservedFields: normalized.patch.action === 'delete' ? [] : preservedFacts(card, []) });
    if (normalized.patch.action === 'delete') {
      return safeResult({ id, ready: true, ok: true, changedFields: ['deleted'], preservedFields: [] });
    }
    const next = applyFacts(card, normalized.patch);
    const changed = changedFacts(card, next);
    const status = statusChange(id, normalized.patch, statuses);
    if (status) changed.push('status');
    return safeResult({ id, ready: true, ok: true, changedFields: [...new Set(changed)], preservedFields: preservedFacts(card, changed) });
  });
  const eligible = results.filter((result) => result.ready && result.ok);
  if (normalized.patch.action === 'update') {
    const planned = { adventurers: currentRoster.adventurers.map((card) => {
      const result = eligible.find((item) => item.id === card.id);
      return result ? applyFacts(card, normalized.patch) : card;
    }) };
    validateRoster(planned);
  }
  const changedFields = [...new Set(results.flatMap((result) => result.changedFields))];
  const preservedFields = [...new Set(results.flatMap((result) => result.preservedFields))];
  const deniedActiveCards = results.filter((result) => result.denied).map(({ id, reasons }) => ({ id, reasons }));
  return {
    ok: true,
    ids: [...normalized.ids],
    action: normalized.patch.action,
    actor: normalized.actor,
    revision: currentFingerprint,
    fingerprint: currentFingerprint,
    changedFields,
    preservedFields,
    deniedActiveCards,
    statusNote: '这里显示的是记下的状态；通道实时发现的限额另外显示。还有具体限额证据的卡不能批量设为空闲，请在单卡中确认额度已恢复（或手动改为空闲）。',
    results,
    counts: summarizeCounts(results),
  };
}

export const planRosterBulk = previewRosterBulk;

function redactedError(error, values) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of values) if (value) message = message.split(value).join('[已隐藏]');
  return message.slice(0, 500);
}

function freshState({ load, getStatusRecords, getQuests, getEffectiveRoster, getQuotaEvidenceRoster }) {
  const roster = validateRoster(load());
  const statusRecords = getStatusRecords();
  const quests = getQuests();
  const effectiveRoster = getEffectiveRoster ? getEffectiveRoster() : null;
  const quotaEvidenceRoster = getQuotaEvidenceRoster ? getQuotaEvidenceRoster() : effectiveRoster;
  if (effectiveRoster !== null && effectiveRoster !== undefined && !Array.isArray(effectiveRoster)) throw new Error('roster bulk effective roster must be an array');
  if (quotaEvidenceRoster !== null && quotaEvidenceRoster !== undefined && !Array.isArray(quotaEvidenceRoster)) throw new Error('roster bulk quota evidence roster must be an array');
  return { roster, statusRecords, quests, effectiveRoster: effectiveRoster || null, quotaEvidenceRoster: quotaEvidenceRoster || null, fingerprint: rosterFingerprint(roster, statusRecords) };
}

export async function applyRosterBulk({
  rosterFile,
  statusLog,
  getQuests = () => [],
  request,
  load = () => loadRosterOrEmpty(rosterFile),
  save = (file, roster) => saveRoster(file, roster),
  now = () => new Date().toISOString(),
  beforeRecheck,
  getEffectiveRoster,
  getQuotaEvidenceRoster,
} = {}) {
  if (typeof load !== 'function') throw new Error('roster bulk needs a roster loader');
  if (typeof getQuests !== 'function') throw new Error('roster bulk needs a quest loader');
  const normalized = validateRosterBulkRequest(request);
  const getStatusRecords = () => (statusLog && typeof statusLog.records === 'function' ? statusLog.records() : []);
  const before = freshState({ load, getStatusRecords, getQuests, getEffectiveRoster, getQuotaEvidenceRoster });
  assertFresh(normalized.expected, before.fingerprint);
  const firstPreview = previewRosterBulk({ roster: before.roster, statusRecords: before.statusRecords, quests: before.quests, effectiveRoster: before.effectiveRoster, quotaEvidenceRoster: before.quotaEvidenceRoster, request });
  if (beforeRecheck) await beforeRecheck(firstPreview);
  const state = freshState({ load, getStatusRecords, getQuests, getEffectiveRoster, getQuotaEvidenceRoster });
  // Even without a caller-provided fingerprint, the async preflight must not overwrite another writer's card.
  if (state.fingerprint !== before.fingerprint) throw new RosterBulkStaleError('名册在预览后变过了，请重新预览再操作', state.fingerprint);
  const preview = previewRosterBulk({ roster: state.roster, statusRecords: state.statusRecords, quests: state.quests, effectiveRoster: state.effectiveRoster, quotaEvidenceRoster: state.quotaEvidenceRoster, request });
  const values = Object.values(normalized.patch.env?.set || {});
  const results = [];
  let backupAttempted = false;
  let backup = null;
  let backupError = null;
  const ensureBackup = () => {
    if (backupAttempted) {
      if (backupError) throw backupError;
      return;
    }
    backupAttempted = true;
    try { backup = backupRosterFile(rosterFile, normalized.patch.action, new Date(now())); }
    catch (error) { backupError = error; throw error; }
  };

  for (const planned of preview.results) {
    if (!planned.ready || !planned.ok) {
      results.push(planned);
      continue;
    }
    const current = freshState({ load, getStatusRecords, getQuests, getEffectiveRoster, getQuotaEvidenceRoster });
    const card = current.roster.adventurers.find((item) => item.id === planned.id);
    const baselineCard = state.roster.adventurers.find((item) => item.id === planned.id);
    if (!card) {
      results.push(safeResult({ id: planned.id, reasons: [notFound(planned.id)] }));
      continue;
    }
    if (!baselineCard || cardFingerprint(card) !== cardFingerprint(baselineCard)) {
      results.push(safeResult({ id: planned.id, reasons: [{ code: 'stale_card', message: `${planned.id} 在预览后已经变化，请重新读取后再操作` }] }));
      continue;
    }
    const protection = protectionFor(planned.id, current.quests);
    if (protection) {
      results.push(safeResult({ id: planned.id, denied: true, reasons: [protection], changedFields: normalized.patch.action === 'delete' ? ['deleted'] : planned.changedFields, preservedFields: planned.preservedFields }));
      continue;
    }
    const quotaProtection = quotaEvidenceProtection(planned.id, normalized.patch, current.quotaEvidenceRoster);
    if (quotaProtection) {
      results.push(safeResult({ id: planned.id, denied: true, reasons: [quotaProtection], changedFields: [], preservedFields: planned.preservedFields }));
      continue;
    }
    const currentStatus = currentStatusMap(current.statusRecords);
    const status = statusChange(planned.id, normalized.patch, currentStatus);
    let appliedFields = [];
    try {
      if (normalized.patch.action === 'delete') {
        const nextRoster = { adventurers: current.roster.adventurers.filter((item) => item.id !== planned.id) };
        validateRoster(nextRoster);
        ensureBackup();
        save(rosterFile, nextRoster);
        appliedFields = ['deleted'];
      } else {
        const nextCard = applyFacts(card, normalized.patch);
        const nextRoster = { adventurers: current.roster.adventurers.map((item) => item.id === planned.id ? nextCard : item) };
        validateRoster(nextRoster);
        if (changedFacts(card, nextCard).length) {
          ensureBackup();
          save(rosterFile, nextRoster);
          appliedFields = changedFacts(card, nextCard);
        }
      }
      if (status) {
        if (!statusLog || typeof statusLog.set !== 'function') throw new Error('status log is not configured');
        statusLog.set(planned.id, { status: status.status, reason: status.reason, setBy: normalized.actor, at: now() });
        appliedFields.push('status');
      }
      results.push(safeResult({ id: planned.id, ok: true, ready: true, changedFields: [...new Set(appliedFields)], preservedFields: planned.preservedFields }));
    } catch (error) {
      results.push(safeResult({
        id: planned.id,
        ready: true,
        partial: appliedFields.length > 0,
        appliedFields: [...new Set(appliedFields)],
        changedFields: [],
        preservedFields: planned.preservedFields,
        error: redactedError(error, [...values, ...Object.values(card.env || {})]),
      }));
    }
  }

  return {
    ...preview,
    applied: true,
    results,
    deniedActiveCards: results.filter((result) => result.denied).map(({ id, reasons }) => ({ id, reasons })),
    changedFields: [...new Set(results.flatMap((result) => result.ok ? result.changedFields : []))],
    ...(backup ? { backup: true } : {}),
    counts: summarizeCounts(results),
  };
}

export const executeRosterBulk = applyRosterBulk;
