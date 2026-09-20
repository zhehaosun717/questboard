// Effective adventurer status = the manual status-log layer overlaid with trustworthy lane evidence.
// A lane observation is allowed to affect one exact card only; ambiguous legacy evidence is diagnostic.
import { resetAt } from '../lanes/workers.js';

const UNVERIFIED_REASON = '限额窗口已过，尚未验证可用';
// FB2-01.2: coded lane evidence decides which derived status a card gets. A dead model (410/404/
// model-not-found in the worker's last lines) breaks the card — there is no reset window to wait out.
// An auth failure (401/invalid key) limits it — the owner can fix the key and clear it, same as quota.
const BROKE_CODES = new Set(['model_gone']);
const AUTH_CODES = new Set(['auth_failed']);
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A provider's own bounce label (e.g. "1:54 PM", "Sep 18, 2026 1:54 PM") is shown verbatim. Only a
// machine-shaped timestamp (YYYY-MM-DD…, as a structured API's resetAt field can hand back directly) is
// reformatted, so the reason never leaks a raw ISO string to the owner.
const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/;
// F4: mirrors workers.js's FULL_RESET_RE/DATED_RESET_RE. A full date-time or a dated provider reset
// ("Sep 18, 2026 1:54 PM") already carries its own calendar day, so resetAt parses it without any
// reference; only a bare clock time ("1:54 PM") is ambiguous without one. Classifying the text this way,
// before resetFor decides whether a real observation time is required, is what tells the two apart.
const ABSOLUTE_RESET_RE = /^(?:\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,\s*\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))$/i;

function isAbsoluteReset(text) {
  return ABSOLUTE_RESET_RE.test(String(text || '').trim());
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function humanResetLabel(label, resetsAt) {
  if (label && !ISO_LIKE_RE.test(label)) return label;
  const parsed = timestamp(resetsAt);
  if (parsed === null) return '';
  const date = new Date(parsed);
  const hour24 = date.getHours();
  const hour = hour24 % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${hour}:${minute} ${hour24 >= 12 ? 'PM' : 'AM'}`;
}

function iso(value) {
  const parsed = timestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function identity(row) {
  const value = row && (row.adventurerId || row.cardId || (row.identity && row.identity.adventurerId));
  return typeof value === 'string' && value.trim() ? value : null;
}

// The real, evidence-carried observation time only — never guessed. Used as the calendar reference for a
// reset; a missing value here means the reset is genuinely unknown, not "assume now".
function realObservationAt(row) {
  // Collector rows use observedAt; these aliases keep the pure overlay useful for API fixtures and older
  // snapshots.
  for (const field of ['bouncedAt', 'observedAt', 'at', 'finishedAt', 'completedAt', 'endedAt']) {
    const parsed = timestamp(row && row[field]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function observationAt(row, now) {
  // A bounce without a terminal timestamp is still shown as evidence "as of now" (its age), but F1: this
  // fallback must never reach resetFor — see realObservationAt.
  const real = realObservationAt(row);
  if (real !== null) return real;
  return row && row.state === 'bounced' ? now : null;
}

// N5/F1: dispatchedAt is when a worker was launched, not when a bounce happened — using it (or the current
// poll) as the calendar reference for a time-only reset ("1:54 PM") can silently anchor the window to the
// wrong day, or invent a date that drifts forward with every poll. Without a real observation timestamp
// there is no trustworthy reference, so the window is reported as unknown (未知, resetsAt: null) instead of
// guessing one, and nothing gets scheduled from a guess. Callers must pass realObservationAt(row), never
// observationAt's now-fallback.
// F4: that anchor requirement only applies to a bare clock time. A full date-time or a dated provider reset
// (isAbsoluteReset) already carries its own calendar day and needs no anchor — dropping it when there is no
// real observation time would throw away a known reset the provider itself gave, not an ambiguous one.
function resetFor(row, realObservedAt) {
  const explicit = timestamp(row && (row.resetsAt || row.resetAt));
  if (explicit !== null) return explicit;
  const text = row && row.bounceUntil;
  if (!text) return null;
  if (realObservedAt === null && !isAbsoluteReset(text)) return null;
  return resetAt(text, realObservedAt);
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
  const resetsAt = resetFor(row, realObservationAt(row));
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
  // Coded auth/model-gone evidence carries the provider's own error line as its reason (bounded at
  // detection time in workers.js) — showing that original text beats any paraphrase of it.
  if ((BROKE_CODES.has(row.code) || AUTH_CODES.has(row.code)) && typeof row.reason === 'string' && row.reason) {
    return BROKE_CODES.has(row.code) ? `模型已下线：${row.reason}` : `认证失败：${row.reason}`;
  }
  // F1: resetsAt null means the reset time is genuinely unknown (no real observation to anchor it) — the
  // reason must not show a time in that case, even if the provider's own bounceUntil text looks like one.
  const label = resetsAt === null ? '' : humanResetLabel(row.bounceUntil || '', resetsAt);
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
        // N8/F2: a `cleared` entry is the overlay's own inert history (visibleLaneLimits' output fed back
        // in on a later poll), never live evidence — without this guard, re-reading a snapshot's own
        // laneEvidence would re-limit an already-acknowledged card and the overlay would not be a fixed
        // point of its own output. But `expired` can never re-limit a card (its own known reset has
        // already passed), so it must stay actionable — otherwise the roster loses the card's "过期未验证"
        // hint on the next pass and the overlay is not a fixed point either way.
        if (cardLimit && (!cardLimit.cleared || cardLimit.cleared === 'expired') && (identity(cardLimit) || adventurerId)) {
          rows.push({ ...cardLimit, lane, state: 'bounced', bounceUntil: cardLimit.bounceUntil || cardLimit.until || null, adventurerId: identity(cardLimit) || adventurerId, _kind: 'lane-limit' });
        }
      }
      continue;
    }
    if ((!limit.cleared || limit.cleared === 'expired') && identity(limit)) rows.push({ ...limit, lane, state: 'bounced', bounceUntil: limit.bounceUntil || limit.until || null, adventurerId: identity(limit), _kind: 'lane-limit' });
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

// N4: the same ambiguous evidence can surface twice for one worker (once from the live package row, once
// from a lane's own unidentified list) — collapse duplicates by code+text so a card gets the notice once.
function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  const result = [];
  for (const item of diagnostics) {
    const key = `${item.code}::${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
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
    const unknownDiagnostics = dedupeDiagnostics(ambiguous
      .filter((row) => row.lane === adventurer.lane && (!row.model || row.model === adventurer.model))
      .map((row) => diagnostic(row, now)));
    const row = bounces.get(adventurer.id);
    const result = withBase(adventurer);
    if (unknownDiagnostics.length) result.laneDiagnostics = unknownDiagnostics;
    // The manual layer always wins, including manually limited cards. Derived evidence never writes status.
    if (adventurer.status !== 'available' || !row) return result;

    const evidenceAt = observationAt(row, now);
    const successAt = successes.has(adventurer.id) ? observationAt(successes.get(adventurer.id), now) : null;
    const reset = resetFor(row, realObservationAt(row));
    if (manualClearAfter(adventurer, evidenceAt) || (successAt !== null && evidenceAt !== null && successAt > evidenceAt)) return result;

    const derived = { from: 'lanes', reason: reasonFor(row, reset, reset !== null && reset <= now), ...derivedEvidence(row, now) };
    if (reset !== null && reset <= now && !BROKE_CODES.has(row.code)) return { ...result, derived };
    return { ...result, status: BROKE_CODES.has(row.code) ? 'broke' : 'limited', derived };
  });
}

function entryAt(entry) {
  const at = timestamp(entry && entry.at);
  return at === null ? -Infinity : at;
}

// A manual status-log record for this card, only when it was actually set by someone (never a roster card
// that simply has no status history — statusSince with no statusSetBy proves nothing).
function manualStatusAt(card) {
  return card && card.statusSetBy ? timestamp(card.statusSince) : null;
}

// N16: `cleared` used to collapse every non-limited case into 'owner', which read as a false claim that the
// owner acted — a later success or a reset that simply passed look identical. Tell the three apart from
// what the entry and the roster card actually record, so the wording stays true without guessing:
//   - 'owner': a status-log record for this card postdates the evidence — an explicit acknowledgement.
//   - 'expired': the entry's own known reset has passed, with no explicit acknowledgement newer than it.
//   - 'success': neither of the above — the only remaining way effectiveRoster clears a card is a later
//     successful run by that same card.
function clearedReasonFor(card, entry, now) {
  if (!card) return 'no_card';
  if (card.status !== 'available') return 'status';
  const manualAt = manualStatusAt(card);
  if (manualAt !== null && manualAt > entryAt(entry)) return 'owner';
  const resetsAt = timestamp(entry && entry.resetsAt);
  if (resetsAt !== null && resetsAt <= now) return 'expired';
  return 'success';
}

// N18: a card the owner has manually limited again keeps its lane entry (it is truthfully limited), but a
// manual action after the evidence supersedes that evidence's own recovery time — keeping `until` would
// show a bounce's stale recovery time long after the owner's own reason replaced it.
function dropStaleUntil(card, entry) {
  const manualAt = manualStatusAt(card);
  if (manualAt === null || manualAt <= entryAt(entry)) return entry;
  const { until: _until, resetsAt: _resetsAt, ...rest } = entry;
  return { ...rest, until: null, resetsAt: null, reason: '该卡片已被手动设为限额，先前限额记录的恢复时间已不再适用' };
}

// N19: a legacy top-level lane-limit entry with neither a `cards` map nor its own card id cannot be matched
// to any card. It must not vanish — record it as advisory, named evidence instead of silently discarding it.
function recordUnidentifiedLegacyLimit(evidence, lane, limit) {
  const prior = evidence[lane] && typeof evidence[lane] === 'object' ? evidence[lane] : {};
  const note = {
    since: limit.since || null, at: limit.at || null, until: limit.until || null, resetsAt: limit.resetsAt || null,
    name: limit.name || null,
    note: `旧格式限额记录无法对应到具体卡片（通道 ${lane}），已保留在证据中`,
  };
  evidence[lane] = { cards: {}, ...prior, unidentified: [...(prior.unidentified || []), note] };
}

// B5: laneLimits is only ever a lane-level claim ("some card here is limited"), so it must agree with the
// per-card roster the board shows. Keep a card's entry only while that same card is effectively limited;
// an entry whose card was acknowledged, paused, disabled, or removed from the roster stops asserting the
// lane and moves to laneEvidence with a marker for why it was cleared.
export function visibleLaneLimits(laneLimits, roster, laneEvidence = {}, now = Date.now()) {
  const byId = new Map((roster || []).map((adventurer) => [adventurer.id, adventurer]));
  const visible = {};
  const evidence = { ...laneEvidence };
  for (const [lane, limit] of Object.entries(laneLimits || {})) {
    if (!limit || typeof limit !== 'object') continue;
    const hasCards = limit.cards && typeof limit.cards === 'object';
    if (!hasCards && !identity(limit)) {
      recordUnidentifiedLegacyLimit(evidence, lane, limit);
      continue;
    }
    const entries = hasCards ? Object.entries(limit.cards) : [[identity(limit), limit]];
    const kept = {};
    const dropped = {};
    for (const [id, rawEntry] of entries) {
      const entry = rawEntry || {};
      const card = byId.get(id);
      if (card && card.status === 'limited') { kept[id] = dropStaleUntil(card, entry); continue; }
      dropped[id] = { ...entry, cleared: clearedReasonFor(card, entry, now) };
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
