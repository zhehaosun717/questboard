// Quest domain: the quest record and everything hanging off one attempt - assignment, rulings,
// acceptance, report/evidence and the on-demand detail shape.
// Split out of api/types.ts; that file is now a re-export barrel for all of these domain files.

import type { LiveWorker } from './lanes';
import type { ThreadLink } from './threads';

export type QuestKind = 'code' | 'review' | 'art' | 'tool' | 'owner';

export type QuestStatus =
  | 'posted' | 'dispatched' | 'delivered' | 'reviewing' | 'needs_owner' | 'owner_playtest' | 'lane_limited'
  | 'needs_coordinator' | 'owner_ruled'
  | 'bounced' | 'failed' | 'stalled' | 'done' | 'superseded' | 'cancelled';

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
  result: 'pending' | 'never_started' | 'stopped_by_wrapper' | 'stopped_by_api' | 'manual_required' | 'unknown';
  resolvedAt?: string;
  detail?: string;
  deadlineAt?: string;
  instanceId?: string;
  adapter?: string;
  resultAt?: string;
  resultInstanceId?: string;
}

export interface ManualResolution {
  actorSource: 'ui' | 'cli' | 'mcp' | 'unknown';
  attempt: { attemptId: string | null; name: string | null; lane: string | null; at: string | null };
  time: string;
  reason: string | null;
  scope: 'manual';
}

// FB2-02: the current attempt immutable annotation capture (src/core/annotationSnapshot.js);
// the card chip reads the count from here.
export interface AnnotationSnapshotRef {
  page: string;
  title: string;
  count: number;
  capturedAt: string;
  digest: string;
  path: string;
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
  annotationSnapshot?: AnnotationSnapshotRef;
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
  // FB2-03 pre-dispatch gates: a hold with its reason parks the quest, needs lists the capabilities a
  // card+lane must declare, supersedes/supersededBy record the replacement relation, filesOverride is an
  // explicit file set that wins over brief extraction. All absent (or empty) on quests that never set them.
  hold?: string;
  needs?: string[];
  supersedes?: string[];
  supersededBy?: string;
  filesOverride?: string[];
  // Detail-route only (FB2-02 item 6): the review-page annotation summary; null/absent elsewhere.
  annotationSummary?: { page: string; total?: number; pass?: number; fail?: number; fix?: number; other?: number; first?: { verdict: string; note: string }[]; error?: string } | null;
  assignee: Assignee | null;
  dispatches: Assignee[];
  rulings: Ruling[];
  files: string[];
  lastDetail?: string;
  // FB2-04 item 4: when the quest entered its current status (store.js statusAt); the check column's
  // wait time is counted from it. Absent on quests written before this field existed.
  statusAt?: string;
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
  // Feedback 15: present only once a done transition carried a validated acceptance record; an older server,
  // or a done quest accepted before this field existed, simply has none.
  acceptance?: Acceptance;
  // Suggestion S3: present only once someone has recorded an exception to this review quest's own
  // upstream-evidence refusal (POST .../review-override). Absent on every other quest and on an older server.
  reviewOverride?: ReviewOverride;
}

export type AcceptanceActor = 'owner' | 'coordinator';

// One current-attempt evidence item (src/core/evidence.js EvidenceItem) an acceptance named — kind/digest/
// attemptId are what the server matched against, `ref` is carried along for display only.
export interface AcceptanceEvidenceRef {
  kind: EvidenceKind;
  ref: string | null;
  digest: string | null;
  attemptId: string | null;
}

export interface Acceptance {
  actor: AcceptanceActor;
  evidenceRefs: AcceptanceEvidenceRef[];
  note?: string;
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
