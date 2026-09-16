// The only module that talks to the board server. Errors carry the server's refusal reasons.
import type {
  AdventurerInput, Card, CardStatus, LanePreviewRequest, LanePreviewResponse, LaneServerStatus, LanesReport, Message, MetadataUpdateInput, OmoChange, OmoConfig, Quest, QuestEvent,
  QuestStatus, Reason, SettingsReport, Snapshot, Thread, ThreadDetail, ThreadStatusFilter, UsageReport,
} from './types';

export class ApiError extends Error {
  readonly reasons: Reason[];
  readonly fields: Record<string, string>;
  readonly status: number;
  // Only ever set by the metadata 409 stale-revision response (questRoutes.js): the quest's current
  // revision, so a caller can offer "reload" without a second round trip just to learn it.
  readonly revision?: number;

  constructor(message: string, reasons: Reason[] = [], fields: Record<string, string> = {}, revision?: number, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.reasons = reasons;
    this.fields = fields;
    this.revision = revision;
    this.status = status;
  }
}

async function call<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-questboard-source': 'ui' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = (await response.json().catch(() => ({}))) as {
    error?: string; reasons?: Reason[]; fields?: Record<string, string>; revision?: number;
  };
  if (!response.ok) throw new ApiError(value.error || `HTTP ${response.status}`, value.reasons, value.fields, value.revision, response.status);
  return value as T;
}

const quest = (id: string) => `/api/quests/${encodeURIComponent(id)}`;
const thread = (id: string) => `/api/threads/${encodeURIComponent(id)}`;

export const api = {
  snapshot: () => call<Snapshot>('/api/quests'),
  // ifRevision: the quest revision the owner looked at; a quest changed since is refused with stale_revision.
  assign: (questId: string, adventurer: string, ifRevision?: number) =>
    call<{ quest: Quest; repeated?: boolean }>(`${quest(questId)}/assign`, 'POST', { adventurer, by: 'owner', ifRevision }),
  rule: (questId: string, text: string) => call<{ quest: Quest }>(`${quest(questId)}/ruling`, 'POST', { text, by: 'owner' }),
  // Writes a review brief and posts a review quest for returned work; refused (409) while one is still open.
  // With an adventurer the review is dispatched to that card in the same step, after the rules accept it.
  requestReview: (questId: string, note: string, adventurer?: string) =>
    call<{ review: Quest; quest: Quest }>(`${quest(questId)}/review`, 'POST', { note, by: 'owner', ...(adventurer ? { adventurer } : {}) }),
  setQuestStatus: (questId: string, status: QuestStatus, detail: string, ack = false) => call<{ quest: Quest }>(`${quest(questId)}/status`, 'POST', { status, detail, ack, by: 'owner' }),
  cancelQuest: (questId: string, reason: string) => call<{ quest: Quest; result: string }>(`${quest(questId)}/cancel`, 'POST', { reason }),
  // Revision-guarded correction of title/brief/parents/conflicts/allowedLanes/needsOwner — never status,
  // assignee or dispatch history. Send only the fields actually changed (see lib/metadataForm.ts diffDraft);
  // a field left out is never touched. 409 stale (fields absent, reasons[0].code stale_revision, and
  // ApiError.revision set) means the quest changed since ifRevision was read; 409 holds_slot means a worker
  // still occupies the quest's slot — release it first.
  updateMetadata: (questId: string, input: MetadataUpdateInput, ifRevision?: number) =>
    call<{ quest: Quest }>(`${quest(questId)}/metadata`, 'POST', { ...input, by: 'owner', ifRevision }),
  // Frees a stalled quest after the owner confirmed its worker is gone; refused (409) for anything else.
  releaseWorker: (questId: string, detail: string) => call<{ quest: Quest }>(`${quest(questId)}/release`, 'POST', { detail, ack: true, by: 'owner' }),
  resolveWorker: (questId: string, reason: string) => call<{ quest: Quest }>(`${quest(questId)}/resolve`, 'POST', { reason, ack: true }),
  setCardStatus: (cardId: string, status: CardStatus, reason: string) =>
    call<{ status: Pick<Card, 'status'> }>(`/api/roster/${encodeURIComponent(cardId)}/status`, 'POST', { status, reason, setBy: 'owner' }),

  lanes: () => call<LanesReport>('/api/lanes'),

  threads: (filter: { status: ThreadStatusFilter; q?: string }) => {
    const params = new URLSearchParams({ status: filter.status });
    if (filter.q?.trim()) params.set('q', filter.q.trim());
    return call<{ threads: Thread[] }>(`/api/threads?${params}`);
  },
  thread: (id: string) => call<ThreadDetail>(thread(id)),
  // Validation failures reject with ApiError whose fields name the bad inputs (title, body, author, tag).
  createThread: (input: { title: string; body: string; tags: string[]; author: string }) =>
    call<{ thread: ThreadDetail; message: Message }>('/api/threads', 'POST', input),
  reply: (id: string, input: { body: string; author: string }) =>
    call<{ message: Message; thread: ThreadDetail }>(`${thread(id)}/messages`, 'POST', input),
  pinThread: (id: string, pinned: boolean) => call<Thread>(`${thread(id)}/pin`, 'POST', { pinned }),
  closeThread: (id: string, closed: boolean) => call<Thread>(`${thread(id)}/close`, 'POST', { closed }),

  // Quota and balance per provider; refresh skips the server's cache. providerId narrows a manual refresh
  // to one known source (backend rejects an unrecognized id with a safe 400 message) instead of re-reading
  // every provider for a single click.
  usage: (opts: { refresh?: boolean; providerId?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.refresh) params.set('refresh', '1');
    if (opts.providerId) params.set('provider', opts.providerId);
    const qs = params.toString();
    return call<UsageReport>(qs ? `/api/usage?${qs}` : '/api/usage');
  },

  // Adds or replaces a card (roster facts only). Server refusals arrive as ApiError messages.
  saveCard: (adventurer: AdventurerInput) => call<{ adventurer: AdventurerInput }>('/api/roster', 'POST', { adventurer }),
  // Refused with 409 while the card is working on a quest.
  removeCard: (id: string) => call<{ removed: string }>(`/api/roster/${encodeURIComponent(id)}/delete`, 'POST', {}),

  omo: () => call<OmoConfig>('/api/omo'),
  saveOmo: (items: OmoChange[]) => call<OmoConfig>('/api/omo', 'POST', { items }),
  // Runs `opencode models` on the server; slow the first time (can take a minute).
  omoModels: (refresh = false) => call<{ models: string[] }>(refresh ? '/api/omo/models?refresh=1' : '/api/omo/models'),

  settings: () => call<SettingsReport>('/api/settings'),
  // Saves the whole questboard.config.json. Refused (400) with the offending field when it would not load;
  // nothing takes effect until the board server restarts.
  saveSettings: (raw: Record<string, unknown>) =>
    call<{ ok: true; restartRequired: boolean; raw: Record<string, unknown> }>('/api/settings', 'POST', { raw }),
  // Server lanes of the running board: whether each answers, and whether the board can start it.
  laneServers: () => call<{ lanes: LaneServerStatus[] }>('/api/settings/lanes'),
  // Starts a lane's server from its configured serve command; resolves once it answers, throws with the reason.
  startLaneServer: (laneId: string) =>
    call<{ up: boolean; started: boolean }>(`/api/settings/lanes/${encodeURIComponent(laneId)}/start`, 'POST', {}),
  // Simulates command execution with optionalArgs; returns argv, omitted groups, and warnings.
  lanePreview: (request: LanePreviewRequest) =>
    call<LanePreviewResponse>('/api/settings/lanes/preview', 'POST', request),
};

// Live events. Returns a function that closes the stream.
export function subscribe(handlers: { onEvent: (event: QuestEvent) => void; onOpen: () => void; onError: () => void }): () => void {
  const stream = new EventSource('/api/quests/stream');
  stream.addEventListener('hello', handlers.onOpen);
  stream.addEventListener('quest', (message) => {
    try {
      handlers.onEvent(JSON.parse((message as MessageEvent<string>).data) as QuestEvent);
    } catch {
      // A malformed frame is ignored; the next snapshot shows the truth.
    }
  });
  stream.onerror = handlers.onError;
  return () => stream.close();
}
