// Provider usage (src/usage/service.js via GET /api/usage).
// Split out of api/types.ts; that file is now a re-export barrel for all of these domain files.

// Usage (src/usage/service.js via GET /api/usage). The accepted contract today only has the fields above
// `fetchedAt`: ok/configured/error/windows/balances/plan/note/asOf. Everything from `state` down mirrors a
// richer per-provider state machine (pending/fresh/stale/unconfigured/unavailable/expired/failed, real
// lastSuccessAt distinct from attemptedAt, per-provider cooldown) that the backend has since accepted
// (c90311f) — still optional here so this view degrades to the accepted shape against an older backend
// that predates it, rather than assuming every field is present.
export interface UsageWindow {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  state?: 'reset';
  resetDerived?: boolean;
}

export interface UsageBalance {
  currency: string;
  // Optional since feedback 36 (F4): an adapter that only knows whether the balance can be used
  // (e.g. DeepSeek without a read key) may report availability with no amount. Missing is not 0,
  // and the UI must not fake one.
  amount?: number;
  isAvailable?: boolean | null;
  granted?: number;
  toppedUp?: number;
}

export type UsageProviderState = 'pending' | 'fresh' | 'stale' | 'unconfigured' | 'unavailable' | 'expired' | 'failed';

export interface UsageProvider {
  id: string;
  name: string;
  source: 'local-log' | 'api' | 'cli' | 'local-app' | 'official-api' | 'official-cli' | 'official-hook' | 'undocumented-api' | 'manual';
  ok: boolean;
  // false when the provider is not set up on this machine (no key, no log) or not supported yet; null when
  // that fact itself is not known yet (a first read still pending) — treating null the same as false would
  // flash "not configured" on every cold load (see lib/usage.ts usageStateInfo).
  configured: boolean | null;
  // Free text from the adapter/backend. Never rendered as-is: an old backend can put an upstream error —
  // sentinels, a stray Referer, an arbitrary-length body — straight into this field, so the UI only ever
  // shows its own fixed Chinese text chosen from `state` (and `errorCode` below). See lib/usage.ts
  // providerGuidanceText.
  error?: string;
  // A small, closed vocabulary of known-safe reasons the backend may report (e.g. 'missing_key'). Unlike
  // `error`, an unrecognized value here is simply ignored rather than shown — the UI never displays the
  // code itself, only a fixed message it already owns for the codes it recognizes.
  errorCode?: string;
  keyFrom?: string;
  windows: UsageWindow[];
  balances: UsageBalance[];
  plan: string;
  note: string;
  asOf: string | null;
  // null only while a provider's first read is still in flight (state 'pending') and the backend genuinely
  // has no time to report yet — never a stand-in for "unknown" on any other state. See usageValidation.ts.
  fetchedAt: string | null;
  // Optional / WIP backend fields — see comment above.
  state?: UsageProviderState;
  fresh?: boolean;
  stale?: boolean;
  refreshing?: boolean;
  cooling?: boolean;
  attemptedAt?: string | null;
  lastSuccessAt?: string | null;
  lastRefreshAt?: string | null;
  providerState?: 'ok' | 'not_subscribed' | 'unknown' | 'manual_only';
  asOfDerived?: boolean;
  access?: string;
  credentialType?: string;
  docsUrl?: string;
  setupCommand?: string;
  // Balance availability for adapters that only expose usability (DeepSeek). true/false are facts;
  // null and an absent field both mean "not known" and must never render as 不可用.
  isAvailable?: boolean | null;
}

export interface UsageReport {
  generatedAt: string;
  providers: UsageProvider[];
}
