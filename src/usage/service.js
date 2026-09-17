// Collects every provider's usage in parallel with one memory cache per provider. The last successful numbers
// survive a later failure, visibly marked stale with the real lastSuccessAt / attemptedAt / error — a stale
// success is never presented as fresh. Error text shown to the owner is either a fixed Chinese sentence keyed
// by a provider's own result `code`, or a UsageError rendered from a known code with validated parameters
// (see trustedUsageErrorText in common.js) — never a provider's free-text `error` field, and never a
// UsageError's raw `.message` on trust in `instanceof` alone. Fields other than error text (windows, balances,
// plan, note, asOf, provider.name/source/unavailable, credentials.js's keyFrom) are this repo's own adapter
// code, not response bodies, and are treated as trusted first-party data — they are still schema-copied to
// plain values before caching so a poisoned nested getter or toJSON can never reach a later response.
//
// Timestamps mean three different things, never interchangeably: attemptedAt is when the current/last attempt
// *started*; lastSuccessAt is when the last successful attempt *finished* (settled); generatedAt is when this
// particular report() call ran, independent of any provider's own read. A pending slot (no attempt has ever
// settled) has no fetchedAt of its own — it is left null rather than filled with "now", which would look like
// a read that already happened.
import os from 'node:os';
import { runCommand, trustedUsageErrorText, trustedResultText } from './common.js';
import { CLAUDE_SNAPSHOT_ERROR_TEXT } from './claudeStatusline.js';
import { createCredentials, describeKeySources } from './credentials.js';
import { EXPERIMENTAL_PROVIDERS, PROVIDERS } from './providers.js';
import {
  ALIBABA_EDITIONS,
  ALIBABA_REGIONS,
  MANUAL_PROVIDERS,
  createAlibabaTokenPlan,
  createAlibabaCodingPlan,
} from './manualProviders.js';
import { ALLOWED_ACCESS_TYPES } from './catalog.js';
import { catalogMetadata } from './display.js';

const KNOWN_MANUAL_PROVIDER_IDS = new Set(MANUAL_PROVIDERS.map((provider) => provider.id));
const MANUAL_PROVIDER_BY_ID = new Map(MANUAL_PROVIDERS.map((provider) => [provider.id, provider]));
const KNOWN_EXPERIMENTAL_PROVIDER_IDS = new Set(EXPERIMENTAL_PROVIDERS.map((provider) => provider.id));
const EXPERIMENTAL_PROVIDER_BY_ID = new Map(EXPERIMENTAL_PROVIDERS.map((provider) => [provider.id, provider]));

const ALLOWED_PROVIDER_STATES = new Set(['ok', 'not_configured', 'not_subscribed', 'unknown', 'manual_only']);

function safeChoice(value, allowlist) {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (allowlist.has(trimmed)) return trimmed;
  }
  return 'unknown';
}

function buildManualProvider(id, alibabaCfg) {
  if (id === 'alibaba-token-plan') {
    const edition = safeChoice(alibabaCfg?.edition, ALIBABA_EDITIONS);
    const region = safeChoice(alibabaCfg?.region, ALIBABA_REGIONS);
    return createAlibabaTokenPlan({ edition, region });
  }
  if (id === 'alibaba-coding-plan') {
    const edition = safeChoice(alibabaCfg?.edition, ALIBABA_EDITIONS);
    const region = safeChoice(alibabaCfg?.region, ALIBABA_REGIONS);
    return createAlibabaCodingPlan({ edition, region });
  }
  const provider = MANUAL_PROVIDER_BY_ID.get(id);
  if (provider) return provider;
  throw new Error(`未知的用量来源：${id}`);
}

const CACHE_MS = 60000;
const COOLDOWN_MS = 15000;
const TIMEOUT_MS = 20000;
const MAX_SPAN_MS = 6 * 60 * 60 * 1000;
const empty = () => ({ windows: [], balances: [], plan: '', note: '', asOf: null });

// The only shape a provider id may take. Shared with the route (src/server/usageRoutes.js imports this
// exact pattern) so a provider that could never be reached through ?provider= can never be registered here
// either, and the two never drift apart.
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

// Bounded, guarded property read: a malicious or buggy provider result can define `error` or `name` as a
// getter that throws or as a Proxy trap that misbehaves. Every read of untrusted provider output goes
// through this so a throwing accessor can never escape into an unhandled rejection.
function readSafe(value, key) {
  try {
    return value == null ? undefined : value[key];
  } catch {
    return undefined;
  }
}

// Fixed allowlist: only built-in error names reach the page. Anything else — a renamed Error, a plain
// thrown object with a crafted `name`, a getter that throws while being read — collapses to the generic
// 'Error' label instead of being echoed verbatim.
const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'TimeoutError', 'AbortError']);

function safeErrorName(error) {
  const name = readSafe(error, 'name');
  return typeof name === 'string' && SAFE_ERROR_NAMES.has(name) ? name : 'Error';
}

// A provider's own `{ ok:false, error }` free-text field is never displayed: an appearance check (string,
// short, non-empty) bounds nothing about the content, so it is not a boundary. Only a provider's `code` is
// looked up against a fixed catalog: first the shared one in common.js, then the Claude snapshot codes — and
// those sentences are the reader's own table (claudeStatusline.js), imported rather than copied so the two
// can never drift apart. A missing or unrecognised code still falls back to a generic message that names the
// provider.
function claudeSnapshotErrorText(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(CLAUDE_SNAPSHOT_ERROR_TEXT, code)
    ? CLAUDE_SNAPSHOT_ERROR_TEXT[code]
    : undefined;
}

// The displayed entry may carry the fixed code itself (F1) so the board can pick its own sentence from it; a
// code that is not one of the reader's fixed claude_snapshot_* names is never put on an entry.
function claudeSnapshotErrorCode(result) {
  const code = readOwnDataValue(result, 'code');
  return claudeSnapshotErrorText(code) === undefined ? undefined : code;
}

function providerResultErrorText(result, provider) {
  const code = readOwnDataValue(result, 'code');
  return trustedResultText(code, claudeSnapshotErrorText(code) ?? `${provider.name} 没有给出可显示的失败原因`);
}

// A well-formed provider result is a plain object with an ordinary prototype: literally `Object.prototype`
// (an object literal, or one built from one), or `null` (Object.create(null)) — and only when its own fields
// still add up to a recognised shape; a bare null-prototype object with nothing recognisable still fails, see
// evaluateResult below. Anything else — null, undefined, an array, a primitive, a class instance, a Date, an
// object whose prototype is itself some other plain object (Object.create({...})), or one with an accessor
// planted on its prototype — is never treated as data, successful or not, however plausible its own fields
// look: inheriting a field (even a real-looking `windows` array) from a non-ordinary prototype is exactly the
// laundering this check exists to catch.
function isPlainResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  let proto;
  try { proto = Object.getPrototypeOf(value); } catch { return false; }
  return proto === Object.prototype || proto === null;
}

// Reads a field only when it is the object's OWN plain data property — never inherited, and never an
// accessor. A getter is never invoked to find out what it would return: an own accessor on a result (or a
// nested window/balance item) is treated exactly like the field being absent or wrong-typed, not like real
// data that merely needs sanitizing. `Object.getOwnPropertyDescriptor` itself can throw on an exotic Proxy,
// which is guarded the same way. Used only for item-level fields (a single window/balance's label, currency,
// …), where an unreadable field just drops that one item — never for the top-level fields that decide whether
// the whole result is fresh, which go through readCriticalField below instead.
function readOwnDataValue(value, key) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return undefined; }
  if (!descriptor || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

// The same guarded, own-data-only read as readOwnDataValue, but keeping "the field is genuinely absent"
// distinguishable from "the field exists but could not be read safely" (an own accessor, or the descriptor
// trap itself throwing on a Proxy). Only readOwnDataValue's collapse of those two into one `undefined` is safe
// for an item inside a list, where an unreadable field just drops that one item; collapsing them at the
// top level is not safe, because a result can independently carry a genuinely valid field (a plain `note`
// string, say) alongside a `windows` that only *looks* absent because reading it actually failed — and
// falling back to "no windows, but the note is real" is exactly how an accessor/trap failure on windows used
// to still reach the page as a fresh (if partial) success. blocked:true means exactly that: this field could
// not be read, so nothing about it may be treated as either present or absent — the whole result must fail.
function readCriticalField(value, key) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return { blocked: true }; }
  if (!descriptor) return { present: false };
  if (!('value' in descriptor)) return { blocked: true };
  return { present: true, value: descriptor.value };
}

// Distinguishes "the field is absent" (real adapters may omit `ok` on success) from "it has some value" from
// a small third case treated exactly like a throw: `ok` defined as an own accessor. Only a data property that
// is absent or a literal `true` may count as success; a throwing read, an accessor (never invoked to see what
// it would return), or any other value can never be treated as a fresh success.
function readOkFlag(result) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(result, 'ok'); } catch { return { state: 'throws' }; }
  if (!descriptor) return { state: 'absent' };
  if (!('value' in descriptor)) return { state: 'throws' };
  return { state: 'value', value: descriptor.value };
}

const MAX_LIST_LENGTH = 1000;
const MAX_TEXT_LENGTH = 10000;
const MAX_FIELD_LENGTH = 500;

function sanitizeString(value) {
  return typeof value === 'string' ? value : null;
}

function boundedString(value, limit = MAX_FIELD_LENGTH) {
  return typeof value === 'string' && value.length <= limit ? value : null;
}

function sanitizeNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Usage is never negative — a provider reporting it anyway has produced something that cannot be trusted as a
// percentage, so it becomes unknown rather than a fabricated fresh value. There is no upper bound: a real
// over-limit burst above 100% is still a real value, and clamping it into a 0..100 bar is a display concern,
// not a validation one.
function sanitizeUsedPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// A window/balance item is validated the same way as the top-level result: its own plain data properties
// only, ordinary prototype only. label/currency/resetsAt are bounded so one adapter's nested string can never
// grow past a reasonable display length — no invented date parsing for resetsAt, it is shown only as the raw
// string an adapter already produced.
function sanitizeWindow(raw) {
  if (!isPlainResult(raw)) return null;
  const label = boundedString(readOwnDataValue(raw, 'label'));
  if (label === null) return null;
  const stateRaw = readOwnDataValue(raw, 'state');
  const isReset = stateRaw === 'reset';
  const usedPercent = isReset ? null : sanitizeUsedPercent(readOwnDataValue(raw, 'usedPercent'));
  const resetDerivedRaw = readOwnDataValue(raw, 'resetDerived');
  const resetDerived = typeof resetDerivedRaw === 'boolean' ? resetDerivedRaw : undefined;
  return {
    label,
    usedPercent,
    resetsAt: boundedString(readOwnDataValue(raw, 'resetsAt')),
    ...(isReset ? { state: 'reset' } : {}),
    ...(resetDerived !== undefined ? { resetDerived } : {}),
  };
}

function sanitizeBalance(raw) {
  if (!isPlainResult(raw)) return null;
  const currency = boundedString(readOwnDataValue(raw, 'currency'));
  if (currency === null) return null;
  const amount = sanitizeNumberOrNull(readOwnDataValue(raw, 'amount'));
  const granted = sanitizeNumberOrNull(readOwnDataValue(raw, 'granted'));
  const toppedUp = sanitizeNumberOrNull(readOwnDataValue(raw, 'toppedUp'));
  const isAvailableRaw = readOwnDataValue(raw, 'isAvailable');
  const isAvailable = typeof isAvailableRaw === 'boolean' || isAvailableRaw === null ? isAvailableRaw : undefined;
  if (amount === null && granted === null && toppedUp === null) return null;
  return {
    currency,
    ...(amount !== null ? { amount } : {}),
    ...(granted !== null ? { granted } : {}),
    ...(toppedUp !== null ? { toppedUp } : {}),
    ...(isAvailable !== undefined ? { isAvailable } : {}),
  };
}

// A list is only ever read through its own, ordinary, plain-Array-prototype shape — never through `for…of`
// (which calls `[Symbol.iterator]`, and the ordinary array iterator itself performs an *ordinary get* on each
// index, so it would silently invoke an index-level accessor exactly like a direct property read would) and
// never by trusting `.length` as read through a `get` trap (a Proxy can make `.length` lie independently of
// what its indices actually hold — see the "lying length" case this still has to survive). Instead: reject
// anything whose own shape has been tampered with (a subclass, a hand-planted own `Symbol.iterator`, a
// descriptor trap that throws), then read `length` and every index as an own *data* descriptor directly —
// never invoking a getter to find out what it would return, and never trusting a value read through `get`.
function listShape(value) {
  if (value === undefined) return { present: false };
  if (!Array.isArray(value)) return { present: false };
  let proto;
  try { proto = Object.getPrototypeOf(value); } catch { return { present: true, blocked: true }; }
  // A subclass (or any array whose prototype isn't the ordinary one) can override `length`, indexed access or
  // iteration with arbitrary code; only the ordinary shape is ever trusted as data.
  if (proto !== Array.prototype) return { present: true, blocked: true };
  let hasOwnIterator;
  try { hasOwnIterator = Object.prototype.hasOwnProperty.call(value, Symbol.iterator); } catch { return { present: true, blocked: true }; }
  // An own Symbol.iterator is never invoked (this function never iterates at all), but its mere presence
  // marks the array as tampered with — real adapter output never plants one — so the whole list is rejected
  // rather than silently read around it.
  if (hasOwnIterator) return { present: true, blocked: true };
  let lengthDescriptor;
  try { lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length'); } catch { return { present: true, blocked: true }; }
  if (!lengthDescriptor || !('value' in lengthDescriptor)) return { present: true, blocked: true };
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) return { present: true, blocked: true };
  return { present: true, blocked: false, length };
}

// Copies a list field into brand-new plain items. `stats.seen` (not `.length`) is what later tells a
// genuinely provided, entirely-invalid list apart from one that started out empty; the cap is enforced against
// indices actually visited, so a `length` that undercounts what the array really holds cannot smuggle more
// than MAX_LIST_LENGTH items through either — reading one index past the reported length is exactly how B7's
// lying-length Proxy is still caught. Any structural problem — an accessor sitting on an index, a descriptor
// trap throwing partway through — fails the whole list rather than returning whatever was collected so far:
// a throwing getter, a poisoned length/iterator, or a toJSON on an item can never survive into the cache, and
// neither can a partial read stand in for a complete one.
function sanitizeList(value, sanitizeItem, stats) {
  const shape = listShape(value);
  if (!shape.present) return { out: [], blocked: false };
  if (shape.blocked) return { out: [], blocked: true };
  const out = [];
  // `shape.length` is already the real, own `length` data descriptor's value (read above, not through a `get`
  // trap), so bounding the loop with it — rather than a separately re-read `.length` — is what still catches a
  // Proxy whose `get` trap answers `.length` with a lie: the loop above already saw the true count.
  for (let i = 0; i < shape.length; i += 1) {
    stats.seen += 1;
    if (stats.seen > MAX_LIST_LENGTH) { stats.overflow = true; break; }
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, i); } catch { return { out: [], blocked: true }; }
    if (!descriptor) continue; // a sparse hole is simply not an item, not a structural problem
    if (!('value' in descriptor)) return { out: [], blocked: true }; // an accessor index: never invoked
    let sanitized;
    try { sanitized = sanitizeItem(descriptor.value); } catch { sanitized = null; }
    if (sanitized) out.push(sanitized);
  }
  return { out, blocked: false };
}

// asOf claims a point in time; a value that cannot actually be parsed as one is not silently coerced (no
// `new Date(garbage)`, which would fabricate a timestamp) — it becomes unknown instead, per contract. Strict
// calendar validation, not `Date.parse`'s leniency: a bare `"1"` (parsed as year 2001) or an out-of-range day
// that `Date.parse`/`new Date()` would quietly roll over (Feb 31 -> Mar 3) is rejected outright rather than
// accepted as some other, invented date.
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

// `Date.UTC(year, ...)` (like the multi-arg `Date` constructor) has a legacy quirk: a year from 0 to 99 is
// silently remapped to 1900-1999, so `Date.UTC(0, 2, 0)` computes the last day of February *1900* (not a leap
// year) instead of year 0 (which, proleptic Gregorian, is). `setUTCFullYear` has no such remapping — it always
// sets the literal year given — so it is used here instead, on a throwaway Date, purely to get a correct
// days-in-month figure for any year the regex above already accepted as four digits.
function daysInMonthUTC(year, month) {
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0);
  return probe.getUTCDate();
}

function sanitizeAsOf(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_DATETIME.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12) return null;
  const daysInMonth = daysInMonthUTC(year, month);
  if (day < 1 || day > daysInMonth) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

// The single place a provider result is read and judged. Every top-level field is read exactly once, through
// readCriticalField — never re-read, never an inherited or accessor value invoked to see what it would
// return, and never collapsed into "absent" when it was actually unreadable — so a getter that would answer
// differently on a second call, or a descriptor trap that throws, can never smuggle more than one bounded,
// consistent snapshot through, and can never hide behind some *other* genuinely valid field (a plain `note`
// string, say) to still reach the page as a fresh, if partial, success. That one snapshot is what
// hasRecognizedShape, the size bounds, sanitizing and the gutted-payload check all see.
function evaluateResult(result, provider = null) {
  const fields = ['windows', 'balances', 'plan', 'note', 'asOf', 'state', 'source', 'stale', 'manual_only', 'asOfDerived', 'isAvailable'];
  const raw = {};
  for (const key of fields) {
    const field = readCriticalField(result, key);
    if (field.blocked) return { kind: 'blocked' };
    raw[key] = field.present ? field.value : undefined;
  }
  // A recognised success must show at least one field shaped like real adapter output: `windows` or
  // `balances` as a genuine array, or `plan`/`note` as a genuinely non-empty string. `{}`, `{ok:true}`, an
  // object with only unrelated keys, or one whose fields are the wrong type carries no information this
  // module understands — an explicit empty array (or a non-empty plan/note) is still recognised: that is what
  // tells a legitimate "no data right now" apart from a corrupted result that happens to be empty too.
  const recognized = Array.isArray(raw.windows) || Array.isArray(raw.balances)
    || (typeof raw.plan === 'string' && raw.plan !== '') || (typeof raw.note === 'string' && raw.note !== '');
  if (!recognized) return { kind: 'unrecognized' };

  const windowStats = { seen: 0, overflow: false };
  const balanceStats = { seen: 0, overflow: false };
  const windowsResult = sanitizeList(raw.windows, sanitizeWindow, windowStats);
  if (windowsResult.blocked) return { kind: 'blocked' };
  const balancesResult = sanitizeList(raw.balances, sanitizeBalance, balanceStats);
  if (balancesResult.blocked) return { kind: 'blocked' };
  const windows = windowsResult.out;
  const balances = balancesResult.out;
  const planTooLong = typeof raw.plan === 'string' && raw.plan.length > MAX_TEXT_LENGTH;
  const noteTooLong = typeof raw.note === 'string' && raw.note.length > MAX_TEXT_LENGTH;
  // A result far outside any real adapter's shape (an absurd array or a huge string) fails cleanly instead of
  // being silently truncated into a "fresh" success that only shows part of what the provider actually sent.
  if (windowStats.overflow || balanceStats.overflow || planTooLong || noteTooLong) return { kind: 'too_large' };

  const plan = sanitizeString(raw.plan) ?? '';
  const note = sanitizeString(raw.note) ?? '';
  const asOf = sanitizeAsOf(raw.asOf);
  const source = typeof raw.source === 'string' && ALLOWED_ACCESS_TYPES.has(raw.source) ? raw.source : undefined;
  const resultStale = raw.stale === true;

  let providerState = undefined;
  if (typeof raw.state === 'string' && ALLOWED_PROVIDER_STATES.has(raw.state)) {
    providerState = raw.state;
  } else if (raw.manual_only === true || (provider && provider.manual_only === true)) {
    providerState = 'manual_only';
  }
  const asOfDerived = typeof raw.asOfDerived === 'boolean' ? raw.asOfDerived : undefined;
  const isAvailable = typeof raw.isAvailable === 'boolean' || raw.isAvailable === null ? raw.isAvailable : undefined;
  // A recognised list field whose every entry failed validation is corrupted data, not an intentional empty
  // result — that distinction only shows before sanitizing: a list that started at length 0 (or a non-empty
  // plan/note) is an explicit, legitimate "nothing to show"; one that had entries but lost every one of them
  // to validation did not. A genuinely non-empty, all-invalid list fails the whole result — even when asOf or
  // note or plan metadata is present, none of that is numeric data — unless the *other* list independently
  // still has real, valid entries, in which case that surviving numeric data is a real success.
  const windowsWiped = windowStats.seen > 0 && windows.length === 0;
  const balancesWiped = balanceStats.seen > 0 && balances.length === 0;
  const numericSurvived = windows.length > 0 || balances.length > 0;
  if ((windowsWiped || balancesWiped) && !numericSurvived) return { kind: 'gutted' };
  return {
    kind: 'ok',
    data: {
      windows,
      balances,
      plan,
      note,
      asOf,
      ...(providerState !== undefined ? { providerState } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(resultStale ? { resultStale: true } : {}),
      ...(asOfDerived !== undefined ? { asOfDerived } : {}),
      ...(isAvailable !== undefined ? { isAvailable } : {}),
    },
  };
}

function checkSpan(name, value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 毫秒之间的数字，收到：${String(value)}`);
  }
}

export function createUsageService({
  fetchImpl = fetch, env = process.env, homedir = os.homedir(), exec = runCommand,
  providers, manualProviders, config, alibaba,
  cacheMs = CACHE_MS, cooldownMs = COOLDOWN_MS, timeoutMs = TIMEOUT_MS, now = () => Date.now(),
} = {}) {
  let providersList;
  if (providers !== undefined) {
    providersList = [...providers];
  } else {
    providersList = [...PROVIDERS];
  }
  const enabledManualIds = manualProviders ?? config?.usage?.manualProviders ?? [];
  if (!Array.isArray(enabledManualIds)) {
    throw new TypeError('manualProviders 必须是数组');
  }
  const alibabaCfg = alibaba ?? config?.usage?.alibaba;
  for (const id of enabledManualIds) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error(`未知的用量来源：${String(id)}`);
    }
    const cleanId = id.trim();
    if (!KNOWN_MANUAL_PROVIDER_IDS.has(cleanId)) {
      throw new Error(`未知的用量来源：${cleanId}`);
    }
    const manualProvider = buildManualProvider(cleanId, alibabaCfg);
    if (!providersList.some((p) => p.id === cleanId)) {
      providersList.push(manualProvider);
    }
  }
  const enabledExperimentalIds = config?.usage?.experimentalProviders ?? [];
  if (!Array.isArray(enabledExperimentalIds)) {
    throw new TypeError('experimentalProviders 必须是数组');
  }
  for (const id of enabledExperimentalIds) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('未知的用量来源：' + String(id));
    }
    const cleanId = id.trim();
    if (!KNOWN_EXPERIMENTAL_PROVIDER_IDS.has(cleanId)) {
      throw new Error('未知的用量来源：' + cleanId);
    }
    const experimentalProvider = EXPERIMENTAL_PROVIDER_BY_ID.get(cleanId);
    if (!providersList.some((p) => p.id === cleanId)) {
      providersList.push(experimentalProvider);
    }
  }
  checkSpan('cacheMs', cacheMs, 1000, MAX_SPAN_MS);
  checkSpan('cooldownMs', cooldownMs, 0, MAX_SPAN_MS);
  checkSpan('timeoutMs', timeoutMs, 10, MAX_SPAN_MS);
  if (typeof now !== 'function') throw new Error('now 必须是一个返回毫秒时间戳的函数');
  const providerIds = [];
  for (const one of providersList) {
    if (!one || typeof one.id !== 'string' || !one.id) throw new Error('每个用量 provider 都需要一个非空的 id');
    if (!PROVIDER_ID_PATTERN.test(one.id)) throw new Error(`provider id 格式不对，只能是小写字母开头的短名：${one.id}`);
    if (providerIds.includes(one.id)) throw new Error(`provider id 重复：${one.id}`);
    providerIds.push(one.id);
  }
  const credentials = createCredentials({ env, homedir });
  const slots = new Map();
  const iso = (ms) => new Date(ms).toISOString();
  const clock = () => {
    const ms = now();
    if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new Error(`now() 必须返回数字时间戳，收到：${String(ms)}`);
    return ms;
  };
  const timeoutNote = `等待超过 ${Math.max(1, Math.round(timeoutMs / 1000))} 秒仍未返回：后台可能仍在继续，看板不会重复发起`;
  const coolingNote = '刚刚已经发起过读取，冷却结束后才能再刷新';
  const neverReadNote = '还没有读取过这个来源，下一次读取会显示结果';

  // freshUntil is an absolute deadline (clock() + cacheMs at the time of the read), so a backward system-clock
  // jump — the clock moving to before that read happened — must not leave the cache reading as fresh for the
  // entire time the wall clock takes to catch back up (which could be far longer than cacheMs). Clamping the
  // remaining window to at most cacheMs makes the check behave like an elapsed-duration comparison without
  // needing a real monotonic clock: on a normal forward-moving clock this clamp never actually fires (the
  // remaining time can only shrink), it only bites when the clock has moved backward past when the read began.
  function isFresh(slot) {
    const t = clock();
    return t < slot.freshUntil && slot.freshUntil - t <= cacheMs;
  }

  function slotOf(provider) {
    let slot = slots.get(provider.id);
    if (!slot) {
      // outcome：最后一次结束的读取；record：最后一次成功的数字（读取失败时保留并标记 stale）。
      slot = { outcome: null, attemptedAt: null, freshUntil: 0, record: null, lastSuccessAt: null, lastRefreshAt: null, inflight: null, generation: 0 };
      slots.set(provider.id, slot);
    }
    return slot;
  }

  // Never rejects: every failure arrives as a safe outcome. Only text rendered from a known, validated
  // UsageError code (trustedUsageErrorText) or a known result code (trustedResultText) reaches the page.
  async function attemptRead(provider) {
    const base = { id: provider.id, name: provider.name, source: provider.source, keyFrom: null };
    try {
      if (provider.unavailable) return { ...base, kind: 'unavailable', configured: false, error: provider.unavailable };
      let key = null;
      if (provider.keys) {
        const found = credentials.apiKey(provider.keys);
        if (!found) return { ...base, kind: 'unconfigured', configured: false, error: `没有找到 key：${describeKeySources(provider.keys)}` };
        key = found.key;
        base.keyFrom = found.from;
      }
      if (provider.oauth) {
        const found = credentials.oauthToken(provider.oauth);
        if (!found) return { ...base, kind: 'unconfigured', configured: false, error: `没有找到登录：${describeKeySources({ openCodeIds: provider.oauth.openCodeIds })}` };
        if (found.expired) return { ...base, kind: 'expired', configured: true, error: `${found.from} 的登录已过期，请重新登录`, keyFrom: found.from };
        key = found.key;
        base.keyFrom = found.from;
      }
      if (typeof provider.fetch !== 'function') return { ...base, kind: 'unconfigured', configured: false, error: `${provider.name} 还没有可自动读取的来源，只能手动核对` };
      const result = await provider.fetch({ fetchImpl, key, exec, env, homedir, now: now() });
      if (!isPlainResult(result)) {
        return { ...base, kind: 'failed', configured: true, error: `${provider.name} 没有给出可显示的失败原因` };
      }
      const okFlag = readOkFlag(result);
      if (okFlag.state === 'throws') {
        return { ...base, kind: 'failed', configured: true, error: `${provider.name} 没有给出可显示的失败原因` };
      }
      if (okFlag.state === 'value' && okFlag.value === false) {
        const configuredRaw = readOwnDataValue(result, 'configured');
        const configured = configuredRaw === undefined ? true : Boolean(configuredRaw);
        const error = providerResultErrorText(result, provider);
        const errorCode = claudeSnapshotErrorCode(result);
        return { ...base, kind: configured ? 'failed' : 'unconfigured', configured, error, ...(errorCode !== undefined ? { errorCode } : {}) };
      }
      // A recognised success is either "no ok field" (real adapters may omit it) or an explicit `true`.
      // Anything else — a string, a number, a getter that resolved to neither boolean — is not a signal this
      // module understands, so it can never be presented as fresh data with fabricated empty numbers.
      if (okFlag.state === 'value' && okFlag.value !== true) {
        return { ...base, kind: 'failed', configured: true, error: `${provider.name} 没有给出可显示的失败原因` };
      }
      const evaluated = evaluateResult(result, provider);
      if (evaluated.kind === 'unrecognized' || evaluated.kind === 'blocked') {
        // 'blocked' covers a top-level field or a list that could not be read safely at all (an accessor, a
        // tampered array shape, a descriptor trap throwing) — same fixed message as a genuinely unrecognised
        // shape, since a caller must never be able to tell the two apart from the error text alone.
        return { ...base, kind: 'failed', configured: true, error: `${provider.name} 没有给出可显示的失败原因` };
      }
      if (evaluated.kind === 'too_large') {
        return { ...base, kind: 'failed', configured: true, error: `${provider.name} 返回的数据超出了正常范围` };
      }
      if (evaluated.kind === 'gutted') {
        return { ...base, kind: 'failed', configured: true, error: `${provider.name} 没有给出可显示的失败原因` };
      }
      return { ...base, kind: 'ok', configured: true, data: evaluated.data };
    } catch (error) {
      const message = trustedUsageErrorText(error) ?? `读取失败（${safeErrorName(error)}）`;
      return { ...base, kind: 'failed', configured: true, error: message };
    }
  }

  function applyOutcome(slot, outcome, startedAt) {
    slot.outcome = outcome;
    slot.attemptedAt = startedAt;
    slot.freshUntil = clock() + cacheMs;
    if (outcome.kind === 'ok') {
      slot.record = { ...outcome.data, fetchedAt: iso(startedAt), keyFrom: outcome.keyFrom };
      slot.lastSuccessAt = clock();
    } else if (outcome.kind !== 'failed') {
      // 未配置 / 已下线 / 登录过期：当前的权威说法就是没有数字，不拿旧数字冒充。
      slot.record = null;
      slot.lastSuccessAt = null;
    }
  }

  function begin(provider, slot) {
    slot.generation += 1;
    const generation = slot.generation;
    const startedAt = clock();
    const attempt = { startedAt, promise: null };
    // settle always fulfills, never rejects, however attemptRead finishes: a rejection here would leave
    // slot.inflight set forever (the provider could never be read again) and, through waitWithin, would
    // surface as a rejected report() — a 500 at the route with error.message echoed to the response.
    const settle = (outcome) => {
      if (slot.inflight === attempt) slot.inflight = null;
      // 晚到的完成只能写进属于它的状态：一旦有更新的尝试，旧结果整份丢弃。
      if (slot.generation === generation) applyOutcome(slot, outcome, startedAt);
    };
    attempt.promise = attemptRead(provider).then(
      (outcome) => settle(outcome),
      (error) => settle({ kind: 'failed', configured: true, error: `读取失败（${safeErrorName(error)}）` }),
    );
    slot.inflight = attempt;
    return attempt;
  }

  // A deadline to wait, nothing more: a timed-out attempt keeps its slot (inflight stays) so a hung
  // provider can never be spawned twice while its first read is unresolved.
  function waitWithin(attempt) {
    // Bounded to at most timeoutMs: attempt.startedAt was captured from clock() when the read began, and a
    // later call here (a second report() joining the same still-inflight attempt) reads clock() again — if
    // the wall clock has since jumped backward past startedAt, the naive `startedAt + timeoutMs - clock()`
    // grows far past timeoutMs (a 3s rollback with a 50ms timeout would wait ~3050ms instead of ~50ms), and a
    // hung provider would hold up the request for however long the clock rolled back, not the configured
    // deadline. Clamping the ceiling here makes the wait behave like an elapsed-duration deadline without a
    // real monotonic clock: on a normal forward-moving clock this ceiling never actually bites (the raw value
    // can only shrink from timeoutMs), it only fires once the clock has moved backward past when this attempt
    // began — the same clamp-to-cacheMs shape isFresh already uses for the same reason.
    const remaining = Math.min(timeoutMs, Math.max(1, attempt.startedAt + timeoutMs - clock()));
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(true), remaining); });
    return Promise.race([attempt.promise.then(() => false), late]).finally(() => clearTimeout(timer));
  }

  function display(provider, slot, { cooling = false } = {}) {
    const refreshing = Boolean(slot.inflight);
    const catalogMeta = catalogMetadata(provider.id);
    const recordSource = slot.record && typeof slot.record.source === 'string' ? slot.record.source : provider.source;
    const base = {
      id: provider.id,
      name: provider.name,
      source: recordSource,
      ...catalogMeta,
      refreshing,
      cooling,
      lastRefreshAt: slot.lastRefreshAt === null ? null : iso(slot.lastRefreshAt),
    };
    const meta = { attemptedAt: slot.attemptedAt === null ? null : iso(slot.attemptedAt), lastSuccessAt: slot.lastSuccessAt === null ? null : iso(slot.lastSuccessAt) };
    const o = slot.outcome;
    if (!o) {
      // Nothing has settled for this provider yet, so whether a key or login even exists is still unknown —
      // configured stays null (not a false "missing credentials") until a real attempt reports one way or
      // the other.
      return {
        ...base, ...empty(), ok: false, configured: null, state: 'pending', fresh: false, stale: false,
        error: refreshing ? timeoutNote : cooling ? coolingNote : neverReadNote,
        // No attempt has ever settled for this provider, so there is no fetchedAt to report — filling it with
        // "now" would look like a read that already happened.
        fetchedAt: null, ...meta,
      };
    }
    if (o.kind === 'unavailable' || o.kind === 'unconfigured' || o.kind === 'expired') {
      const entry = { ...base, ...empty(), ok: false, configured: o.configured, state: o.kind, fresh: false, stale: false, error: o.error, ...(o.errorCode !== undefined ? { errorCode: o.errorCode } : {}), fetchedAt: iso(slot.attemptedAt), ...meta };
      if (o.keyFrom) entry.keyFrom = o.keyFrom;
      return entry;
    }
    if (o.kind === 'ok') {
      const resultStale = slot.record.resultStale === true;
      const fresh = !resultStale && isFresh(slot);
      const isManual = slot.record.providerState === 'manual_only';
      const isNotConfigured = slot.record.providerState === 'not_configured';
      const isNotSubscribed = slot.record.providerState === 'not_subscribed';
      const windows = isManual ? [] : slot.record.windows;
      // A provider that reports its own state as unknown while showing no windows and no balances has given
      // nothing real to read: `ok` stays true only for real readings, so this is displayed as a failure with
      // the provider's own plan/note text (or a fixed sentence naming the state) as the visible text.
      const unknownWithoutNumbers = slot.record.providerState === 'unknown' && windows.length === 0 && slot.record.balances.length === 0;
      const ok = (isManual || isNotConfigured || isNotSubscribed || unknownWithoutNumbers) ? false : true;
      const numbers = {
        windows,
        balances: slot.record.balances,
        plan: slot.record.plan,
        note: slot.record.note,
        asOf: slot.record.asOf,
        ...(slot.record.providerState ? { providerState: slot.record.providerState } : {}),
        ...(slot.record.asOfDerived !== undefined ? { asOfDerived: slot.record.asOfDerived } : {}),
        ...(slot.record.isAvailable !== undefined ? { isAvailable: slot.record.isAvailable } : {}),
      };
      if (fresh) {
        const entry = {
          ...base,
          ...numbers,
          ok,
          configured: true,
          // A manual-only card has no automatic reading to be fresh about: the cache-state field must not
          // claim 'fresh' next to ok:false. 'unconfigured' is the page's plain "未接入" label while
          // providerState still carries 手动查看 and the note keeps the setup text visible.
          state: isManual ? 'unconfigured' : 'fresh',
          fresh: !isManual,
          stale: false,
          fetchedAt: slot.record.fetchedAt,
          ...meta,
        };
        if (isManual) {
          entry.error = slot.record.note;
        } else if (isNotConfigured || isNotSubscribed) {
          entry.error = slot.record.note || slot.record.plan || '未订阅';
        } else if (unknownWithoutNumbers) {
          entry.error = slot.record.note || slot.record.plan || '状态未知';
        }
        if (slot.record.keyFrom) entry.keyFrom = slot.record.keyFrom;
        return entry;
      }
      return {
        ...base,
        ...numbers,
        ok: false,
        configured: true,
        // N7: a manual card has no automatic reading to go stale about — a re-read that has not settled (or
        // any later read) must not turn it into 数据已过期 with an empty card. It keeps its manual state and
        // note, exactly like a fresh manual card does.
        state: isManual ? 'unconfigured' : 'stale',
        fresh: false,
        stale: !isManual,
        error: isManual
          ? slot.record.note
          : (resultStale
            ? (slot.record.note || '数据可能已经过期')
            : (isNotConfigured || isNotSubscribed
              ? (slot.record.note || slot.record.plan || '未订阅')
              : (unknownWithoutNumbers
                ? (slot.record.note || slot.record.plan || '状态未知')
                : (refreshing ? timeoutNote : cooling ? coolingNote : '缓存已过期，正在后台重新读取')))),
        fetchedAt: slot.record.fetchedAt,
        ...meta,
        ...(slot.record.keyFrom ? { keyFrom: slot.record.keyFrom } : {}),
      };
    }
    if (slot.record) {
      const isManual = slot.record.providerState === 'manual_only';
      const windows = isManual ? [] : slot.record.windows;
      const numbers = {
        windows,
        balances: slot.record.balances,
        plan: slot.record.plan,
        note: slot.record.note,
        asOf: slot.record.asOf,
        ...(slot.record.providerState ? { providerState: slot.record.providerState } : {}),
        ...(slot.record.asOfDerived !== undefined ? { asOfDerived: slot.record.asOfDerived } : {}),
        ...(slot.record.isAvailable !== undefined ? { isAvailable: slot.record.isAvailable } : {}),
      };
      return {
        ...base, ...numbers, ok: false, configured: o.configured, state: 'stale', fresh: false, stale: true,
        error: o.error, ...(o.errorCode !== undefined ? { errorCode: o.errorCode } : {}), fetchedAt: slot.record.fetchedAt, ...meta,
        ...(o.keyFrom || slot.record.keyFrom ? { keyFrom: o.keyFrom || slot.record.keyFrom } : {}),
      };
    }
    const entry = { ...base, ...empty(), ok: false, configured: o.configured, state: o.kind, fresh: false, stale: false, error: o.error, ...(o.errorCode !== undefined ? { errorCode: o.errorCode } : {}), fetchedAt: iso(slot.attemptedAt), ...meta };
    if (o.keyFrom) entry.keyFrom = o.keyFrom;
    return entry;
  }

  async function report({ refresh = false, provider = null } = {}) {
    if (provider !== null && (typeof provider !== 'string' || !providerIds.includes(provider))) {
      throw new RangeError(`未知的 provider id：${String(provider)}`);
    }
    // A targeted call (provider set) only ever starts or waits for that one id. Every other provider is
    // display-only here: its cache may be fresh, expired or still unresolved, but this request neither
    // begins a read for it nor waits on one already running.
    const targeted = provider !== null;
    const plan = providersList.map((def) => {
      const slot = slotOf(def);
      if (targeted && def.id !== provider) {
        return { def, slot, attempt: null, cooling: false };
      }
      const manual = refresh === true;
      let attempt = slot.inflight;
      let cooling = false;
      if (!attempt) {
        const dueForAuto = !manual && !isFresh(slot);
        if (manual || dueForAuto) {
          // The cooldown gates any new read regardless of what triggered it: a plain GET landing right
          // after a manual refresh must not bypass the cooldown that refresh just started.
          const t = clock();
          // A backward clock jump (t before lastRefreshAt) must not extend the cooldown until the wall clock
          // catches back up to where it was — the elapsed time since the last refresh is unknowable in that
          // case, so the cooldown is treated as already satisfied rather than frozen for however long the
          // clock rolled back.
          if (slot.lastRefreshAt === null || t < slot.lastRefreshAt || t - slot.lastRefreshAt >= cooldownMs) {
            if (manual) slot.lastRefreshAt = t;
            attempt = begin(def, slot);
          } else {
            cooling = true;
          }
        }
      }
      return { def, slot, attempt, cooling };
    });
    const entries = await Promise.all(plan.map(async ({ def, slot, attempt, cooling }) => {
      if (attempt) await waitWithin(attempt);
      return display(def, slot, { cooling });
    }));
    return { generatedAt: iso(clock()), providers: entries };
  }

  return { report, listProviderIds: () => [...providerIds] };
}
