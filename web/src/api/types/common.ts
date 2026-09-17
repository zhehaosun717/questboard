// Cross-cutting shapes shared across the board API: a verdict and its pieces, and one events-file row.
// Split out of api/types.ts; that file is now a re-export barrel for all of these domain files.

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
