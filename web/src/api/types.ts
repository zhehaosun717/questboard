// The shape of the board server's JSON (see src/core/snapshot.js and src/server/questRoutes.js).
// Components depend on these types, never on raw fetch results.

export type QuestKind = 'code' | 'review' | 'art' | 'tool' | 'owner';

export type QuestStatus =
  | 'posted' | 'dispatched' | 'delivered' | 'reviewing' | 'needs_owner' | 'owner_playtest' | 'lane_limited'
  | 'bounced' | 'failed' | 'stalled' | 'done' | 'superseded' | 'cancelled';

export type CardStatus = 'available' | 'limited' | 'broke' | 'paused' | 'disabled';

export interface RoleCardRef {
  path: string;
  digest: string;
}

export interface CancelRequest {
  requestId: string;
  attemptId: string | null;
  at: string;
  bySource: 'ui' | 'cli' | 'mcp' | 'limit';
  reason: string;
  result: 'pending' | 'never_started' | 'stopped_by_wrapper' | 'manual_required' | 'unknown';
  resolvedAt?: string;
  detail?: string;
}

export interface ManualResolution {
  actorSource: 'ui' | 'cli' | 'mcp' | 'unknown';
  attempt: { attemptId: string | null; name: string | null; lane: string | null; at: string | null };
  time: string;
  reason: string | null;
  scope: 'manual';
}

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
  phase?: string;
  cancelRequest?: CancelRequest;
  roleCard?: RoleCardRef;
}

export interface Ruling {
  at: string;
  by: string;
  text: string;
  question: string;
}

// Suggestion S3 (src/core/store.js recordReviewOverride): a recorded exception to a review quest's own
// upstream-evidence refusal. Never marks any evidence as passed — it only lets a review the check would
// otherwise refuse proceed anyway, with why on record. Bound to the parents' current attempt ids at the
// moment it was recorded; see UpstreamReview.override.valid for whether it still covers them.
export interface ReviewOverride {
  reason: string;
  by: string;
  at: string;
  parentAttempts: Record<string, string | null>;
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
  // Pruned reference/verdict for the quest's CURRENT dispatch attempt (src/core/reportEvidence.js
  // reportSnapshot, feedback 7/12/34). Present only once an actual report file was found — a quest with no
  // attempt, a stale attempt, or an attempt that left nothing readable simply has no `report` field, and an
  // older server never sends one either; readers must keep showing the pre-existing receipt for those.
  // Never carries the report text or summary — see QuestReportDetail for the on-demand detail-route shape.
  report?: QuestReportSnapshot;
  postedBy?: string;
  // Bumped on every server-side change; send it back as ifRevision so a write to a changed quest is refused.
  revision?: number;
  createdAt: string;
  updatedAt: string;
  cancelRequest?: CancelRequest;
  manualResolution?: ManualResolution | null;
  roleCard?: RoleCardRef;
  // Suggestion S3: present only once someone has recorded an exception to this review quest's own
  // upstream-evidence refusal (POST .../review-override). Absent on every other quest and on an older server.
  reviewOverride?: ReviewOverride;
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
  variants?: string[];
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

export interface VerdictWarning {
  code: string;
  message: string;
}

export interface Verdict {
  ok: boolean;
  reasons: Reason[];
  warnings?: VerdictWarning[];
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
  // Structured bounce code (feedback 38 policy.bouncePatterns): present when this entry matched a configured
  // pattern instead of the built-in usage-limit detection. Absent for older servers.
  code?: string;
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
  // Structured bounce code, same as LaneLimitCardEntry.code (feedback 38).
  code?: string;
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
  // Owner preferences from policy.defaultLane/defaultCard (feedback 38); optional — an older server sends none.
  preferences?: { defaultLane: string | null; defaultCard: string | null; defaultCardMissing: boolean };
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
  // Structured bounce code when this live row was matched by a configured policy.bouncePatterns entry
  // (feedback 38); absent for older servers and for the built-in usage-limit path.
  code?: string;
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
    // Additive policy fields (feedback 38); bouncePatterns are compiled on the server (RegExp serializes as {}) so the form edits the raw file through `raw` instead.
    policy: {
      bannedModelPatterns: string[];
      bannedAgents: string[];
      stallAfterMinutes?: number;
      laneConcurrency?: Record<string, number>;
      defaultLane?: string | null;
      defaultCard?: string | null;
    };
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

// Roster batch operations (POST /api/roster/bulk/{preview,apply}). Env values are accepted by the server but
// intentionally do not appear in any response shape; changedFields/preservedFields are the preview contract.
export type RosterBulkStatus = Extract<CardStatus, 'available' | 'limited' | 'paused'>;

export interface RosterBulkEnvPatch {
  set?: Record<string, string>;
  remove?: string[];
}

export interface RosterBulkPatch {
  action?: 'update' | 'delete';
  delete?: boolean;
  status?: RosterBulkStatus | { status: RosterBulkStatus; reason?: string };
  reason?: string;
  // Empty variant is an explicit clear; omit variant from the patch when it should remain unchanged.
  variant?: string;
  env?: RosterBulkEnvPatch;
  removeEnv?: string[];
}

export interface RosterBulkRequest {
  ids: string[];
  patch: RosterBulkPatch;
  actor?: string;
  revision?: string;
  fingerprint?: string;
}

export interface RosterBulkResult {
  id: string;
  ok: boolean;
  ready: boolean;
  denied: boolean;
  changedFields: string[];
  preservedFields: string[];
  reasons?: Reason[];
  error?: string;
  partial?: boolean;
  appliedFields?: string[];
}

export interface RosterBulkCounts {
  requested: number;
  ready: number;
  changed: number;
  unchanged: number;
  denied: number;
  failed: number;
  partial: number;
}

export interface RosterBulkResponse {
  ok: boolean;
  applied?: boolean;
  ids: string[];
  action: 'update' | 'delete';
  actor: string;
  revision: string;
  fingerprint: string;
  changedFields: string[];
  preservedFields: string[];
  deniedActiveCards: Array<{ id: string; reasons?: Reason[] }>;
  statusNote: string;
  backup?: boolean;
  results: RosterBulkResult[];
  counts: RosterBulkCounts;
}

// Feedback 11: an art redo posted from the 评审 view, bound to one explicit review page id. Sent to the same
// POST /api/quests the CLI and MCP use; the page id travels with the quest so a dispatch cannot bind the
// wrong image.
export interface ArtRedoRequest {
  package: string;
  brief: string;
  kind: 'art';
  reviewPage: string;
}

export interface ArtRedoResponse {
  quest: Quest;
}

// Report evidence (feedback 7/12/34, src/core/reportEvidence.js). A dispatch attempt's own final report,
// resolved only through the lane's configured directories — never a caller-supplied path.
export type ReportSource = 'delivery' | 'exit-file' | 'summary';

// The exact-uppercase `VERDICT: PASS|PASS WITH FINDINGS|FAIL` line found in a report read in full — never
// from a truncated read or a `.out` transcript, both of which are always 'unknown' with a reason.
// `PASS WITH FINDINGS` (the review template's third choice) is stored as 'findings' (R2-2), sharing its name
// with the web-only tail-parse fallback in lib/evidence.ts ReviewVerdict.
export type ReportVerdictValue = 'PASS' | 'FAIL' | 'findings' | 'unknown';

// snapshot.quests[].report (src/core/reportEvidence.js reportSnapshot) — see the `report` field on Quest
// above for when this is present.
export interface QuestReportSnapshot {
  source: ReportSource;
  ref: string;
  digest: string;
  bytes: number;
  sizeBytes: number;
  truncated: boolean;
  capturedAt: string;
  attemptId: string | null;
  verdict: ReportVerdictValue;
  // Present only when verdict is 'unknown' and the backend has a specific reason (a truncated read, or a
  // `.out` transcript, which never carries a verdict). A plain "no VERDICT line found" carries no reason.
  verdictReason?: string;
}

// The first heading and the first complete paragraph or findings item after it (src/core/reportEvidence.js
// summarizeReport): kept on source line boundaries, so it never begins or ends mid-word.
export interface ReportSummary {
  heading: string | null;
  paragraph: string | null;
  hasMore: boolean;
}

export interface ReportVerdictDetail {
  verdict: ReportVerdictValue;
  line: string | null;
  position: number | null;
  reason?: string;
}

// GET /api/quests/:id .quest.report (src/server/questRoutes.js questReportView): the unpruned reference for
// the quest's current attempt, meant to be fetched on demand — never part of the snapshot fan-out. null (on
// the parent `quest.report` field of the detail response) means there is no current attempt at all; a
// resolved value with source:'none' means an attempt happened but left nothing readable, and `reason`
// explains why.
export interface QuestReportDetail {
  source: ReportSource | 'none';
  ref: string | null;
  digest: string | null;
  bytes: number;
  sizeBytes: number;
  truncated: boolean;
  capturedAt: string;
  attemptId: string | null;
  name: string | null;
  lane: string | null;
  at: string | null;
  reason?: string;
  verdict?: ReportVerdictDetail;
  summary?: ReportSummary;
}

// Suggestion S2 (src/core/evidence.js questEvidence): structured, attempt-bound evidence for a quest's
// CURRENT dispatch attempt. Ordered report, project-verification, hook. `bound: false` means the item is a
// real record but belongs to an earlier attempt (or, for project-verification, cannot be confirmed current) —
// it is shown, never dropped, and must never be styled as if it passed.
export type EvidenceKind = 'report' | 'project-verification' | 'hook';
export type EvidenceState =
  | 'passed' | 'findings' | 'failed' | 'unknown' | 'missing' | 'not_configured'
  | 'queued' | 'running' | 'timedout';

export interface EvidenceItem {
  kind: EvidenceKind;
  label: string;
  state: EvidenceState;
  source: string | null;
  ref: string | null;
  digest: string | null;
  capturedAt: string | null;
  attemptId: string | null;
  bound: boolean;
  reason?: string;
  // hook items only (kind === 'hook'): the PM brief's own field names, alongside the generic
  // source/ref/digest/capturedAt above (source mirrors commandRef, ref mirrors logPath, digest mirrors
  // logDigest) so a kind-agnostic renderer and a hook-specific one can both read the same item.
  commandRef?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  exitCode?: number | null;
  logPath?: string | null;
  logDigest?: string | null;
}

export interface QuestEvidence {
  version: number;
  attemptId: string | null;
  attemptAt: string | null;
  // Additive (F6): the current attempt's worker name, so the drawer can show who ran it instead of only the
  // attemptId UUID. Optional so an older server that predates this field renders exactly as before.
  attemptName?: string | null;
  items: EvidenceItem[];
}

// Suggestion S3 (src/core/rules.js reviewUpstreamEvidence): one non-review parent's classified
// current-attempt evidence, the required kinds it fails (if any), and whether it leaves a gap — no actual
// project test (project-verification or hook) has passed for it, whatever the model's own report claims.
export type UpstreamEvidenceKind = 'report' | 'project-verification' | 'hook';
export type UpstreamEvidenceState = 'passed' | 'failed' | 'stale' | 'missing' | 'not_configured' | 'unknown';

export interface UpstreamParent {
  id: string;
  attemptId: string | null;
  states: Record<UpstreamEvidenceKind, UpstreamEvidenceState>;
  failing: UpstreamEvidenceKind[];
  gap: boolean;
  text: string;
}

// GET /api/quests/:id .quest.upstreamReview (src/core/rules.js reviewUpstreamEvidence, S3): null for
// anything but a review quest. Drives the drawer's own 上游证据 block, independently of which card (if any)
// is selected and of the per-adventurer eligibility warnings the drop preview already shows.
export interface UpstreamReview {
  required: UpstreamEvidenceKind[];
  parents: UpstreamParent[];
  failingParents: string[];
  blocked: boolean;
  override: (Pick<ReviewOverride, 'reason' | 'by' | 'at'> & { valid: boolean }) | null;
}

// GET /api/quests/:id (src/server/questRoutes.js): the snapshot's quest row enriched with the worker's live
// output, linked threads, grouped eligibility and the unpruned report reference. Fetched on demand by the
// receipt (see api/client.ts `api.questDetail`), never polled.
export interface QuestDetail extends Omit<Quest, 'report' | 'roleCard'> {
  live: LiveWorker | null;
  threads: ThreadLink[];
  eligibility: { canTake: string[]; refused: Record<string, string[]> };
  report: QuestReportDetail | null;
  // Optional: an older server sends no `evidence` field at all, and readers must render exactly as before
  // this field existed (the section hides itself) rather than treat a missing field as an empty items list.
  evidence?: QuestEvidence;
  roleCard?: RoleCardRef | null;
  // Optional (S3): an older server sends no `upstreamReview` field at all; readers treat a missing field the
  // same as one that resolved to null (nothing to show), never as an empty/passing report.
  upstreamReview?: UpstreamReview | null;
}

// GET /api/quests/:id/report success body (src/server/questRoutes.js), assembled client-side from the
// plain-text response and its headers.
export interface ReportText {
  text: string;
  truncated: boolean;
  digest: string | null;
}
