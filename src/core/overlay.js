// Effective adventurer status = the manual status-log layer overlaid with trustworthy lane evidence.
// A lane observation is allowed to affect one exact card only; ambiguous legacy evidence is diagnostic.
import { resetAt } from '../lanes/workers.js';

// Kept as a compatibility export for callers that imported the old constant. Unknown-duration bounces no
// longer use this value as an expiry window.
export const BOUNCE_WINDOW_MS = 5 * 60 * 60 * 1000;
const UNVERIFIED_REASON = '限额窗口已过，尚未验证可用';

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  const parsed = timestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function identity(row) {
  const value = row && (row.adventurerId || row.cardId || (row.identity && row.identity.adventurerId));
  return typeof value === 'string' && value.trim() ? value : null;
}

function observationAt(row, now) {
  // Collector rows use observedAt; these aliases keep the pure overlay useful for API fixtures and older
  // snapshots. A bounce without a terminal timestamp was observed by this poll, not at dispatch time.
  for (const field of ['bouncedAt', 'observedAt', 'at', 'finishedAt', 'completedAt', 'endedAt']) {
    const parsed = timestamp(row && row[field]);
    if (parsed !== null) return parsed;
  }
  return row && row.state === 'bounced' ? now : null;
}

function resetReference(row, observedAt, now) {
  for (const field of ['bouncedAt', 'observedAt', 'at', 'finishedAt', 'completedAt', 'endedAt']) {
    const parsed = timestamp(row && row[field]);
    if (parsed !== null) return parsed;
  }
  // A legacy package row may have only dispatchedAt. It is acceptable as the calendar reference for a
  // displayed time-only reset, but never as the age of the bounce itself.
  const dispatched = timestamp(row && row.dispatchedAt);
  return dispatched === null ? (observedAt === null ? now : observedAt) : dispatched;
}

function resetFor(row, observedAt, now) {
  const explicit = timestamp(row && (row.resetsAt || row.resetAt));
  if (explicit !== null) return explicit;
  const text = row && row.bounceUntil;
  return text ? resetAt(text, resetReference(row, observedAt, now)) : null;
}

function diagnostic(row, now) {
  return {
    code: 'quota_identity_unknown',
    lane: row && row.lane ? row.lane : null,
    model: row && row.model ? row.model : null,
    package: row && row.package ? row.package : null,
    at: iso(observationAt(row, now)),
    message: '限额证据无法对应到具体卡片，未改变卡片状态',
  };
}

function derivedEvidence(row, now) {
  const at = observationAt(row, now);
  const resetsAt = resetFor(row, at, now);
  return { at: iso(at), resetsAt: iso(resetsAt) };
}

function laneEntries(lanes) {
  return [
    ...Object.entries((lanes && lanes.laneLimits) || {}),
    ...Object.entries((lanes && lanes.laneEvidence) || {}),
  ];
}

function reasonFor(row, resetsAt, expired) {
  if (expired) return UNVERIFIED_REASON;
  const label = row.bounceUntil || '';
  const prefix = row._kind === 'lane-limit' ? `${row.lane || '某个通道'} 限额中` : `${row.package || row.lane || '某个通道'} 限额退回`;
  return `${prefix}${label ? `，${label} 恢复` : ''}`;
}

function actionableRows(lanes) {
  const rows = [];
  for (const row of (lanes && lanes.packages) || []) {
    if (!row || row.state !== 'bounced' || !identity(row)) continue;
    rows.push({ ...row, adventurerId: identity(row), _kind: 'bounce' });
  }
  for (const [lane, limit] of laneEntries(lanes)) {
    if (!limit) continue;
    if (limit.cards && typeof limit.cards === 'object') {
      for (const [adventurerId, cardLimit] of Object.entries(limit.cards)) {
        if (cardLimit && (identity(cardLimit) || adventurerId)) {
          rows.push({ ...cardLimit, lane, state: 'bounced', bounceUntil: cardLimit.bounceUntil || cardLimit.until || null, adventurerId: identity(cardLimit) || adventurerId, _kind: 'lane-limit' });
        }
      }
      continue;
    }
    if (identity(limit)) rows.push({ ...limit, lane, state: 'bounced', bounceUntil: limit.bounceUntil || limit.until || null, adventurerId: identity(limit), _kind: 'lane-limit' });
  }
  return rows;
}

function unknownRows(lanes) {
  const rows = [];
  for (const row of (lanes && lanes.packages) || []) if (row && row.state === 'bounced' && !identity(row)) rows.push(row);
  for (const [lane, limit] of laneEntries(lanes)) {
    if (!limit) continue;
    if (Array.isArray(limit.unidentified)) {
      for (const entry of limit.unidentified) if (entry) rows.push({ ...entry, lane, state: 'bounced', bounceUntil: entry.bounceUntil || entry.until || null });
    } else if (!limit.cards && !identity(limit)) {
      rows.push({ ...limit, lane, state: 'bounced', bounceUntil: limit.bounceUntil || limit.until || null });
    }
  }
  return rows;
}

function latestByCard(rows, now) {
  const latest = new Map();
  for (const row of rows) {
    const at = observationAt(row, now);
    if (at === null) continue;
    const prior = latest.get(row.adventurerId);
    if (!prior || observationAt(prior, now) < at) latest.set(row.adventurerId, row);
  }
  return latest;
}

function latestSuccesses(lanes, now) {
  const latest = new Map();
  for (const row of (lanes && lanes.packages) || []) {
    const id = identity(row);
    if (!id || row.state !== 'delivered') continue;
    const at = observationAt(row, now);
    if (at === null || !(!latest.has(id) || observationAt(latest.get(id), now) < at)) continue;
    latest.set(id, row);
  }
  return latest;
}

function manualClearAfter(adventurer, evidenceAt) {
  if (!adventurer || adventurer.status !== 'available' || evidenceAt === null) return false;
  const changedAt = timestamp(adventurer.statusSince);
  // A status-log available record after the bounce is an owner/coordinator acknowledgement. A roster card
  // with no status record has statusSince null and cannot silently acknowledge lane evidence.
  return changedAt !== null && changedAt > evidenceAt && Boolean(adventurer.statusSetBy);
}

function withBase(adventurer) {
  const baseStatus = adventurer.status;
  const baseReason = typeof adventurer.baseReason === 'string' ? adventurer.baseReason : (adventurer.statusReason || '');
  const { derived: _derived, laneDiagnostics: _diagnostics, ...rest } = adventurer;
  return { ...rest, baseStatus, baseReason, statusReason: adventurer.statusReason === undefined ? baseReason : adventurer.statusReason };
}

export function effectiveRoster(adventurers, lanes, now = Date.now()) {
  const base = adventurers.map(withBase);
  if (!lanes) return base;

  const bounces = latestByCard(actionableRows(lanes), now);
  const successes = latestSuccesses(lanes, now);
  const ambiguous = unknownRows(lanes);
  return base.map((adventurer) => {
    const unknownDiagnostics = ambiguous
      .filter((row) => row.lane === adventurer.lane && (!row.model || row.model === adventurer.model))
      .map((row) => diagnostic(row, now));
    const row = bounces.get(adventurer.id);
    const result = withBase(adventurer);
    if (unknownDiagnostics.length) result.laneDiagnostics = unknownDiagnostics;
    // The manual layer always wins, including manually limited cards. Derived evidence never writes status.
    if (adventurer.status !== 'available' || !row) return result;

    const evidenceAt = observationAt(row, now);
    const successAt = successes.has(adventurer.id) ? observationAt(successes.get(adventurer.id), now) : null;
    const reset = resetFor(row, evidenceAt, now);
    if (manualClearAfter(adventurer, evidenceAt) || (successAt !== null && evidenceAt !== null && successAt > evidenceAt)) return result;

    const derived = { from: 'lanes', reason: reasonFor(row, reset, reset !== null && reset <= now), ...derivedEvidence(row, now) };
    if (reset !== null && reset <= now) return { ...result, derived };
    return { ...result, status: 'limited', derived };
  });
}

// B5: laneLimits is only ever a lane-level claim ("some card here is limited"), so it must agree with the
// per-card roster the board shows. Keep a card's entry only while that same card is effectively limited;
// an entry whose card was acknowledged, paused, disabled, or removed from the roster stops asserting the
// lane and moves to laneEvidence with a marker for why it was cleared.
export function visibleLaneLimits(laneLimits, roster, laneEvidence = {}) {
  const byId = new Map((roster || []).map((adventurer) => [adventurer.id, adventurer]));
  const visible = {};
  const evidence = { ...laneEvidence };
  for (const [lane, limit] of Object.entries(laneLimits || {})) {
    if (!limit || typeof limit !== 'object') continue;
    const entries = limit.cards && typeof limit.cards === 'object'
      ? Object.entries(limit.cards)
      : (identity(limit) ? [[identity(limit), limit]] : []);
    const kept = {};
    const dropped = {};
    for (const [id, rawEntry] of entries) {
      const entry = rawEntry || {};
      const card = byId.get(id);
      if (card && card.status === 'limited') { kept[id] = entry; continue; }
      dropped[id] = { ...entry, cleared: !card ? 'no_card' : (card.status === 'available' ? 'owner' : 'status') };
    }
    if (Object.keys(kept).length) {
      const newest = Object.values(kept).reduce((best, entry) => (entryAt(entry) >= entryAt(best) ? entry : best));
      visible[lane] = { ...newest, cards: kept };
    }
    if (Object.keys(dropped).length) {
      const prior = evidence[lane] && typeof evidence[lane] === 'object' ? evidence[lane] : {};
      evidence[lane] = { unidentified: [], ...prior, cards: { ...(prior.cards || {}), ...dropped } };
    }
  }
  return { laneLimits: visible, laneEvidence: evidence };
}

function entryAt(entry) {
  const at = timestamp(entry && entry.at);
  return at === null ? -Infinity : at;
}
