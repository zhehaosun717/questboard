// Lanes domain: live workers, project verification, lane limits/evidence and dispatch history.
// Split out of api/types.ts; that file is now a re-export barrel for all of these domain files.

export interface LiveWorker {
  state: string;
  elapsed: number;
  edits: number;
  lastText: string;
  tokens: { input: number; output: number } | null;
  // FB2-10 item 2 (sync.js liveByName): file lanes report the .out mtime, session lanes the last message time.
  lastActivityMs?: number;
  heartbeat?: WorkerHeartbeat | null;
}

export interface WorkerHeartbeat {
  at: string;
  ageMs: number;
  token: string;
  phase: string;
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
  heartbeat?: WorkerHeartbeat | null;
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

// A server lane as the running board sees it (src/core/laneServer.js): whether its server answers, and the
// command the board would start it with (null when the config has none).
export interface LaneServerStatus {
  id: string;
  api: string;
  serve: string[] | null;
  up: boolean;
}
