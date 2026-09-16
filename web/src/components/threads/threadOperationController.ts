// Pure, DOM-free ownership primitive for every write ThreadsView drives (reply, pin, close, bulk,
// restore). Complements threadAsyncGuards.ts, which already covers reads (`runIfCurrent`, list-call
// ordering, list scope) — this file is the write half: exactly one POST per activation, and a settling
// response can only touch state it still owns.
//
// The matrix this replaces (revision5 left `stillCurrentPane` copied at :481, :498, :543 and no
// synchronous lock at all for bulk/restore/pin/close — see QB-FB-REVIEW-THREAD5-report.md R5-1/R5-3):
//
//   operation | scope (what "current" means)        | synchronous lock | pane reload on success
//   ----------|---------------------------------------|-------------------|------------------------
//   reply     | project generation + pane epoch      | yes (own slot)     | this pane only
//   pin/close | project generation + pane epoch      | yes (shared slot)  | this pane only
//   bulk      | project generation                   | yes (shared slot)  | list always; pane if it
//   restore   | project generation                   | yes (shared slot)  | started on the target id
//   create    | project generation                   | no (see below)     | navigates if still current
//
// "Pane epoch" is a second counter, independent of the project generation, bumped every time the route's
// active thread id changes — including a change back to an id already visited (X→Y→X). Two visits to the
// same thread in the same project are NOT the same pane generation: an operation begun on the first visit
// must never be mistaken for current on the second, even though the project generation and the thread id
// are both unchanged.
//
// Create has no synchronous lock: the modal's own `submitting` render state already blocks a double
// submit, and a create's target isn't an existing pane to fight over — only the project-generation check
// on its completion callback matters (see NewThreadModal.tsx / useThreadWriteOperations.ts).

let nextOpId = 0;

export interface OperationToken {
  readonly opId: number;
  readonly scope: string;
  readonly generation: string;
}

export interface OperationSlot {
  // Synchronous, before any `await`: the only thing that can tell a same-task double-activation (two
  // keydowns, a double click) apart from a legitimate new one. Returns null — no token, caller must bail
  // out — when an operation for this exact `generation` is already in flight. A held token from a
  // *different* generation (a stale, orphaned op whose scope has since moved on) does not block a new
  // one: it is superseded here, and its eventual `release` becomes a safe no-op (see below).
  begin(generation: string): OperationToken | null;
  // Whether `token` is still this slot's current holder for `generation`. A response for a generation the
  // owner has since left is not current even if nothing has called `release` yet.
  isCurrent(token: OperationToken, generation: string): boolean;
  // Clears the slot only if `token` is still the current holder — "release only its own token". Call this
  // unconditionally in `finally`: for a superseded token it is already a no-op (a newer op's `begin` has
  // moved the slot on), so it never needs an `isCurrent` guard of its own.
  release(token: OperationToken): void;
  // For rendering/tests only: is *this exact* generation currently holding the slot. An orphaned token
  // from an abandoned generation reads as not-busy here even before it resolves.
  isHeld(generation: string): boolean;
}

export function createOperationSlot(scope: string): OperationSlot {
  let held: OperationToken | null = null;
  return {
    begin(generation) {
      if (held && held.generation === generation) return null;
      const token: OperationToken = { opId: (nextOpId += 1), scope, generation };
      held = token;
      return token;
    },
    isCurrent(token, generation) {
      return held !== null && held.opId === token.opId && token.generation === generation;
    },
    release(token) {
      if (held !== null && held.opId === token.opId) held = null;
    },
    isHeld(generation) {
      return held !== null && held.generation === generation;
    },
  };
}

// Opaque scope keys. Plain string comparison is all any caller needs — these exist so no handler ever
// hand-rolls its own concatenation (and risks a collision, e.g. gen 1 pane 23 vs gen 12 pane 3).
export function projectGeneration(projectGen: number): string {
  return `p${projectGen}`;
}

export function paneGeneration(projectGen: number, paneEpoch: number): string {
  return `p${projectGen}:e${paneEpoch}`;
}
