// The only module that talks to the board server. Errors carry the server's refusal reasons.
import type { Card, CardStatus, Quest, QuestEvent, QuestStatus, Reason, Snapshot } from './types';

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

export const api = {
  snapshot: () => call<Snapshot>('/api/quests'),
  assign: (questId: string, adventurer: string) => call<{ quest: Quest }>(`${quest(questId)}/assign`, 'POST', { adventurer, by: 'owner' }),
  rule: (questId: string, text: string) => call<{ quest: Quest }>(`${quest(questId)}/ruling`, 'POST', { text, by: 'owner' }),
  setQuestStatus: (questId: string, status: QuestStatus, detail: string) => call<{ quest: Quest }>(`${quest(questId)}/status`, 'POST', { status, detail, by: 'owner' }),
  setCardStatus: (cardId: string, status: CardStatus, reason: string) =>
    call<{ status: Pick<Card, 'status'> }>(`/api/roster/${encodeURIComponent(cardId)}/status`, 'POST', { status, reason, setBy: 'owner' }),
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
