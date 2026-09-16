import type { UsageProvider, UsageProviderState } from '../api/types';

/**
 * The only code that reads a raw `GET /api/usage` body. A 200 response is not automatically trustworthy:
 * an old or misbehaving backend can send `null`, `{}`, a `providers` field that is not an array, or a
 * provider entry missing fields the rest of this view assumes exist. None of that may crash React or wipe
 * a report that used to have real numbers in it — so every field is checked before it is allowed anywhere
 * near a component.
 *
 * Two levels of failure are handled differently, on purpose:
 * - The whole body is unusable (not an object, no `providers` array) → the caller treats this like a
 *   failed fetch and keeps the previous report untouched (see usageCache.ts).
 * - One provider entry in an otherwise-usable array is malformed → only that entry is affected. If a
 *   previous good reading for the same id exists, its numbers are kept and shown as `stale` (visibly old,
 *   never silently replaced by garbage); otherwise a minimal `failed` placeholder is synthesized so the
 *   grid still renders one card per known id instead of a hole or a crash.
 */

const KNOWN_STATES: ReadonlySet<UsageProviderState> = new Set([
  'pending',
  'fresh',
  'stale',
  'unconfigured',
  'unavailable',
  'expired',
  'failed',
]);

/** Same closed-set treatment for the provider fact carried alongside the cache state (feedback 36): an
 * unrecognized providerState stays out rather than reaching a label lookup or a class name. */
const KNOWN_PROVIDER_STATES: ReadonlySet<string> = new Set([
  'ok',
  'not_subscribed',
  'unknown',
  'manual_only',
]);

export interface ValidatedUsageReport {
  generatedAt: string;
  providers: UsageProvider[];
  // The raw `providers` array's own length, before per-entry sanitization -- lets a caller tell a
  // legitimately empty report (server sent `providers: []` as-is) apart from a non-empty array that
  // degenerated to zero usable entries because every item was garbage (`[null]`, entries with no usable
  // id, ...). The two must not be treated the same way by an untargeted (authoritative) merge: see
  // usageCache.ts applySuccess.
  rawProviderCount: number;
  // True when at least one raw entry either had to be dropped outright (not a record, or no usable id) or
  // fell back to a stale/failed placeholder because a required field was missing. A caller merging this
  // report as the authoritative full set must not treat such a response as proof that every id absent from
  // it is actually gone -- see usageCache.ts applyValidatedReport, which only deletes untouched ids when
  // this is false.
  hadMalformedEntries: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** `usedPercent` distinguishes a real 0% from "unknown" (see formatPercentOrUnknown) — a value that is
 * present but not a finite number is neither, so it degrades to "unknown" rather than invalidating the
 * whole provider over one bad number. */
function sanitizeWindows(raw: unknown): UsageProvider['windows'] {
  if (!Array.isArray(raw)) return [];
  const out: UsageProvider['windows'] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const label = asString(item.label);
    if (label === undefined) continue;
    const usedPercentRaw = item.usedPercent;
    const usedPercent = usedPercentRaw === null ? null : (asFiniteNumber(usedPercentRaw) ?? null);
    const resetsAt = asStringOrNull(item.resetsAt) ?? null;
    // 'reset' is the only window state the backend may report (feedback 36): the window was reset and has
    // no reading until the next use. Anything else in the field stays out, same as unknown provider states.
    const state: 'reset' | undefined = item.state === 'reset' ? 'reset' : undefined;
    const resetDerived = asBoolean(item.resetDerived);
    out.push({
      label,
      usedPercent,
      resetsAt,
      ...(state !== undefined ? { state } : {}),
      ...(resetDerived !== undefined ? { resetDerived } : {}),
    });
  }
  return out;
}

function sanitizeBalances(raw: unknown): UsageProvider['balances'] {
  if (!Array.isArray(raw)) return [];
  const out: UsageProvider['balances'] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const currency = asString(item.currency);
    const amount = asFiniteNumber(item.amount);
    const granted = asFiniteNumber(item.granted);
    const toppedUp = asFiniteNumber(item.toppedUp);
    const isAvailableRaw = item.isAvailable;
    const isAvailable = isAvailableRaw === null ? null : asBoolean(isAvailableRaw);
    // Feedback 36 (F4): an adapter (DeepSeek) may report availability or a granted/topped-up split with no
    // total amount — that is still a real reading, and requiring `amount` silently hid the balance. What is
    // still dropped: an item with no currency, or one carrying no usable data at all.
    const hasFunds = amount !== undefined || granted !== undefined || toppedUp !== undefined;
    if (currency === undefined || (!hasFunds && isAvailable === undefined)) continue;
    out.push({
      currency,
      ...(amount !== undefined ? { amount } : {}),
      ...(granted !== undefined ? { granted } : {}),
      ...(toppedUp !== undefined ? { toppedUp } : {}),
      ...(isAvailable !== undefined ? { isAvailable } : {}),
    });
  }
  return out;
}

/** A minimal, renderable stand-in for a provider entry that failed validation and has no previous good
 * reading to fall back to. Carries no numbers because none can be trusted. */
function failedPlaceholder(id: string, raw: Record<string, unknown>): UsageProvider {
  return {
    id,
    name: asString(raw.name) ?? id,
    source: 'api',
    ok: false,
    configured: null,
    windows: [],
    balances: [],
    plan: '',
    note: '',
    asOf: null,
    fetchedAt: new Date().toISOString(),
    state: 'failed',
  };
}

interface SanitizedEntry {
  provider: UsageProvider | null;
  // See ValidatedUsageReport.hadMalformedEntries: true for anything dropped outright or downgraded to a
  // stale/failed fallback, false only for an entry that passed structural validation as-is.
  malformed: boolean;
}

function sanitizeProviderEntry(
  raw: unknown,
  previousById: ReadonlyMap<string, UsageProvider>,
): SanitizedEntry {
  if (!isRecord(raw)) return { provider: null, malformed: true };
  const id = asString(raw.id);
  if (!id) return { provider: null, malformed: true }; // no stable identity to key a card (or a fallback) on — cannot be rendered at all

  const name = asString(raw.name);
  const source = asString(raw.source);
  const ok = asBoolean(raw.ok);
  const configuredRaw = raw.configured;
  const configured = configuredRaw === null ? null : asBoolean(configuredRaw);
  const plan = asString(raw.plan);
  const note = asString(raw.note);
  // The backend legitimately sends `fetchedAt: null` only while a provider's first read is still pending
  // (`state: 'pending'`) — it has nothing genuine to report yet and must not invent a time. A null
  // `fetchedAt` on any other (or missing) state is a shape the backend cannot produce, so it still fails
  // structural validation below and falls through to the previous-good/failed-placeholder path.
  const fetchedAt = raw.fetchedAt === null && raw.state === 'pending' ? null : asString(raw.fetchedAt);
  const asOf = asStringOrNull(raw.asOf);
  // The key must be present, not merely optional-defaulting-to-empty: an entry that omits `windows`/
  // `balances` entirely is not a legitimate "this provider currently has nothing to show" reading, it is a
  // malformed entry that happens to render as one -- missing required arrays are not a valid reading. A
  // present-but-wrong-typed value (e.g. a string) still passes here and is sanitized down to `[]` below,
  // same as before -- only an actually-missing field fails structural validity and falls through to the
  // previous-good/failed-placeholder path instead of quietly becoming "fresh" with nothing to show.
  const windowsOk = raw.windows !== undefined;
  const balancesOk = raw.balances !== undefined;

  const structurallyValid =
    name !== undefined &&
    source !== undefined &&
    ok !== undefined &&
    configured !== undefined &&
    plan !== undefined &&
    note !== undefined &&
    fetchedAt !== undefined &&
    asOf !== undefined &&
    windowsOk &&
    balancesOk;

  if (!structurallyValid) {
    const previous = previousById.get(id);
    // Retain the last good reading, visibly marked stale, rather than either crashing or quietly showing
    // whatever partial/garbage numbers happened to be in this malformed response.
    if (previous) return { provider: { ...previous, state: 'stale' }, malformed: true };
    return { provider: failedPlaceholder(id, raw), malformed: true };
  }

  const state = asString(raw.state);
  const errorCode = asString(raw.errorCode);
  const keyFrom = asString(raw.keyFrom);
  const attemptedAt = raw.attemptedAt === undefined ? undefined : asStringOrNull(raw.attemptedAt);
  const lastSuccessAt = raw.lastSuccessAt === undefined ? undefined : asStringOrNull(raw.lastSuccessAt);
  const lastRefreshAt = raw.lastRefreshAt === undefined ? undefined : asStringOrNull(raw.lastRefreshAt);
  const refreshing = asBoolean(raw.refreshing);
  const cooling = asBoolean(raw.cooling);
  // Feedback 36: provider-level facts the card renders as their own labels. Everything here is optional on
  // the wire (old backends send none of it), so each field degrades to "not known" instead of failing the
  // entry — only genuinely present-but-wrong types are dropped.
  const providerStateRaw = asString(raw.providerState);
  const providerState = KNOWN_PROVIDER_STATES.has(providerStateRaw ?? '')
    ? (providerStateRaw as UsageProvider['providerState'])
    : undefined;
  const asOfDerived = asBoolean(raw.asOfDerived);
  const isAvailableRaw = raw.isAvailable;
  const isAvailable = isAvailableRaw === null ? null : asBoolean(isAvailableRaw);
  const access = asString(raw.access);
  const credentialType = asString(raw.credentialType);
  const docsUrl = asString(raw.docsUrl);
  const setupCommand = asString(raw.setupCommand);

  return {
    provider: {
      id,
      name,
      // `source` mirrors an open string union on the wire; an unrecognized value still renders (see
      // formatSourceLabel's fallback), so it is passed through rather than treated as invalid.
      source: source as UsageProvider['source'],
      ok,
      configured,
      // Deliberately NOT copying `raw.error` here: nothing downstream is allowed to read it, so it is
      // dropped at the boundary instead of merely being ignored by convention.
      errorCode,
      keyFrom,
      windows: sanitizeWindows(raw.windows),
      balances: sanitizeBalances(raw.balances),
      plan,
      note,
      asOf,
      fetchedAt,
      state: state && KNOWN_STATES.has(state as UsageProviderState) ? (state as UsageProviderState) : undefined,
      refreshing,
      cooling,
      attemptedAt,
      lastSuccessAt,
      lastRefreshAt,
      // Feedback 36 additions; conditional spreads keep old-shaped entries identical so existing consumers
      // (and tests) never see new undefined-valued keys appear on providers that lack them.
      ...(providerState !== undefined ? { providerState } : {}),
      ...(asOfDerived !== undefined ? { asOfDerived } : {}),
      ...(isAvailable !== undefined ? { isAvailable } : {}),
      ...(access !== undefined ? { access } : {}),
      ...(credentialType !== undefined ? { credentialType } : {}),
      ...(docsUrl !== undefined ? { docsUrl } : {}),
      ...(setupCommand !== undefined ? { setupCommand } : {}),
    },
    malformed: false,
  };
}

export function validateUsageReport(
  raw: unknown,
  previousProviders: readonly UsageProvider[],
): ValidatedUsageReport | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.providers)) return null;
  const previousById = new Map(previousProviders.map((p) => [p.id, p] as const));
  const providers: UsageProvider[] = [];
  let hadMalformedEntries = false;
  for (const entry of raw.providers) {
    const { provider, malformed } = sanitizeProviderEntry(entry, previousById);
    if (malformed) hadMalformedEntries = true;
    if (provider) providers.push(provider);
  }
  return {
    generatedAt: asString(raw.generatedAt) ?? '',
    providers,
    rawProviderCount: raw.providers.length,
    hadMalformedEntries,
  };
}
