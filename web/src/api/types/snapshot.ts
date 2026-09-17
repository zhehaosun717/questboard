// The board snapshot: the one aggregate shape GET /api/snapshot answers with.
// Split out of api/types.ts; that file is now a re-export barrel for all of these domain files.

import type { Verdict } from './common';
import type { Quest } from './quests';
import type { Card } from './roster';
import type { LaneEvidence, LaneLimit, LiveWorker, Verification } from './lanes';
import type { BriefDiscovery, ReviewPage, ThreadLink, UnpostedBrief } from './threads';

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
