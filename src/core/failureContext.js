// Recent execution failure context for cards, derived read-only from the quests
// already loaded for a snapshot. Nothing here writes to the roster, the status
// log or any quest: an ordinary task failure is history, not a card status.
//
// A failure is attributed to a card only when the attempt (dispatch row) that
// reported it recorded that exact card id (`adventurerId`). A model string
// alone never associates a failure, and an attempt is never re-pointed at the
// "latest" dispatch after a reassignment. Legacy rows that carry no card id
// stay unassociated instead of being guessed.
//
// Latest-attempt policy: per card only the newest piece of evidence counts, so
// a later delivered attempt clears an older failure for that card.

import { sameAttempt } from './store.js';

export const MAX_SUMMARY = 200;

const FAILURE_STATUSES = ['failed', 'bounced'];
const DELIVERED_STATUSES = ['delivered', 'reviewing', 'done'];

// Mirrors the store's private factMatchesAttempt: both sides agree on whether
// an attemptId exists, and the remaining identity fields line up.
function factMatchesDispatch(fact, dispatch) {
  return Boolean(fact.attemptId) === Boolean(dispatch.attemptId) && sameAttempt(fact, dispatch);
}

function plainSummary(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, MAX_SUMMARY);
}

function timestamp(at) {
  if (typeof at !== 'string') return null;
  const value = Date.parse(at);
  return Number.isFinite(value) ? value : null;
}

function lastDispatchWithCard(quest) {
  const dispatches = Array.isArray(quest.dispatches) ? quest.dispatches : [];
  const last = dispatches[dispatches.length - 1];
  if (!last || typeof last.adventurerId !== 'string' || !last.adventurerId) return null;
  return last;
}

// Evidence gathered from one quest:
//   { cardId, kind: 'failure' | 'delivered', at, questId, summary }
function questEvidence(quest) {
  if (!quest || typeof quest !== 'object') return [];
  if (typeof quest.id !== 'string' || !quest.id) return [];
  const fact = quest.terminalFact;
  if (fact && fact.statuses && typeof fact.statuses === 'object') {
    const dispatches = Array.isArray(quest.dispatches) ? quest.dispatches : [];
    const attempt = dispatches.find((row) => row && row.adventurerId && factMatchesDispatch(fact, row));
    // No provable card identity: leave this quest unassociated, never guess.
    if (!attempt) return [];
    const cardId = attempt.adventurerId;
    const evidence = [];
    for (const status of FAILURE_STATUSES) {
      const entry = fact.statuses[status];
      if (entry && typeof entry === 'object') {
        evidence.push({ cardId, kind: 'failure', at: entry.at, questId: quest.id, summary: plainSummary(entry.detail) });
      }
    }
    const delivered = fact.statuses.delivered;
    if (delivered && typeof delivered === 'object') {
      evidence.push({ cardId, kind: 'delivered', at: delivered.at, questId: quest.id, summary: '' });
    }
    return evidence;
  }
  // Legacy quests saved before terminal facts existed: only the quest row
  // itself can speak, and only when its latest dispatch names the card.
  const attempt = lastDispatchWithCard(quest);
  if (!attempt) return [];
  if (FAILURE_STATUSES.includes(quest.status)) {
    return [{ cardId: attempt.adventurerId, kind: 'failure', at: quest.updatedAt, questId: quest.id, summary: plainSummary(quest.lastDetail) }];
  }
  if (DELIVERED_STATUSES.includes(quest.status)) {
    return [{ cardId: attempt.adventurerId, kind: 'delivered', at: quest.updatedAt, questId: quest.id, summary: '' }];
  }
  return [];
}

// Pure projection: { [cardId]: { questId, at, summary } } for cards whose most
// recent evidence is a failure. An empty object means "nothing to show".
export function recentFailuresByCard(quests) {
  const list = Array.isArray(quests) ? quests : [];
  const best = new Map();
  for (const quest of list) {
    for (const item of questEvidence(quest)) {
      const ms = timestamp(item.at);
      if (ms === null) continue; // Without a usable timestamp nothing can be ordered or cleared.
      const current = best.get(item.cardId);
      const replaces = !current
        || ms > current.ms
        || (ms === current.ms && item.kind === 'failure' && current.kind === 'delivered');
      if (replaces) best.set(item.cardId, { ...item, ms });
    }
  }
  const result = {};
  for (const [cardId, item] of best) {
    if (item.kind !== 'failure') continue;
    result[cardId] = { questId: item.questId, at: item.at, summary: item.summary };
  }
  return result;
}
