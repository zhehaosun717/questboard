// The shape of the board server's JSON (see src/core/snapshot.js and src/server/questRoutes.js).
// Components depend on these types, never on raw fetch results.
// Split by domain under ./types/; this file stays the barrel so every existing import keeps working.

export type {
  QuestKind, QuestStatus, RoleCardRef, CancelRequest, ManualResolution, Assignee, Ruling, ReviewOverride,
  Quest, AcceptanceActor, AcceptanceEvidenceRef, Acceptance, MetadataUpdateInput, ArtRedoRequest,
  ArtRedoResponse, ReportSource, ReportVerdictValue, QuestReportSnapshot, ReportSummary, ReportVerdictDetail,
  QuestReportDetail, EvidenceKind, EvidenceState, EvidenceItem, QuestEvidence, UpstreamEvidenceKind,
  UpstreamEvidenceState, UpstreamParent, UpstreamReview, QuestDetail, ReportText,
} from './types/quests';

export type {
  CardStatus, Card, LaneDiagnostic, AdventurerInput, OmoSection, OmoEntry, OmoConfig, OmoChange,
  RosterBulkStatus, RosterBulkEnvPatch, RosterBulkPatch, RosterBulkRequest, RosterBulkResult, RosterBulkCounts,
  RosterBulkResponse,
} from './types/roster';

export type {
  LiveWorker, WorkerHeartbeat, VerificationStep, Verification, LaneLimitCardEntry, LaneLimit,
  LaneEvidenceClearedReason, LaneEvidenceCardEntry, LaneEvidenceUnidentified, LaneEvidence, LaneHistoryEntry,
  LanePackage, LanesReport, LaneServerStatus,
} from './types/lanes';

export type {
  SettingsReport, OptionalArgGroup, LanePreviewCard, LanePreviewSample, LanePreviewRequest, LanePreviewOmitted,
  LanePreviewResponse,
} from './types/settings';

export type { UsageWindow, UsageBalance, UsageProviderState, UsageProvider, UsageReport } from './types/usage';

export type {
  ThreadLink, ReviewPage, UnpostedBrief, BriefExclusionKind, BriefExclusion, BriefDiscoveryError,
  BriefDiscovery, Thread, Message, ThreadDetail, ThreadStatusFilter,
} from './types/threads';

export type { Reason, VerdictWarning, Verdict, QuestEvent } from './types/common';

export type { Snapshot } from './types/snapshot';
