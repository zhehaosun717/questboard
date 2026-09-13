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
  createdAt: string;
  updatedAt: string;
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
  project: { name: string; lanes: string[] };
  quests: Quest[];
  roster: Card[];
  eligibility: Record<string, Record<string, Verdict>>;
  env: { treeLocked: boolean };
  live: Record<string, LiveWorker>;
  threads: Record<string, ThreadLink[]>;
  reviewPages: ReviewPage[];
  unpostedBriefs: UnpostedBrief[];
  verification: Verification | null;
  laneLimits: Record<string, { since: string; until: string | null }>;
  openQuestions: number;
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
}
