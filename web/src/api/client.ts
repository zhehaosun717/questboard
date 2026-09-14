// The only module that talks to the board server. Errors carry the server's refusal reasons.
import type {
  AdventurerInput, Card, CardStatus, LanesReport, Message, OmoChange, OmoConfig, Quest, QuestEvent, QuestStatus, Reason,
  SettingsReport, Snapshot, Thread, ThreadDetail, ThreadStatusFilter, UsageReport,
} from './types';

export class ApiError extends Error {
  readonly reasons: Reason[];
  readonly fields: Record<string, string>;

  constructor(message: string, reasons: Reason[] = [], fields: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.reasons = reasons;
    this.fields = fields;
  }
}

async function call<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = (await response.json().catch(() => ({}))) as { error?: string; reasons?: Reason[]; fields?: Record<string, string> };
  if (!response.ok) throw new ApiError(value.error || `HTTP ${response.status}`, value.reasons, value.fields);
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
  requestReview: (questId: string, note: string) =>
    call<{ review: Quest; quest: Quest }>(`${quest(questId)}/review`, 'POST', { note, by: 'owner' }),
  setQuestStatus: (questId: string, status: QuestStatus, detail: string) => call<{ quest: Quest }>(`${quest(questId)}/status`, 'POST', { status, detail, by: 'owner' }),
  // Frees a stalled quest after the owner confirmed its worker is gone; refused (409) for anything else.
  releaseWorker: (questId: string, detail: string) => call<{ quest: Quest }>(`${quest(questId)}/release`, 'POST', { detail, by: 'owner' }),
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

  // Quota and balance per provider; refresh skips the server's 60 s cache.
  usage: (refresh = false) => call<UsageReport>(refresh ? '/api/usage?refresh=1' : '/api/usage'),

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
