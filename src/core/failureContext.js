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
  // Cut on code points (never split surrogate pair / inside an emoji) up to MAX_SUMMARY code points.
  return Array.from(text.slice(0, MAX_SUMMARY * 2)).slice(0, MAX_SUMMARY).join('');
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

// PM ruling (F5): the store stamps a restored 'delivered' entry with `restoredAt` (a later re-delivery of
// the same attempt) without ever moving its original `at`. The evidence time for a delivered fact is
// therefore the later of the two, never just the first `at`.
function deliveredEffectiveMs(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const atMs = timestamp(entry.at);
  const restoredMs = timestamp(entry.restoredAt);
  if (atMs === null) return restoredMs;
  if (restoredMs === null) return atMs;
  return Math.max(atMs, restoredMs);
}

// Evidence gathered from one quest:
//   { cardId, kind: 'failure' | 'delivered', at, questId, summary }
function questEvidence(quest) {
  if (!quest || typeof quest !== 'object') return [];
  if (typeof quest.id !== 'string' || !quest.id) return [];
  const fact = quest.terminalFact;
  if (fact && fact.statuses && typeof fact.statuses === 'object') {
    const dispatches = Array.isArray(quest.dispatches) ? quest.dispatches : [];
    const matching = dispatches.filter((row) => row && row.adventurerId && factMatchesDispatch(fact, row));
    const distinctCards = new Set(matching.map((row) => row.adventurerId));
    // No provable card identity, or ambiguous matches: blame no card unless exactly one distinct card matches.
    if (distinctCards.size !== 1) return [];
    const cardId = [...distinctCards][0];
    const lastDispatch = dispatches[dispatches.length - 1];
    const isLatestAttempt = Boolean(lastDispatch && factMatchesDispatch(fact, lastDispatch));
    const hasDeliveredFact = fact.statuses.delivered && typeof fact.statuses.delivered === 'object';
    const deliveredMs = hasDeliveredFact ? deliveredEffectiveMs(fact.statuses.delivered) : null;
    // The store keeps only the FIRST delivered record's `at` (a re-delivery stamps `restoredAt`
    // instead of moving `at`) — so a delivered-then-failed-then-delivered attempt still has a
    // delivered fact whose `at` is older than the failure; `deliveredMs` above already accounts
    // for `restoredAt`. A failure/bounced fact newer than that effective time means the delivery
    // was not the last thing that happened.
    const failureNewerThanDelivered = hasDeliveredFact && FAILURE_STATUSES.some((status) => {
      const entry = fact.statuses[status];
      if (!entry || typeof entry !== 'object') return false;
      const ms = timestamp(entry.at);
      return ms !== null && deliveredMs !== null && ms > deliveredMs;
    });

    // PM ruling G1: the failure note is cleared when the same attempt later ended delivered,
    // or when the quest was accepted (status done) after the failure; a later failure of a
    // newer attempt shows again as usual. Never clear on a mere status_note or ruling. F2: a
    // move to reviewing with no recorded delivered fact is not a delivery and not acceptance
    // either, so it must not clear. F3: status === 'delivered' is reached after a failure only
    // through a real delivered report or a restore, so it always clears; but 'reviewing' can
    // also be reached straight from 'failed' with an older, unrelated delivered fact still on
    // record, so it clears only when no failed/bounced fact is newer than that delivered fact.
    const cleared = quest.status === 'done'
      || (isLatestAttempt && hasDeliveredFact && (
        quest.status === 'delivered'
        || (quest.status === 'reviewing' && !failureNewerThanDelivered)
      ));
    if (cleared) {
      // F1: time the clearing evidence from the fact's own delivered record, never from
      // quest.updatedAt. A later, unrelated save on this very quest (a ruling, a metadata
      // update, a re-post) moves updatedAt without moving the real delivery time; using
      // updatedAt let that later save outrank and hide a genuinely newer failure of the same
      // card on another quest.
      if (hasDeliveredFact) {
        const deliveredAt = fact.statuses.delivered.at;
        return [{ cardId, kind: 'delivered', at: deliveredAt, ms: deliveredMs, questId: quest.id, summary: '' }];
      }
      // Accepted (done) with no delivered fact ever recorded for this attempt (e.g. failed ->
      // done): there is no fact-based time to anchor card-wide clearing evidence to. Hide only
      // this quest's own failure instead of inventing evidence at a moving time.
      return [];
    }

    // PM ruling (N3): the current status wins. When the latest attempt's current status is itself a
    // failure, the card shows that failure whatever earlier delivered fact this same attempt also
    // recorded — the store keeps only the first `failed`/`bounced` entry's `at` (never re-stamped on a
    // repeat failure, by design: F5/F6's restoredAt is delivered-only), so an old delivered fact's
    // effective time could otherwise misread as newer than a since-repeated failure and hide it.
    const failingNow = isLatestAttempt && FAILURE_STATUSES.includes(quest.status);

    const evidence = [];
    for (const status of FAILURE_STATUSES) {
      const entry = fact.statuses[status];
      if (entry && typeof entry === 'object') {
        evidence.push({ cardId, kind: 'failure', at: entry.at, questId: quest.id, summary: plainSummary(entry.detail) });
      }
    }
    const delivered = fact.statuses.delivered;
    // PM ruling (F6): time this evidence the same way the cleared branch above does — the later of `at`
    // and `restoredAt` (`deliveredMs`, already computed) — everywhere delivered evidence is pushed, not
    // only when the quest's own status already reads as cleared. Skipped entirely while failingNow.
    if (!failingNow && delivered && typeof delivered === 'object') {
      evidence.push({ cardId, kind: 'delivered', at: delivered.at, ms: deliveredMs, questId: quest.id, summary: '' });
    }
    return evidence;
  }
  // Legacy quests saved before terminal facts existed: only the quest row itself can speak, and
  // only when its latest dispatch names the card. PM ruling (N2): this path never reads
  // quest.updatedAt — a later ruling or metadata update on this very quest moves updatedAt
  // without moving when the dispatch actually ran, and using it let that later, unrelated save
  // outrank and hide a genuinely newer fact-based failure of the same card elsewhere. The only
  // time this path can speak from is the attempt's own dispatch time.
  const attempt = lastDispatchWithCard(quest);
  if (!attempt) return [];
  const attemptMs = timestamp(attempt.at);
  // No usable dispatch time at all: keep `at` null for the web's "时间未知" label, but still let
  // the evidence participate in ordering as the oldest possible fact rather than dropping it
  // (ms undefined would be recomputed from the null `at` and skipped entirely).
  const attemptAt = attemptMs !== null ? attempt.at : null;
  const ms = attemptMs !== null ? attemptMs : 0;
  if (FAILURE_STATUSES.includes(quest.status)) {
    return [{ cardId: attempt.adventurerId, kind: 'failure', at: attemptAt, ms, questId: quest.id, summary: plainSummary(quest.lastDetail) }];
  }
  if (DELIVERED_STATUSES.includes(quest.status)) {
    return [{ cardId: attempt.adventurerId, kind: 'delivered', at: attemptAt, ms, questId: quest.id, summary: '' }];
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
      const ms = item.ms !== undefined ? item.ms : timestamp(item.at);
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
