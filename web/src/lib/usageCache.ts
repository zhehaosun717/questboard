import type { UsageProvider, UsageReport } from '../api/types';
import { classifyFetchFailure, USAGE_ERROR_TEXT, type UsageFetcher } from './usageClient';
import { validateUsageReport } from './usageValidation';

/**
 * The last usage report, kept outside React and keyed by scope (see buildUsageScopeKey). Switching tabs
 * unmounts UsageView — without a store living outside the component the page starts from an empty state
 * every time, and StrictMode's double-mount or a fast remount during a pending fetch would fire the request
 * twice. This module survives all of that; the component only subscribes to it.
 *
 * Scope matters because the same browser can point at different board servers over time (a different
 * project's server on the same port, or the same server after the owner switches project). Nothing here may
 * assume that a same-origin server later on is the same provider home as before, so callers must build the
 * scope key from the server's own opaque project id when one is available.
 *
 * This module also owns the request-ordering and busy-state machinery: every attempt (whole-report or
 * single-provider) is assigned a strictly increasing sequence number when it starts. That same number
 * decides two independent things later:
 * - which attempt currently "owns" a key's busy flag / inflight slot, so a stale (superseded) completion —
 *   including one released early by the timeout watchdog — can never clear a newer attempt's busy state or
 *   overwrite it with its own error ("a stale completion cannot clear new busy/error");
 * - whether a given provider's incoming data is actually newer than what is already applied, so a
 *   slow "refresh all" cannot stomp a faster single-provider result that already landed (the out-of-order
 *   case).
 */
export const USAGE_MAX_AGE_MS = 5 * 60 * 1000;
export const USAGE_COOLDOWN_MS = 15 * 1000;
// Bounded network wait per attempt: abort at this point, then give the transport a grace window to
// actually settle before giving up on it from the UI's point of view.
export const USAGE_REQUEST_TIMEOUT_MS = 20 * 1000;
export const USAGE_ABORT_GRACE_MS = 5 * 1000;

// Until the backend declares a real capability/contract signal, a targeted single-provider refresh cannot
// be told apart from a legacy backend that silently reads every provider for any refresh=1 request.
// Assuming support without that signal would be guessing a capability from brand/state, which is not
// acceptable -- so this stays false until a real field exists for a caller to read, at which point this
// constant is the one place to change.
export const USAGE_TARGETED_REFRESH_SUPPORTED = false;

export function buildUsageScopeKey(origin: string, projectId: string | null | undefined): string {
  return projectId ? `${origin}::${projectId}` : `${origin}::(unscoped)`;
}

export interface UsageSnapshot {
  report: UsageReport | null;
  fetchedAt: number | null;
  globalError: string | null;
  refreshingAll: boolean;
}

export const EMPTY_USAGE_SNAPSHOT: UsageSnapshot = { report: null, fetchedAt: null, globalError: null, refreshingAll: false };

interface ScopeState {
  report: UsageReport | null;
  fetchedAt: number | null;
  globalError: string | null;
  refreshingAll: boolean;
  refreshingProviders: Set<string>;
  lastAttemptAll: number | null;
  lastAttemptProvider: Map<string, number>;
  inflightAll: Promise<boolean> | null;
  inflightProvider: Map<string, Promise<boolean>>;
  subscribers: Set<() => void>;
  // useSyncExternalStore requires getSnapshot to return the same reference until something actually
  // changes — a fresh object literal on every read would loop React forever. This is recomputed only in
  // `commit`, right before notifying subscribers.
  snapshot: UsageSnapshot;
  // Monotonic counter; every attempt (all or per-provider) is assigned the next value when it starts.
  requestSeq: number;
  // Which attempt currently owns each key's busy/error state ('' for refresh-all).
  ownerSeqAll: number;
  ownerSeqProvider: Map<string, number>;
  // The seq whose data was last actually applied to each provider id, so an older attempt's result for
  // that same id is recognized as superseded and dropped instead of overwriting newer data. A deletion
  // (a provider dropped by an untargeted merge) is recorded here too, as a tombstone, instead of being
  // removed from the map -- see applyValidatedReport.
  appliedSeqByProvider: Map<string, number>;
  // The largest seq that has changed the report so far; gates fetchedAt/globalError so a slow, older
  // attempt settling after a faster newer one cannot move the "as of" clock backwards.
  lastAppliedSeq: number;
  // Seqs that forceRelease gave up on before their underlying fetch ever settled (timeout + ignored abort).
  // Their eventual outcome — success or failure — must never touch visible state once abandoned: the UI
  // already told the owner it failed, and only a fresh manual attempt (a new seq) may speak for this key
  // again. Entries are removed once that late outcome is actually observed.
  abandonedSeqs: Set<number>;
  // Key ('' for refresh-all, else a provider id) -> the seq that forceRelease abandoned it on. While a key
  // is blocked, an automatic (countsAsAttempt:false) refreshUsage call for it is a no-op instead of piling
  // another request on top of one whose real fate is still unknown; a manual call always clears the block.
  blockedUntilManual: Map<string, number>;
}

function computeSnapshot(scope: ScopeState): UsageSnapshot {
  return { report: scope.report, fetchedAt: scope.fetchedAt, globalError: scope.globalError, refreshingAll: scope.refreshingAll };
}

function emptyScope(): ScopeState {
  return {
    report: null,
    fetchedAt: null,
    globalError: null,
    refreshingAll: false,
    refreshingProviders: new Set(),
    lastAttemptAll: null,
    lastAttemptProvider: new Map(),
    inflightAll: null,
    inflightProvider: new Map(),
    subscribers: new Set(),
    snapshot: EMPTY_USAGE_SNAPSHOT,
    requestSeq: 0,
    ownerSeqAll: 0,
    ownerSeqProvider: new Map(),
    appliedSeqByProvider: new Map(),
    lastAppliedSeq: 0,
    abandonedSeqs: new Set(),
    blockedUntilManual: new Map(),
  };
}

const scopes = new Map<string, ScopeState>();

function ensure(scopeKey: string): ScopeState {
  let scope = scopes.get(scopeKey);
  if (!scope) {
    scope = emptyScope();
    scopes.set(scopeKey, scope);
  }
  return scope;
}

/** Recomputes the cached snapshot and notifies subscribers. Every mutation to report/fetchedAt/globalError/
 * refreshingAll must go through this so getUsageSnapshot's reference only changes when the data did. */
function commit(scope: ScopeState): void {
  scope.snapshot = computeSnapshot(scope);
  for (const listener of scope.subscribers) listener();
}

/** Test-only: drops every scope's state so suites start clean without one leaking into the next. */
export function clearUsageScopes(): void {
  scopes.clear();
}

export function subscribeUsage(scopeKey: string, listener: () => void): () => void {
  const scope = ensure(scopeKey);
  scope.subscribers.add(listener);
  return () => {
    scope.subscribers.delete(listener);
  };
}

/** Read-only view for useSyncExternalStore. Never creates a scope, so a plain read cannot leak an empty
 * entry into the store for a scope nobody has actually loaded. Returns the scope's cached snapshot object
 * unchanged when nothing has happened, which is what lets useSyncExternalStore skip a re-render. */
export function getUsageSnapshot(scopeKey: string): UsageSnapshot {
  return scopes.get(scopeKey)?.snapshot ?? EMPTY_USAGE_SNAPSHOT;
}

export function isRefreshingProvider(scopeKey: string, providerId: string): boolean {
  return scopes.get(scopeKey)?.refreshingProviders.has(providerId) ?? false;
}

/** A result younger than maxAgeMs is shown as is. A clock that jumped backwards counts as stale. */
export function isFresh(at: number | null, now: number, maxAgeMs: number = USAGE_MAX_AGE_MS): boolean {
  if (at === null) return false;
  const age = now - at;
  return age >= 0 && age < maxAgeMs;
}

/** Milliseconds left before `key` ("" for refresh-all, else a provider id) may be refreshed by hand again.
 * This is only a client-side hint to grey out a button early — the server is the real authority and answers
 * a too-soon manual refresh with its own cooling state/message rather than trusting the client's clock.
 *
 * A backwards clock jump (`now < last`) is rebased, not just clamped: clamping `cooldownMs - (now - last)`
 * to `cooldownMs` alone still recomputes the same full-window value on every call for as long as `now`
 * stays behind `last` — an hour-long rollback would hold the button at "15s left" for the whole hour
 * instead of counting down. The first read after a rollback is observed moves `last` back to that `now`, so
 * the cooldown restarts from the rollback point and then counts down normally as the (rolled-back) clock
 * keeps advancing — a rollback followed by 20s of further advancement becomes usable again, same as a real
 * 15s wait would. */
export function cooldownRemainingMs(
  scopeKey: string,
  key: string,
  now: number,
  cooldownMs: number = USAGE_COOLDOWN_MS,
): number {
  const scope = scopes.get(scopeKey);
  if (!scope) return 0;
  const last = key === '' ? scope.lastAttemptAll : (scope.lastAttemptProvider.get(key) ?? null);
  if (last === null || last === undefined) return 0;
  if (now < last) {
    if (key === '') scope.lastAttemptAll = now;
    else scope.lastAttemptProvider.set(key, now);
    return cooldownMs;
  }
  return Math.max(0, cooldownMs - (now - last));
}

function nextSeq(scope: ScopeState): number {
  scope.requestSeq += 1;
  return scope.requestSeq;
}

function ownerSeq(scope: ScopeState, providerId: string | undefined): number {
  return providerId ? (scope.ownerSeqProvider.get(providerId) ?? 0) : scope.ownerSeqAll;
}

function keyOf(providerId: string | undefined): string {
  return providerId ?? '';
}

/** True once forceRelease has given up on `seq` for this key without ever seeing it actually settle. Any
 * outcome that later arrives for an abandoned seq is a confirmed-but-ignored-abort completion: real, but no
 * longer allowed to speak for this key (see applySuccess/applyFailure). */
function isAbandoned(scope: ScopeState, seq: number): boolean {
  return scope.abandonedSeqs.has(seq);
}

/** Called once an abandoned attempt's own promise actually settles (success or failure) — the underlying
 * request is now confirmed finished, whatever it returned. This clears the seq's abandoned marker and, if
 * nothing has manually retried in the meantime, lifts the auto-retry block so the interval timer may resume
 * on its own schedule again instead of staying blocked forever waiting for a manual click. */
function resolveAbandoned(scope: ScopeState, providerId: string | undefined, seq: number): void {
  scope.abandonedSeqs.delete(seq);
  const key = keyOf(providerId);
  if (scope.blockedUntilManual.get(key) === seq) scope.blockedUntilManual.delete(key);
}

/** Merges validated providers into the scope's report, keyed by id, gated per-provider by `seq` so an
 * older attempt's result for a given id never overwrites a newer one that already landed. A targeted
 * request, or any response that had malformed entries (`canDelete: false`), only ever touches the ids
 * actually present in its response, so it can never blank out the other, untouched cards even if the
 * backend returns fewer entries than expected. Only a clean, fully-valid, untargeted "refresh all" is
 * treated as authoritative for the whole set (`canDelete: true`): an id missing from it is dropped, unless
 * a still-newer attempt (higher seq) already updated that id more recently, in which case this older full
 * response has nothing useful to say about it and leaves it alone. */
function applyValidatedReport(
  scope: ScopeState,
  validated: { generatedAt: string; providers: UsageProvider[] },
  seq: number,
  now: number,
  options: { canDelete: boolean; malformedWarning: string | null },
): void {
  const { canDelete, malformedWarning } = options;
  const byId = new Map((scope.report?.providers ?? []).map((p) => [p.id, p] as const));
  const order = [...byId.keys()];
  const incomingIds = new Set<string>();
  for (const incoming of validated.providers) {
    incomingIds.add(incoming.id);
    const applied = scope.appliedSeqByProvider.get(incoming.id) ?? 0;
    if (seq <= applied) continue;
    if (!byId.has(incoming.id)) order.push(incoming.id);
    byId.set(incoming.id, incoming);
    scope.appliedSeqByProvider.set(incoming.id, seq);
  }
  if (canDelete) {
    for (const id of [...byId.keys()]) {
      if (incomingIds.has(id)) continue;
      const applied = scope.appliedSeqByProvider.get(id) ?? 0;
      if (applied > seq) continue;
      byId.delete(id);
      const idx = order.indexOf(id);
      if (idx !== -1) order.splice(idx, 1);
      // Tombstone, not delete: recording this id as "removed at `seq`" (rather than dropping it from the
      // map) means a still-older, late-arriving response for the same id -- e.g. a slow targeted refresh
      // that was in flight before this removal happened -- reads `applied` as this deletion's seq and is
      // correctly recognized as stale (`seq <= applied` above), instead of seeing an absent entry, assuming
      // it is new, and resurrecting a card this scope already dropped.
      scope.appliedSeqByProvider.set(id, seq);
    }
  }
  const isNewest = seq > scope.lastAppliedSeq;
  scope.report = {
    generatedAt: isNewest ? validated.generatedAt : (scope.report?.generatedAt ?? validated.generatedAt),
    providers: order.map((id) => byId.get(id)).filter((p): p is UsageProvider => Boolean(p)),
  };
  if (isNewest) {
    scope.lastAppliedSeq = seq;
    scope.fetchedAt = now;
    scope.globalError = malformedWarning;
  }
}

/** Returns whether this attempt is now fully confirmed (a clean, wholly valid response was applied) — a
 * caller such as UsageView's initial-mount check needs this to tell "this scope's data is now proven
 * current" apart from any weaker outcome (malformed partial data merged, or nothing usable at all). */
function applySuccess(scope: ScopeState, raw: unknown, seq: number, now: number, providerId: string | undefined): boolean {
  if (isAbandoned(scope, seq)) {
    // A late, confirmed completion for an attempt the UI already told the owner had timed out. Only a
    // fresh manual retry (a new seq) may update this key's state now -- see forceRelease and
    // resolveAbandoned. Still worth noting the underlying request did eventually finish, so auto-refresh
    // may resume on its own schedule.
    resolveAbandoned(scope, providerId, seq);
    return false;
  }
  const validated = validateUsageReport(raw, scope.report?.providers ?? []);
  if (!validated) {
    // The body itself is unusable (not an object, no providers array): behave like a failed fetch and
    // keep whatever report is already cached instead of replacing it with nothing.
    if (seq > scope.lastAppliedSeq) {
      scope.lastAppliedSeq = seq;
      scope.globalError = USAGE_ERROR_TEXT.malformed;
    }
    return false;
  }
  const isTargeted = Boolean(providerId);
  // A response with malformed entries -- a non-empty raw `providers` array that degenerated to fewer
  // usable entries than it sent (`[null]`, an entry missing an id, one missing a required array, ...) --
  // is not proof that every id absent from it is actually gone. Only a clean, fully-valid, untargeted
  // response may delete untouched ids (see applyValidatedReport's `canDelete`); a malformed one still has
  // its valid entries merged in (partial update, same as a targeted response), and the previously-good
  // cards it says nothing trustworthy about are left exactly as they were, with a malformed-response
  // warning surfaced instead of silently dropping them. A genuinely empty report (`rawProviderCount === 0`,
  // the server explicitly said zero providers, nothing malformed) is unaffected and still replaces the
  // whole set as usual.
  const isMalformedUntargeted = !isTargeted && validated.hadMalformedEntries;
  applyValidatedReport(scope, validated, seq, now, {
    canDelete: !isTargeted && !validated.hadMalformedEntries,
    malformedWarning: isMalformedUntargeted ? USAGE_ERROR_TEXT.malformed : null,
  });
  return !validated.hadMalformedEntries;
}

function applyFailure(scope: ScopeState, err: unknown, providerId: string | undefined, seq: number): void {
  if (isAbandoned(scope, seq)) {
    resolveAbandoned(scope, providerId, seq);
    return;
  }
  if (ownerSeq(scope, providerId) !== seq) return; // superseded: a newer attempt already owns this key
  scope.globalError = classifyFetchFailure(err);
}

/** Releases a key's busy state without waiting any further for its transport to settle. Used when the
 * timeout's own abort didn't cause the fetch promise to reject within a grace window (an ignored-abort
 * fetcher). This attempt is now abandoned, not merely idle: its eventual outcome — success or failure — is
 * recorded via abandonedSeqs and must never touch visible state again (applySuccess/applyFailure both check
 * this), and the key is blocked from an *automatic* (interval-timer) retry until either a manual attempt
 * explicitly overrides the block or the abandoned promise is actually confirmed to have settled (see
 * resolveAbandoned) — otherwise every missed interval tick would quietly stack another hung request on top
 * of one whose fate is still unknown ("no unlimited auto replacements while the underlying request is
 * unconfirmed"). A manual retry is always allowed through immediately: the owner clicking again is the
 * explicit confirmation to try once more despite the earlier one still possibly running server-side.
 *
 * Releasing the busy state here is separate from settling the *promise refreshUsage handed back to its
 * caller* — see the watchdog in refreshUsage, which settles that promise itself right after calling this,
 * instead of leaving the caller waiting on a transport that may never settle at all. */
function forceRelease(scope: ScopeState, providerId: string | undefined, seq: number): void {
  if (ownerSeq(scope, providerId) !== seq) return;
  if (providerId) {
    scope.refreshingProviders.delete(providerId);
    scope.inflightProvider.delete(providerId);
  } else {
    scope.refreshingAll = false;
    scope.inflightAll = null;
  }
  scope.abandonedSeqs.add(seq);
  scope.blockedUntilManual.set(keyOf(providerId), seq);
  scope.globalError = USAGE_ERROR_TEXT.timeout;
  commit(scope);
}

export interface RefreshOptions {
  refresh?: boolean;
  providerId?: string;
  now?: number;
  // False for the bounded auto-refresh timer: it must not consume or gate the manual cooldown, since the
  // two are meant to run independently ("no spending manual cooldown on the auto timer").
  countsAsAttempt?: boolean;
  timeoutMs?: number;
  graceMs?: number;
}

/** Fetches the full report (optionally scoped to one provider) and merges the result in. Safe to call
 * repeatedly for the same key: an attempt already in flight is shared rather than duplicated. Resolves to
 * whether this attempt actually applied a clean, wholly-trustworthy response (see applySuccess) — `false`
 * covers every other outcome (an HTTP/network failure, a malformed body, or a watchdog release) without
 * ever rejecting, so a caller can safely branch on the boolean instead of needing its own try/catch. */
export function refreshUsage(scopeKey: string, fetcher: UsageFetcher, options: RefreshOptions = {}): Promise<boolean> {
  const {
    refresh = true,
    providerId,
    now = Date.now(),
    countsAsAttempt = true,
    timeoutMs = USAGE_REQUEST_TIMEOUT_MS,
    graceMs = USAGE_ABORT_GRACE_MS,
  } = options;
  const scope = ensure(scopeKey);

  if (providerId) {
    const existing = scope.inflightProvider.get(providerId);
    if (existing) return existing;
  } else if (scope.inflightAll) {
    return scope.inflightAll;
  }

  const key = keyOf(providerId);
  if (!countsAsAttempt && scope.blockedUntilManual.has(key)) {
    // The last attempt for this key was force-released without ever confirming it actually finished
    // server-side. An automatic call (the interval timer) must not quietly start another one on top of it
    // — only a manual retry (countsAsAttempt: true, below) or the abandoned attempt's own late, confirmed
    // settlement (resolveAbandoned) may lift this.
    return Promise.resolve(false);
  }
  scope.blockedUntilManual.delete(key); // a manual call is an explicit override of any prior block

  const seq = nextSeq(scope);
  if (providerId) scope.ownerSeqProvider.set(providerId, seq);
  else scope.ownerSeqAll = seq;

  if (countsAsAttempt) {
    if (providerId) scope.lastAttemptProvider.set(providerId, now);
    else scope.lastAttemptAll = now;
  }
  if (providerId) scope.refreshingProviders.add(providerId);
  else scope.refreshingAll = true;
  commit(scope);

  const controller = new AbortController();
  let settled = false;
  // The promise this function hands back must settle even when the transport itself never does (a fetcher
  // that ignores AbortSignal forever): a caller such as UsageView's mount effect awaits this to decide
  // whether the scope is now verified, and an unsettled `await` there would leave that UI stuck forever.
  // `publicPromise` is deliberately a different object from the raw fetch chain below: the watchdog settles
  // it immediately on release, while the underlying fetch keeps running in the background so its eventual,
  // late outcome can still be recorded (and fenced off from visible state -- see isAbandoned) once it
  // actually arrives. It only ever resolves, never rejects, matching the doc comment above.
  let publicSettled = false;
  let resolvePublic: (value: boolean) => void = () => {};
  const publicPromise = new Promise<boolean>((resolve) => {
    resolvePublic = resolve;
  });
  const settlePublic = (value: boolean) => {
    if (publicSettled) return;
    publicSettled = true;
    resolvePublic(value);
  };

  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  const watchdog = setTimeout(() => {
    if (!settled) {
      forceRelease(scope, providerId, seq);
      settlePublic(false);
    }
  }, timeoutMs + graceMs);

  // Deliberately not stored anywhere the public API returns: this chain is fully self-contained (every
  // branch below is caught), so letting it run in the background after the watchdog has already settled
  // `publicPromise` can never produce an unhandled rejection.
  let succeeded = false;
  void fetcher({ refresh, providerId, signal: controller.signal })
    .then((raw) => {
      settled = true;
      clearTimeout(abortTimer);
      clearTimeout(watchdog);
      succeeded = applySuccess(scope, raw, seq, now, providerId);
    })
    .catch((err: unknown) => {
      settled = true;
      clearTimeout(abortTimer);
      clearTimeout(watchdog);
      applyFailure(scope, err, providerId, seq);
      succeeded = false;
    })
    .finally(() => {
      // A stale completion (superseded by forceRelease, or by nothing at all) must not clear a newer
      // attempt's busy flag or inflight slot.
      if (ownerSeq(scope, providerId) === seq) {
        if (providerId) {
          scope.refreshingProviders.delete(providerId);
          scope.inflightProvider.delete(providerId);
        } else {
          scope.refreshingAll = false;
          scope.inflightAll = null;
        }
        commit(scope);
      }
      // Settled last, and only after the state above is committed: a caller awaiting this promise must
      // never observe it resolve before getUsageSnapshot reflects what that resolution represents. Already
      // a no-op if the watchdog settled `publicPromise` first (see settlePublic's guard).
      settlePublic(succeeded);
    });

  if (providerId) scope.inflightProvider.set(providerId, publicPromise);
  else scope.inflightAll = publicPromise;
  return publicPromise;
}

/** Kicks off a load only when nothing is already in flight, the scope isn't cooling down from a recent
 * attempt, and (when `trustCache` is true) the cached report isn't already fresh. Safe to call on every
 * mount, including StrictMode's second one: the second call sees the first's inflight promise and does
 * nothing.
 *
 * `trustCache` is false for a scope with no server-provided project id ("(unscoped)"): the same bucket can
 * legitimately represent different servers over time, so a cached report is never assumed still valid just
 * because it is recent — every mount revalidates instead. The cooldown check still bounds how often that
 * revalidation actually hits the network, so this does not turn into a request per mount.
 *
 * Resolves the same way refreshUsage does (`true` only for a clean, fully-applied response) when a fetch
 * actually starts; `undefined` when nothing new was even attempted this call (cache trusted and fresh, or
 * still cooling down from a very recent prior attempt) -- a caller must not treat `undefined` as success:
 * it means this call proved nothing at all about whether the scope is current. */
export function ensureUsageLoaded(
  scopeKey: string,
  fetcher: UsageFetcher,
  now: number,
  options: { trustCache?: boolean } = {},
): Promise<boolean> | undefined {
  const { trustCache = true } = options;
  const scope = ensure(scopeKey);
  if (scope.inflightAll) return scope.inflightAll;
  if (trustCache && isFresh(scope.fetchedAt, now)) return undefined;
  if (scope.lastAttemptAll !== null && cooldownRemainingMs(scopeKey, '', now) > 0) return undefined;
  return refreshUsage(scopeKey, fetcher, { refresh: false, now });
}
