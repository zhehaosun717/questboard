// Roster domain: a card, its diagnostics and its writes (single-card input and the batch endpoints).
// Split out of api/types.ts; that file is now a re-export barrel for all of these domain files.

import type { Reason } from './common';

export type CardStatus = 'available' | 'limited' | 'broke' | 'paused' | 'disabled';

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
