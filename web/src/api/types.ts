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
  // status/statusReason are the effective (overlaid) values. derived, when present, explains why they differ
  // from the manual layer below; at/resetsAt are null only when that time genuinely is not known (src/core/
  // overlay.js effectiveRoster). Never invent a countdown from a null resetsAt.
  derived?: { from: 'lanes'; reason: string; at: string | null; resetsAt: string | null };
  // Additive (feedback9 web slice, src/core/overlay.js withBase): the manual status-log layer underneath
  // `status`/`statusReason`. Seed edit forms from these, not from the possibly-derived `status`. Optional so
  // an older server (or a fixture that predates this field) still type-checks — treat a missing baseStatus
  // as "no derived layer", i.e. fall back to `status`/`statusReason`.
  baseStatus?: CardStatus;
  baseReason?: string;
  laneDiagnostics?: LaneDiagnostic[];
}

// Advisory only (src/core/overlay.js diagnostic): lane evidence that could not be attributed to one exact
// card. It never changes any card's status — it is shown next to the roster as a hint, never as a status.
export interface LaneDiagnostic {
  code: string;
  lane: string | null;
  model: string | null;
  package: string | null;
  at: string | null;
  message: string;
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

// laneLimits/laneEvidence shapes (src/core/overlay.js visibleLaneLimits, N15/N17): a lane-level claim that
// stays in lockstep with the per-card roster status, never a separate source of truth.
export interface LaneLimitCardEntry {
  since: string;
  at: string;
  until: string | null;
  resetsAt: string | null;
  adventurerId: string;
  name: string;
}

// snapshot.laneLimits[lane] / GET /api/lanes .laneLimits: present only while at least one roster card on
// this lane is effectively limited with an active (unknown or future reset) entry. The top-level fields are
// a copy of the newest kept card entry — read `cards` for the rest.
export interface LaneLimit extends LaneLimitCardEntry {
  cards: Record<string, LaneLimitCardEntry>;
}

export type LaneEvidenceClearedReason = 'owner' | 'status' | 'no_card';

export interface LaneEvidenceCardEntry extends LaneLimitCardEntry {
  // Present only for an entry dropped out of laneLimits — see LaneEvidenceClearedReason. Absent means the
  // entry's own known reset has simply passed. Word this neutrally in the UI (N16): `cleared: 'owner'` means
  // the card is no longer limited, not that the owner necessarily clicked anything.
  cleared?: LaneEvidenceClearedReason;
}

export interface LaneEvidenceUnidentified {
  since: string;
  at: string;
  until: string | null;
  resetsAt: string | null;
  name?: string;
}

// snapshot.laneEvidence[lane]: history/diagnostics only, never a limit. GET /api/lanes returns the raw
// collector field instead (no `cleared` entries — see N17), so treat `cleared` as optional everywhere this
// type is used.
export interface LaneEvidence {
  cards: Record<string, LaneEvidenceCardEntry>;
  unidentified: LaneEvidenceUnidentified[];
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
  laneLimits: Record<string, LaneLimit>;
  openQuestions: number;
  // Optional: an older server sends none, and the shelf then shows only the plain unpostedBriefs list, same
  // as before this field existed.
  briefDiscovery?: BriefDiscovery;
  // Additive (feedback9 web slice): history/diagnostics only (N17) — optional so an older server still
  // parses, in which case the history tab simply has nothing to show here.
  laneEvidence?: Record<string, LaneEvidence>;
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
  laneLimits: Record<string, LaneLimit>;
  verification: Verification | null;
  generatedAt?: string;
  board: { openQuestions: number };
  // Additive (feedback9 web slice, N17): the raw collector field, not filtered the way laneLimits is — an
  // entry dropped from laneLimits (owner/status/no_card) does not appear here, only an entry whose own known
  // reset has passed. Optional so an older server still parses.
  laneEvidence?: Record<string, LaneEvidence>;
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
    lanes: Array<{ id: string; run: string[]; outputDir: string | null; api: string | null; serve: string[] | null; serialize: boolean; defaultModel: string | null; optionalArgs?: OptionalArgGroup[] }>;
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

// Optional argument group for lanes (src/core/config.js).
export interface OptionalArgGroup {
  when: 'variant' | 'agent';
  args: string[];
  omitWhen?: string[];
  insertAt?: number;
  [key: string]: unknown;
}

export interface LanePreviewCard {
  model?: string;
  variant?: string;
  agent?: string;
}

export interface LanePreviewSample {
  name?: string;
  brief?: string;
  package?: string;
}

export interface LanePreviewRequest {
  lane: Record<string, unknown>;
  card?: LanePreviewCard;
  sample?: LanePreviewSample;
}

export interface LanePreviewOmitted {
  when: string;
  reason: string;
}

export interface LanePreviewResponse {
  argv: string[];
  omitted: LanePreviewOmitted[];
  warnings: string[];
}
