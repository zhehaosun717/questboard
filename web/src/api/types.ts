// The shape of the board server's JSON (see src/core/snapshot.js and src/server/questRoutes.js).
// Components depend on these types, never on raw fetch results.

export type QuestKind = 'code' | 'review' | 'art' | 'tool' | 'owner';

export type QuestStatus =
  | 'posted' | 'dispatched' | 'delivered' | 'reviewing' | 'needs_owner' | 'owner_playtest' | 'lane_limited'
  | 'bounced' | 'failed' | 'stalled' | 'done' | 'superseded' | 'cancelled';

export type CardStatus = 'available' | 'limited' | 'broke' | 'paused' | 'disabled';

export interface Assignee {
  adventurerId: string;
  family: string | null;
  lane: string;
  model: string;
  variant: string;
  name: string;
  at: string;
  by: string;
  adopted?: boolean;
  requestKey?: string;
}

export interface Ruling {
  at: string;
  by: string;
  text: string;
  question: string;
}

export interface Quest {
  id: string;
  kind: QuestKind;
  status: QuestStatus;
  title: string;
  brief: string;
  priority: 1 | 2 | 3;
  parents: string[];
  conflicts: string[];
  allowedLanes: string[];
  needsOwner: string;
  reviewPage: string;
  assignee: Assignee | null;
  dispatches: Assignee[];
  rulings: Ruling[];
  files: string[];
  lastDetail?: string;
  postedBy?: string;
  // Bumped on every server-side change; send it back as ifRevision so a write to a changed quest is refused.
  revision?: number;
  createdAt: string;
  updatedAt: string;
}

// Owner-driven correction of a posted quest's own descriptive fields (POST /api/quests/:id/metadata,
// src/core/metadataUpdate.js METADATA_FIELDS). A field left out is never touched by the server.
export interface MetadataUpdateInput {
  title?: string;
  brief?: string;
  parents?: string[];
  conflicts?: string[];
  allowedLanes?: string[];
  needsOwner?: string;
}

export interface Card {
  id: string;
  name: string;
  provider: string;
  lane: string;
  model: string;
  family: string;
  variant?: string;
  agent?: string;
  billing?: 'subscription' | 'plan' | 'payg' | 'free';
  maxParallel?: number;
  strengths?: string[];
  notes?: string;
  // Non-secret values passed to this card's lane command (a base URL, an account id), so one generic lane can
  // serve several providers. Keys belong in the machine environment; the server refuses key-shaped values.
  env?: Record<string, string>;
  status: CardStatus;
  statusSince: string | null;
  statusReason: string;
  statusSetBy: string | null;
  derived?: { from: 'lanes'; reason: string };
}

export interface Reason {
  code: string;
  message: string;
}

export interface Verdict {
  ok: boolean;
  reasons: Reason[];
}

export interface LiveWorker {
  state: string;
  elapsed: number;
  edits: number;
  lastText: string;
  tokens: { input: number; output: number } | null;
}

export interface ThreadLink {
  id: string;
  title: string;
  closed: boolean;
  messageCount: number;
  updatedAt: string;
}

export interface ReviewPage {
  page: string | null;
  title: string;
  url: string;
  total: number;
  answered: number;
  error?: string;
}

export interface UnpostedBrief {
  package: string;
  brief: string;
  title: string;
  writtenAt: string;
}

// A file discovery looked at and did not surface as an UnpostedBrief, and why. title/writtenAt are only
// present for a "soft" reason (already dispatched elsewhere, older than the window, or a superseded
// duplicate) — those are the ones a viewer may choose to reveal anyway; "already posted", an unrecognized
// file name, an oversized file and an unreadable one never carry them, since there is nothing useful (or,
// for oversized, nothing safe) to show for a file that cannot become an unposted brief either way.
export type BriefExclusionKind = 'badId' | 'unreadable' | 'oversized' | 'posted' | 'dispatched' | 'old' | 'symlink' | 'duplicate';

export interface BriefExclusion {
  package?: string;
  brief: string;
  title?: string;
  writtenAt?: string;
  reason: string;
  kind: BriefExclusionKind;
}

export interface BriefDiscoveryError {
  folder: string;
  reason: string;
}

// Diagnostics behind unpostedBriefs, so an empty shelf reads as "nothing new" and not as "discovery is
// broken": when it last scanned, which folders and recency window applied, and every skipped file's reason
// (capped at MAX_EXCLUDED rows — excluded is only a slice). byKind is counted server-side from every
// exclusion before that cap, so a folder with more skipped files than the cap never reads as "0 old, 0
// dispatched" just because none of those rows happened to survive it.
export interface BriefDiscovery {
  scannedAt: string;
  folders: string[];
  recentDays: number;
  excluded: BriefExclusion[];
  excludedTotal: number;
  excludedTruncated: boolean;
  byKind: Partial<Record<BriefExclusionKind, number>>;
  errors: BriefDiscoveryError[];
  truncated: boolean;
}

export interface VerificationStep {
  name: string;
  kind: 'exit' | 'errorCS' | 'done';
  value: string;
}

export interface Verification {
  steps: VerificationStep[];
  done: boolean;
  editXml: { total: number; passed: number; failed: number } | null;
  playXml: { total: number; passed: number; failed: number } | null;
}

export interface Snapshot {
  generatedAt: string;
  // id is the stable, opaque project digest (src/core/snapshot.js projectId). Optional: an older server
  // sends no id, and readers must not fall back to `name` as a storage namespace — same-name projects
  // on the same port share one browser storage.
  project: { name: string; id?: string; lanes: string[] };
  quests: Quest[];
  roster: Card[];
  eligibility: Record<string, Record<string, Verdict>>;
  // For delivered and reviewing quests: may this card review the work? A drop on returned work sends a review.
  // Optional: the web build is served from disk and can be newer than the running server, which then sends
  // no such field until it restarts. Readers treat it as "nobody may review yet" instead of crashing.
  reviewEligibility?: Record<string, Record<string, Verdict>>;
  env: { treeLocked: boolean };
  live: Record<string, LiveWorker>;
  threads: Record<string, ThreadLink[]>;
  reviewPages: ReviewPage[];
  unpostedBriefs: UnpostedBrief[];
  verification: Verification | null;
  laneLimits: Record<string, { since: string; until: string | null }>;
  openQuestions: number;
  // Optional: an older server sends none, and the shelf then shows only the plain unpostedBriefs list, same
  // as before this field existed.
  briefDiscovery?: BriefDiscovery;
}

// Message board (src/server/boardStore.js). Thread lists carry no messages; a single thread does.
export interface Thread {
  id: string;
  title: string;
  tags: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  closed: boolean;
  messageCount: number;
  lastMessageAt: string | null;
}

export interface Message {
  id: string;
  threadId: string;
  body: string;
  author: string;
  createdAt: string;
}

export interface ThreadDetail extends Thread {
  messages: Message[];
}

export type ThreadStatusFilter = 'open' | 'all' | 'closed';

// Dispatch history (src/lanes/collector.js via GET /api/lanes).
export type LaneHistoryEntry =
  | { at: string; event: 'dispatch'; lane: string; model: string }
  | { at: string; event: 'note'; text: string };

export interface LanePackage {
  package: string;
  lane: string;
  model: string;
  variant: string;
  name: string;
  session: string | null;
  dispatchedAt: string;
  elapsed: number;
  state: string;
  reason: string;
  stale: boolean;
  edits: number;
  editLabel?: string;
  tokens: { input: number; output: number } | null;
  toolCounts?: Record<string, number>;
  lastText: string;
  bounceUntil: string | null;
  modelSource?: 'session' | 'inferred';
  history: LaneHistoryEntry[];
}

export interface LanesReport {
  packages: LanePackage[];
  laneLimits: Record<string, { since: string; until: string | null }>;
  verification: Verification | null;
  generatedAt?: string;
  board: { openQuestions: number };
}

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
  amount: number;
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
}

export interface UsageReport {
  generatedAt: string;
  providers: UsageProvider[];
}

// Roster writes: the facts of a card, without the status fields the server adds.
export type AdventurerInput = Omit<Card, 'status' | 'statusSince' | 'statusReason' | 'statusSetBy' | 'derived'>;

// OMO model assignments (src/integrations/omo.js).
export type OmoSection = 'agents' | 'categories';

export interface OmoEntry {
  name: string;
  model: string;
  reasoning: string;
}

export interface OmoConfig {
  available: boolean;
  file: string;
  agents: OmoEntry[];
  categories: OmoEntry[];
}

export interface OmoChange extends OmoEntry {
  section: OmoSection;
}

// Settings (src/server/settingsRoutes.js). Key sources are booleans; keys never leave the server.
export interface SettingsReport {
  project: {
    name: string;
    root: string;
    port: number;
    paths: { data: string; events: string; registry: string; lock: string };
    briefs: { dispatchDirs: string[]; ownerDirs: string[]; recentDays: number };
    reviewPagesDir: string | null;
    lanes: Array<{ id: string; run: string[]; outputDir: string | null; api: string | null; serve: string[] | null; serialize: boolean; defaultModel: string | null }>;
    policy: { bannedModelPatterns: string[]; bannedAgents: string[] };
  };
  // questboard.config.json exactly as written — what the settings page edits. `project` above is the resolved
  // view (absolute paths, compiled patterns) and cannot be written back.
  raw: Record<string, unknown> | null;
  home: { dir: string; roster: string; rosterExists: boolean; status: string };
  usageKeys: Array<{ id: string; name: string; sources: Array<{ kind: 'env' | 'opencode'; name: string; present: boolean }> }>;
  openCodeAuthFile: { file: string; exists: boolean };
  omo: { file: string; exists: boolean };
}

// A server lane as the running board sees it (src/core/laneServer.js): whether its server answers, and the
// command the board would start it with (null when the config has none).
export interface LaneServerStatus {
  id: string;
  api: string;
  serve: string[] | null;
  up: boolean;
}

export interface QuestEvent {
  at: string;
  event: string;
  package: string;
  lane: string | null;
  model: string | null;
  variant: string | null;
  name: string | null;
  by: string;
  detail: string;
  // The ordered event id from the events file. Present on every event a current server sends; missing on an
  // older one, which is how the web side knows it cannot deduplicate and keeps notifications switched off
  // (see lib/notifications).
  seq?: number;
}
