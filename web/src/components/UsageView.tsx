import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  buildUsageScopeKey,
  cooldownRemainingMs,
  ensureUsageLoaded,
  EMPTY_USAGE_SNAPSHOT,
  getUsageSnapshot,
  isRefreshingProvider,
  refreshUsage,
  subscribeUsage,
  USAGE_TARGETED_REFRESH_SUPPORTED,
} from '../lib/usageCache';
import { fetchUsageReport } from '../lib/usageClient';
import { loadUsageRefreshPreference, saveUsageRefreshPreference, type UsageRefreshMode } from '../lib/usagePreference';
import { useT } from '../lib/i18n';
import '../styles/usage.css';
import { UsageControls } from './usage/UsageControls';
import { UsageProviderCard } from './usage/UsageProviderCard';

// Distinguishes "the board snapshot hasn't loaded yet" from "it loaded, and this server sent no project
// id" — collapsing those two into a single optional projectId prop (as this view used to take) meant a
// cold load fired one unscoped request before the id arrived, then a second, scoped one right after.
// App.tsx is the only caller and is expected to pass `{ loaded: false }` until its own snapshot exists.
export type UsageProjectScope = { loaded: false } | { loaded: true; projectId: string | null };

interface UsageViewProps {
  scope: UsageProjectScope;
}

export function UsageView({ scope }: UsageViewProps) {
  const t = useT();
  const projectId = scope.loaded ? scope.projectId : undefined;
  // Only a genuine, server-provided id lets this view trust a cached report across mounts; without one the
  // scope is a shared "(unscoped)" bucket that can legitimately belong to different servers over time (see
  // buildUsageScopeKey), so it is revalidated on every mount instead (still cooldown-bounded — U7/U8).
  const trustCache = scope.loaded && projectId != null;
  const scopeKey = useMemo(
    () => (scope.loaded ? buildUsageScopeKey(window.location.origin, projectId) : null),
    [scope.loaded, projectId],
  );

  const subscribe = useCallback(
    (listener: () => void) => (scopeKey ? subscribeUsage(scopeKey, listener) : () => {}),
    [scopeKey],
  );
  const getSnapshot = useCallback(() => (scopeKey ? getUsageSnapshot(scopeKey) : EMPTY_USAGE_SNAPSHOT), [scopeKey]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const [preference, setPreference] = useState(() => loadUsageRefreshPreference());
  const [now, setNow] = useState(() => Date.now());
  const [hidden, setHidden] = useState(() => document.hidden);
  // For an unscoped scope (server gave no project id), any report already sitting in the cache might belong
  // to a different server encountered earlier at the same browser origin (see buildUsageScopeKey — the
  // "(unscoped)" bucket is shared across whichever server happens to be there). A warning banner next to
  // the numbers is not provenance: only a THIS-mount request that actually succeeds and passes validation
  // proves the data is current, so the grid stays hidden until that specific outcome. A skipped attempt
  // (cooldown) or a failed one (HTTP error, malformed body, timeout) never proves the scope either way —
  // both land on 'unverifiable', an actionable dead end distinct from "still checking", never a silent
  // fall-through to whatever a different server's data happened to be sitting in the shared cache. Scoped
  // (trusted-cache) mounts have no such ambiguity and are considered confirmed immediately.
  type MountVerification = 'confirmed' | 'checking' | 'unverifiable';
  const [verification, setVerification] = useState<MountVerification>(trustCache ? 'confirmed' : 'checking');

  // Identifies the mount that a pending verification (initial or manual-retry) outcome is allowed to speak
  // for. A manual retry's own promise settles after render, by which point the scope may have switched (a
  // different project id arrived) or this view may have unmounted (tab switch) — either way `scopeKey`
  // captured in the closure is now stale and must not be allowed to set state for the *new* mount. Reused by
  // both the load effect below and startRefreshAll so a retry started just before a scope switch/unmount is
  // fenced off the same way the initial load already was.
  const activeMountRef = useRef<{ scopeKey: string; cancelled: boolean } | null>(null);

  // Loads once per scope: the first mount with a known scope, StrictMode's second mount (ensureUsageLoaded
  // no-ops against the first call's in-flight promise), and again whenever the scope itself changes (a
  // different project). Nothing fires while `scopeKey` is still null (snapshot not loaded yet).
  useEffect(() => {
    if (!scopeKey) return;
    const mount = { scopeKey, cancelled: false };
    activeMountRef.current = mount;
    if (trustCache) {
      setVerification('confirmed');
      void ensureUsageLoaded(scopeKey, fetchUsageReport, Date.now(), { trustCache });
      return () => {
        mount.cancelled = true;
      };
    }
    setVerification('checking');
    const pending = ensureUsageLoaded(scopeKey, fetchUsageReport, Date.now(), { trustCache });
    if (!pending) {
      // No new fetch actually started at all (an identical revalidation for this scope is still cooling
      // down from a very recent prior mount) — this mount has proven nothing about whether the cached data
      // still belongs here, so it cannot be shown; only an explicit retry (past the cooldown) can settle it.
      setVerification('unverifiable');
    } else {
      pending.then((succeeded) => {
        if (!mount.cancelled) setVerification(succeeded ? 'confirmed' : 'unverifiable');
      });
    }
    return () => {
      mount.cancelled = true;
    };
  }, [scopeKey, trustCache]);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const cooldownAll = scopeKey ? cooldownRemainingMs(scopeKey, '', now) : 0;

  // A once-a-second tick, only while it is actually needed to keep a cooldown countdown current — not a
  // permanent timer that re-renders the page every second while idle. It re-arms itself automatically: once
  // the countdown reaches 0 the effect below stops scheduling further ticks, and the click handlers
  // restart it by bumping `now` immediately on click.
  useEffect(() => {
    if (cooldownAll <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cooldownAll > 0]);

  // Bounded auto-refresh: only while the owner chose "interval" and the tab is actually visible. Every
  // dependency change tears this timer down and rebuilds it, so switching to manual or hiding the tab stops
  // it immediately instead of leaking a stale interval. Uses the server's own cache (refresh:false → the
  // fetcher sends refresh=0, never 1) and does not count as a manual attempt, so it can never itself trip
  // or consume the manual "refresh all" cooldown.
  useEffect(() => {
    if (!scopeKey || preference.mode !== 'interval' || hidden) return;
    const id = setInterval(() => {
      void refreshUsage(scopeKey, fetchUsageReport, { refresh: false, countsAsAttempt: false });
    }, preference.intervalMs);
    return () => clearInterval(id);
  }, [scopeKey, preference.mode, preference.intervalMs, hidden]);

  const handleModeChange = (mode: UsageRefreshMode) => {
    const next = { ...preference, mode };
    setPreference(next);
    saveUsageRefreshPreference(next);
  };
  const handleIntervalChange = (intervalMs: number) => {
    const next = { ...preference, intervalMs };
    setPreference(next);
    saveUsageRefreshPreference(next);
  };

  const startRefreshAll = () => {
    if (!scopeKey) return;
    const t = Date.now();
    setNow(t); // makes the new cooldown visible immediately, without waiting for the next 1s tick
    const mount = activeMountRef.current;
    void refreshUsage(scopeKey, fetchUsageReport, { refresh: true, now: t }).then((succeeded) => {
      // Trusted-cache scopes are already 'confirmed' and a failed manual refresh must not demote them to
      // 'unverifiable' — it keeps showing the last-good data with the existing error banner instead. Only an
      // unscoped mount's own verification state is driven by its manual retry outcome, and only for the
      // mount that is still current: a scope switch or unmount between the click and this settling must not
      // write into whatever mount (or scope) is active now.
      if (trustCache) return;
      if (!mount || mount.cancelled || mount.scopeKey !== scopeKey) return;
      setVerification(succeeded ? 'confirmed' : 'unverifiable');
    });
  };
  // Per-card refresh: until the backend declares real support for a targeted refresh, every card click
  // degrades to the same "refresh all" request as the header button (see USAGE_TARGETED_REFRESH_SUPPORTED
  // and lib/usage.ts USAGE_TARGETED_REFRESH_UNSUPPORTED_HINT).
  const startRefreshProvider = (providerId: string) => {
    if (!scopeKey) return;
    if (!USAGE_TARGETED_REFRESH_SUPPORTED) {
      startRefreshAll();
      return;
    }
    const t = Date.now();
    setNow(t);
    void refreshUsage(scopeKey, fetchUsageReport, { refresh: true, providerId, now: t });
  };

  // Keyboard focus is preserved per-button inside UsageProviderCard/UsageControls: they use aria-disabled
  // instead of the native `disabled` attribute, so a button the owner just activated with Enter stays
  // focusable throughout its refresh instead of the browser yanking focus to <body>. Nothing here moves
  // focus on mount.

  // Hidden, not merely captioned, until this specific mount's own revalidation has actually succeeded for
  // an unscoped scope (see the verification effect above) — the cached report may belong to a different
  // server, and a skipped or failed revalidation attempt proves nothing either way.
  const providers = verification === 'confirmed' ? (snapshot.report?.providers ?? []) : [];

  // One consolidated live region for the whole page instead of one per card: with a dozen provider cards
  // each announcing on every "refresh all", a screen reader user got a flood of simultaneous chatter, and
  // the error banner — the one thing that most needed announcing — was not a live region at all.
  const liveMessage = snapshot.globalError
    ? t('usage.loadFailed', { error: snapshot.globalError })
    : verification === 'unverifiable'
      ? t('usage.unverifiable')
      : hidden
        ? t('usage.autoPaused')
        : snapshot.refreshingAll
          ? t('usage.refreshingData')
          : '';

  return (
    <div className="usage-view-container">
      <header className="usage-view-header">
        <div>
          <span className="eyebrow">{t('usage.eyebrow')}</span>
          <h2>{t('usage.title')}</h2>
        </div>
        <UsageControls
          fetchedAt={snapshot.fetchedAt}
          refreshingAll={snapshot.refreshingAll}
          cooldownMs={cooldownAll}
          onRefreshAll={startRefreshAll}
          mode={preference.mode}
          intervalMs={preference.intervalMs}
          onModeChange={handleModeChange}
          onIntervalChange={handleIntervalChange}
          paused={hidden}
        />
      </header>

      <div className="usage-sr-only" role="status" aria-live="polite">
        {liveMessage}
      </div>

      {scope.loaded && projectId == null ? (
        <p className="hint usage-scope-warning">
          {t('usage.scopeWarning')}
        </p>
      ) : null}

      {/* Only shown once this mount has actually confirmed the data (verification === 'confirmed'): while
          unverifiable, the dedicated block below already carries its own explanation, including this same
          error text where one exists, so there is nothing left to say twice. */}
      {verification === 'confirmed' && snapshot.globalError ? (
        <div className="warn-tape usage-global-error">
          {t('usage.loadFailed', { error: snapshot.globalError })}
          {snapshot.report ? t('usage.previousResult') : ''}
        </div>
      ) : null}

      {!scope.loaded ? (
        <div className="hint usage-loading-hint">{t('usage.readingProject')}</div>
      ) : verification === 'checking' ? (
        <div className="hint usage-loading-hint">{t('usage.verifying')}</div>
      ) : verification === 'unverifiable' ? (
        <div className="warn-tape usage-verify-failed">
          {snapshot.globalError
            ? t('usage.verifyFailedWith', { error: snapshot.globalError })
            : t('usage.verifyFailed')}
        </div>
      ) : providers.length > 0 ? (
        <div className="usage-grid">
          {providers.map((provider) => (
            <UsageProviderCard
              key={provider.id}
              provider={provider}
              // Client bookkeeping is authoritative for "is a request in flight", never a server-reported
              // `refreshing` flag: while targeted refresh is unsupported every card's busy state mirrors
              // the shared "refresh all" attempt it actually triggers.
              refreshing={USAGE_TARGETED_REFRESH_SUPPORTED ? isRefreshingProvider(scopeKey ?? '', provider.id) : snapshot.refreshingAll}
              cooldownMs={USAGE_TARGETED_REFRESH_SUPPORTED ? cooldownRemainingMs(scopeKey ?? '', provider.id, now) : cooldownAll}
              onRefresh={() => startRefreshProvider(provider.id)}
            />
          ))}
        </div>
      ) : snapshot.refreshingAll ? (
        <div className="hint usage-loading-hint">{t('usage.reading')}</div>
      ) : (
        <div className="empty">{t('usage.empty')}</div>
      )}
    </div>
  );
}
