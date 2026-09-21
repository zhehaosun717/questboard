// Revision-guarded correction of a posted quest's own descriptive fields — never its status, assignee or
// dispatch history (those go through setStatus/assign/adopt/release/rule). Pure: takes the quest and the
// full quest list it needs to check parents against, no store access, so it is testable on its own and
// reusable from store.js without either side owning the other's concerns.
import { packageIdPattern, briefPathAllowed } from './patterns.js';

export const METADATA_FIELDS = ['title', 'brief', 'parents', 'conflicts', 'allowedLanes', 'needsOwner', 'hold', 'needs', 'files', 'batch', 'waitingOn', 'reviewPage'];
// The only other keys a metadata-update payload may carry: transport, not a field to correct. Everything
// else (status, kind, id, assignee, revision, dispatches, ...) is rejected outright — see validateMetadataUpdate.
const METADATA_TRANSPORT_FIELDS = new Set(['by', 'ifRevision']);
const MAX_TEXT = 300;

function splitList(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
}

export function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// A posted review's own review target is its identity, not a correctable detail: once a card has been
// refused a review for coding its parent (rules.js reviewer_coded_parent), nothing may quietly move that
// review onto a different parent or drop the parent it already has — either change would let the very
// author it was refusing back in. The fix is never "repair it in place", and cancelling the review never
// releases this historical lock either; the only way to correct the parent is a new review under a new
// package id, with its own missing/self/cycle checks.
export function reviewTargetLockedMessage(id) {
  return `${id} is a posted review; its target cannot be cleared or reparented here — cancelling ${id} does not unlock ${id}, so a same-id repost of ${id} is refused the same way again; correcting the parent needs a new package id, not a same-id repost of ${id}; ${id} remains the protecting review over its current target`;
}

// The freeze above is not only the review's own declared parent — it is every ancestor a posted review's
// parent chain reaches, at any depth: clearing or reparenting an intermediate link would quietly remove the
// very authorship rules.js's reviewer_coded_parent was refusing, without ever touching the review itself.
// Walked cycle-safely (seen-set per candidate review), tolerating a legacy/missing ancestor by simply ending
// that branch of the walk (never throwing, never treated as a match). A review's own current status is never
// consulted: cancelling it does not undo the freeze it already placed on the lineage it reached, so this
// still returns that review's id even when it is cancelled — see reviewAncestorLockedMessage.
export function findReviewAncestorLock(targetId, quests) {
  const byId = new Map(quests.map((q) => [q.id, q]));
  for (const candidate of quests) {
    if (candidate.kind !== 'review') continue;
    const seen = new Set();
    const stack = [...(candidate.parents || [])];
    while (stack.length) {
      const id = stack.pop();
      if (id === targetId) return candidate.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const ancestor = byId.get(id);
      if (!ancestor) continue;
      stack.push(...(ancestor.parents || []));
    }
  }
  return null;
}

// Distinct from reviewTargetLockedMessage (a review's own identity): this quest is not itself a review, but
// some posted review's ancestor walk already reaches it, so its lineage is frozen the same way. Deliberately
// does not say "cancel reviewId to unlock this" — cancelling never unlocks it; the only way to correct the
// chain is a new, correctly linked quest (and, if the review itself was wrong, a new review).
export function reviewAncestorLockedMessage(targetId, reviewId) {
  return `${targetId} is locked: ${reviewId} is a posted review whose ancestor chain reaches it, so its parents are permanently frozen here — cancelling ${reviewId} does not unlock ${targetId}; correcting the lineage needs a new package id: post a new, correctly linked quest (and a new review, if needed) instead of editing ${targetId}`;
}

// A quest's kind switches identity between "produces work" and "checks work" — once it has dispatch history
// or an assignee (ever, even if the assignee was since cleared), or once it sits in an existing review's own
// ancestor walk (even an unassigned intermediate no one has touched yet), changing its kind reopens exactly
// the bypass the two locks above close: relabel the parent as a review, or relabel the review as ordinary
// code, and reviewer_coded_parent's own author check stops seeing it. A quest that was never dispatched,
// never assigned and sits outside every existing review's reach keeps the prior free kind-correction
// behaviour — this is the one place, alongside findReviewAncestorLock, both post()'s kind guard and any
// future caller must share, so the two rules cannot drift apart.
export function kindLockReason(existing, quests) {
  if (!existing) return null;
  if (existing.kind === 'review') {
    return `${existing.id} is a posted review; its kind cannot be changed — cancelling ${existing.id} does not unlock it; correcting the kind needs a new package id, not a same-id repost of ${existing.id}`;
  }
  if ((existing.dispatches && existing.dispatches.length) || existing.assignee) {
    const protectingReview = findReviewAncestorLock(existing.id, quests);
    if (protectingReview) {
      return `${existing.id} has dispatch history or an assignee; its kind cannot be changed — it is also reached by posted review ${protectingReview} as an ancestor, and cancelling ${existing.id} would not unlock either lock; post a new, correctly linked quest under a new package id instead of reusing ${existing.id}`;
    }
    return `${existing.id} has dispatch history or an assignee; its kind cannot be changed — cancelling it does not free ${existing.id} for reuse; correcting the kind needs a new package id, not a same-id repost of ${existing.id}`;
  }
  const reviewId = findReviewAncestorLock(existing.id, quests);
  if (reviewId) {
    return `${existing.id} is reached by posted review ${reviewId} as an ancestor; its kind cannot be changed — cancelling ${existing.id} does not unlock it; correcting the kind needs a new package id, not a same-id repost of ${existing.id}`;
  }
  return null;
}

// Walks the proposed parents' own ancestor chains through already-saved quests. Every id in `parents` is
// expected to already be a key of `byId` (validateParents below checks that before this runs); a stale or
// legacy quest loaded from disk can still hold a parent id that is not, in which case that branch of the
// walk simply ends instead of throwing — cycles are only findable through ancestors that do exist.
export function findParentCycle(pkgId, parents, byId) {
  const stack = [...parents];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === pkgId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const ancestor = byId.get(id);
    if (!ancestor) continue;
    stack.push(...(ancestor.parents || []));
  }
  return false;
}

// Shared by a brand-new post and an owner-driven update alike: a parent must already be a real, posted
// quest, must not be the package itself, and must not close a cycle. A parent id that has never been
// posted is rejected here with the same message an update gives — "post the child, then post the parent
// later" is not a supported ordering; the only place that still tolerates a missing parent is dispatch-time
// (rules.js canDispatch's own parent_missing), which exists for *legacy* quests already on disk whose
// parent was removed or never existed, not for anything freshly written through this validation.
export function validateParents(pkgId, parents, byId) {
  if (parents.includes(pkgId)) return `${pkgId} cannot be its own parent`;
  const missing = parents.find((id) => !byId.has(id));
  if (missing) return `parent ${missing} not found; post it first (POST /api/quests, package ${missing}) or fix the id, then try ${pkgId} again`;
  if (findParentCycle(pkgId, parents, byId)) return `parents would create a cycle back to ${pkgId}`;
  return null;
}

// Whole-candidate validation, one field at a time: every field present in `payload` (even as an explicit
// empty string/array, which clears it) is checked and, if valid and actually different, included in
// `value`/`changes`. A field left out of `payload` entirely is never touched — a quest that already carries
// a legacy issue (say, a parent posted before this check existed) stays exactly as it is unless this update
// is the one actively changing that field, so an unrelated correction (fixing the title) is never blocked
// by it, and never re-saves it as though it had just been freshly chosen.
export function validateMetadataUpdate(config, quest, quests, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  // Object.create(null): a plain {} silently drops an assignment to the literal key "__proto__" (the
  // inherited accessor setter only accepts an object or null value, and swallows a string with no error and
  // no own property created), so a JSON-parsed body naming __proto__ as an unsupported field would pass this
  // validator's own "unknown field" contract straight through. A null-prototype object has no such accessor:
  // errors.__proto__ = '...' creates a normal own property, `Object.keys` and `JSON.stringify` both still
  // work on it exactly as on a plain object, and every field is rejected atomically as intended.
  const errors = Object.create(null);
  const value = {};
  const changes = {};

  // Whole-candidate, same as every other field here: a caller that sends status/kind/id/assignee/revision/
  // dispatches or any other typo'd key gets an actionable 400 naming it, never a silent 200 that pretends the
  // field was applied (or, worse, actually reached a field this endpoint must never touch).
  for (const key of Object.keys(input)) {
    if (!METADATA_FIELDS.includes(key) && !METADATA_TRANSPORT_FIELDS.has(key)) {
      errors[key] = `unknown field; metadata update only accepts ${METADATA_FIELDS.join(', ')} (plus by, ifRevision)`;
    }
  }

  // FB2-03: hold parks the quest until cleared with an empty hold; needs and files are the same fields
  // post() validates (update is where a hold comes off — post never carries an empty hold on purpose).
  if (input.hold !== undefined) {
    const hold = String(input.hold || '').trim().slice(0, MAX_TEXT);
    if (hold !== (quest.hold || '')) { value.hold = hold; changes.hold = { from: quest.hold || '', to: hold }; }
  }

  if (input.needs !== undefined) {
    const needs = splitList(input.needs);
    const badNeed = needs.find((n) => n.length > 64);
    if (badNeed) errors.needs = 'needs 里有过长的能力名：' + badNeed.slice(0, 80);
    else if (!sameList(needs, quest.needs || [])) { value.needs = needs; changes.needs = { from: quest.needs || [], to: needs }; }
  }

  if (input.files !== undefined) {
    const files = splitList(input.files);
    if (!sameList(files, quest.filesOverride || [])) { value.filesOverride = files; changes.files = { from: quest.filesOverride || [], to: files }; }
  }

  // FB2-04 item 5: batch names the whole group this quest ships with (including itself); waitingOn is
  // the one delivery the group is blocked behind. Both plain metadata — the board reads them for the card
  // face and the delivery reminder, they never change dispatch rules.
  if (input.batch !== undefined) {
    const idPattern = packageIdPattern(config);
    const batch = splitList(input.batch);
    const bad = batch.find((id) => !idPattern.test(id));
    if (bad) errors.batch = 'batch must be package ids, got ' + bad;
    else if (!batch.includes(quest.id)) errors.batch = quest.id + ' 的一批名单里得包含它自己';
    else if (!sameList(batch, quest.batch || [])) { value.batch = batch; changes.batch = { from: quest.batch || [], to: batch }; }
  }

  if (input.waitingOn !== undefined) {
    const waitingOn = String(input.waitingOn || '').trim();
    const idPattern = packageIdPattern(config);
    if (waitingOn && !idPattern.test(waitingOn)) errors.waitingOn = 'waitingOn must be a package id, got ' + waitingOn;
    else if (waitingOn === quest.id) errors.waitingOn = quest.id + ' 不能等它自己';
    else if (waitingOn !== (quest.waitingOn || '')) { value.waitingOn = waitingOn; changes.waitingOn = { from: quest.waitingOn || '', to: waitingOn }; }
  }

  if (input.title !== undefined) {
    const title = String(input.title || '').trim().slice(0, 120);
    if (title !== (quest.title || '')) { value.title = title; changes.title = { from: quest.title || '', to: title }; }
  }

  if (input.brief !== undefined) {
    const brief = String(input.brief || '').trim().replaceAll('\\', '/');
    if (quest.kind !== 'owner' && !brief) {
      errors.brief = 'brief is required';
    } else if (brief && !briefPathAllowed(config, brief, quest.kind)) {
      const dirs = quest.kind === 'owner' ? [...config.briefs.dispatchDirs, ...config.briefs.ownerDirs] : config.briefs.dispatchDirs;
      errors.brief = `brief must be <dir>/<file>.md with <dir> one of ${[...new Set(dirs)].join(', ')}`;
    } else if (brief !== (quest.brief || '')) {
      value.brief = brief; changes.brief = { from: quest.brief || '', to: brief };
    }
  }

  if (input.allowedLanes !== undefined) {
    const allowedLanes = splitList(input.allowedLanes);
    const badLane = allowedLanes.find((lane) => !config.lanes[lane]);
    if (badLane) {
      errors.allowedLanes = `unknown lane ${badLane}; this project defines ${Object.keys(config.lanes).join(', ')}`;
    } else if (!sameList(allowedLanes, quest.allowedLanes || [])) {
      value.allowedLanes = allowedLanes; changes.allowedLanes = { from: quest.allowedLanes || [], to: allowedLanes };
    }
  }

  if (input.conflicts !== undefined) {
    const idPattern = packageIdPattern(config);
    const conflicts = splitList(input.conflicts);
    const bad = conflicts.find((id) => !idPattern.test(id));
    if (bad) {
      errors.conflicts = `conflicts must be package ids, got ${bad}`;
    } else if (conflicts.includes(quest.id)) {
      errors.conflicts = `${quest.id} cannot conflict with itself`;
    } else if (!sameList(conflicts, quest.conflicts || [])) {
      value.conflicts = conflicts; changes.conflicts = { from: quest.conflicts || [], to: conflicts };
    }
  }

  if (input.parents !== undefined) {
    const idPattern = packageIdPattern(config);
    const parents = splitList(input.parents);
    const bad = parents.find((id) => !idPattern.test(id));
    if (bad) {
      errors.parents = `parents must be package ids, got ${bad}`;
    } else {
      const unchanged = sameList(parents, quest.parents || []);
      // Same parents, resent verbatim, is still a no-op below — only an actual change is ever refused, and
      // it is refused even when the current parent is itself a broken legacy id: readable and repairable in
      // every other field, never silently rewritten in this one.
      if (!unchanged && quest.kind === 'review') {
        errors.parents = reviewTargetLockedMessage(quest.id);
      } else {
        const protectingReview = unchanged ? null : findReviewAncestorLock(quest.id, quests);
        if (protectingReview) {
          errors.parents = reviewAncestorLockedMessage(quest.id, protectingReview);
        } else {
          const err = validateParents(quest.id, parents, new Map(quests.map((q) => [q.id, q])));
          if (err) errors.parents = err;
          else if (!unchanged) { value.parents = parents; changes.parents = { from: quest.parents || [], to: parents }; }
        }
      }
    }
  }

  if (input.needsOwner !== undefined) {
    const needsOwner = String(input.needsOwner || '').trim().slice(0, MAX_TEXT);
    if (needsOwner !== (quest.needsOwner || '')) { value.needsOwner = needsOwner; changes.needsOwner = { from: quest.needsOwner || '', to: needsOwner }; }
  }

  // FB2-06 item 7: the art review page a quest points at — plain metadata, same shape post() validates.
  if (input.reviewPage !== undefined) {
    const reviewPage = String(input.reviewPage || '').trim().slice(0, 64);
    if (reviewPage !== (quest.reviewPage || '')) { value.reviewPage = reviewPage; changes.reviewPage = { from: quest.reviewPage || '', to: reviewPage }; }
  }

  // Spread, not the errors object itself: CopyDataProperties (what a spread does) uses CreateDataProperty,
  // never the target's inherited setters, so this still carries a literal own "__proto__" key across intact
  // (see the comment above) — but the object handed back is an ordinary, Object.prototype-having plain
  // object again, exactly what every caller (deepStrictEqual in tests, Object.keys, JSON.stringify) already
  // expected an "empty errors" result to be.
  return { errors: { ...errors }, value, changes };
}
