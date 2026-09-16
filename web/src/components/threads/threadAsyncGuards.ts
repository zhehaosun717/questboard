// Pure, DOM-free guards for the races an async thread view can hit: a project switch, a route change
// while a bulk run or a detail load is in flight, or a delete confirmation whose selection emptied out
// from under it. Kept framework-free so the exact decision a race depends on is testable with deferred
// promises, not just asserted from rendered markup.

// Runs `task`, then applies its result only if `isCurrent()` still says yes once it settles. A response
// that arrives after the thing it targeted (project, active thread, route) has moved on is dropped
// instead of overwriting newer UI state. This does not cancel the underlying request — the fetch already
// went out — it only decides whether the response still gets to write anything.
export async function runIfCurrent<T>(
  task: () => Promise<T>,
  isCurrent: () => boolean,
  apply: (value: T) => void,
): Promise<void> {
  let value: T;
  try {
    value = await task();
  } catch (err) {
    if (isCurrent()) throw err;
    return;
  }
  if (isCurrent()) apply(value);
}

// A monotonic token for "which project generation is this response for". Bump on every project change
// (including the first known id); a response is current only while its captured token still matches.
export function createGenerationTracker(): {
  bump: () => number;
  current: () => number;
} {
  let gen = 0;
  return {
    bump: () => (gen += 1),
    current: () => gen,
  };
}

// Whether a focus target can actually receive focus right now: still in the document and not disabled.
// Duck-typed (not `instanceof HTMLElement`) so it is testable with plain objects, not just real DOM nodes.
export function canReceiveFocus(
  el: { isConnected: boolean; disabled?: boolean } | null | undefined,
): boolean {
  return Boolean(el && el.isConnected && !el.disabled);
}

// F5(b): once the whole selection has been pruned away (every ticked row left the visible list — trashed
// or closed out from under a poll), an open trash-confirm dialog is stale too. Clearing it here means the
// next checkbox tick opens a fresh, deliberate confirmation instead of resurrecting this one unsolicited.
export function shouldCloseConfirmAfterPrune(
  nextSelectedCount: number,
  confirmTrashOpen: boolean,
): boolean {
  return nextSelectedCount === 0 && confirmTrashOpen;
}

// G1: the recycle-bin toggle, the status filter and the search text together identify which rows a list
// response actually belongs to — not just whichever of the three changed most recently. `committed` is the
// scope captured when the currently-rendered `threads` array was written; `current` is what the owner is
// looking at right now. They can drift apart the instant any one of the three changes, before the matching
// response has landed, and during that window the old rows must not render as if they were still valid.
//
// D7: `projectId` is part of this identity too, and deliberately compared at *render* time against the
// live prop — not against a generation counter that only bumps inside a passive effect. On the commit
// where a project switch lands, the counter hasn't bumped yet (the effect that bumps it runs after this
// render), but the `projectId` prop passed to the component has already changed; comparing straight
// against it is what closes the "new header, old rows" one-paint window instead of only papering over it
// with effect timing.
export interface ListScope {
  trashView: boolean;
  status: string;
  q: string;
  projectId?: string;
}

export function isSameListScope(committed: ListScope | null, current: ListScope): boolean {
  return (
    committed !== null &&
    committed.trashView === current.trashView &&
    committed.status === current.status &&
    committed.q === current.q &&
    committed.projectId === current.projectId
  );
}

// D6/R14b: a busy/disable focus-restore hook parks focus on a fallback element (the search box) while its
// run is in flight, meaning to hand it back to the original control once the run settles. But typing into
// that fallback never moves `document.activeElement` away from it — an <input> stays focused while its
// value changes — so "focus is still on the parking spot" alone can't tell "untouched, safe to override"
// from "the owner started using it, leave them alone". Comparing the fallback's value at parking time
// against its value at settle time can: `parkedValue` is null when nothing was parked (the check that
// calls this only runs once something was), and any change of a non-null parked value is read as
// deliberate focus intent, never overridden.
export function isFocusStillParked(parkedValue: string | null, currentValue: string | null): boolean {
  return parkedValue === null || currentValue === parkedValue;
}
