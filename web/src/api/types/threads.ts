// Message board and the shelf surfaces beside it: threads, review pages and unposted-brief discovery.
// Split out of api/types.ts; that file is now a re-export barrel for all of these domain files.

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
