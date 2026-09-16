import { useLayoutEffect, useRef } from 'react';
import { canReceiveFocus, isFocusStillParked } from './threadAsyncGuards';

// Duck-typed read of a form element's current value — the fallback is always the search `<input>` in
// practice, but this stays untyped-to-HTMLInputElement so the parking check works the same way
// `canReceiveFocus` does, off a plain shape rather than a DOM class.
function elementValue(el: HTMLElement | null): string | null {
  const value = (el as { value?: unknown } | null)?.value;
  return typeof value === 'string' ? value : null;
}

// G4: a busy bulk/pane-restore run disables the control the owner just invoked, which blurs it to
// <body> — catch that stranding the instant it happens (`busy` turns true) and again once the run
// settles (`busy` turns false), parking on `fallbackRef` meanwhile and handing focus back to the
// original control once it can take it again. Only <body> or the parking spot itself is ever
// redirected: focus the owner deliberately moved elsewhere in between (a click on a different row, say)
// is left alone — this is not a general "restore focus" hook, only the specific busy/disable race.
//
// The caller assigns the returned ref to whatever had focus right before starting the busy run (the
// clicked/keyboard-focused button, most often); this hook only reacts to `busy` flipping.
export function useBulkFocusRestore(
  busy: boolean,
  fallbackRef: { current: HTMLElement | null },
): { current: HTMLElement | null } {
  const openerRef = useRef<HTMLElement | null>(null);
  // R5-4: this effect also fires on mount (`useLayoutEffect`'s dep array runs it once regardless of
  // whether `busy` ever changes). Without this flag, a mount where nothing has run yet — `busy` starts
  // `false`, `document.activeElement` is `<body>` because nothing has been clicked — read exactly like
  // "a run just settled", and stole focus into `fallbackRef` (the search box) the instant the view opened.
  // Only a real `busy` transition sets this, so the restore branch below runs *only* after a run this hook
  // actually captured an opener for — never for the page simply loading with nothing focused yet.
  const pendingRestoreRef = useRef(false);
  // D6/R14b: the fallback's value at the moment it became (or already was) the parking spot — typing
  // never blurs an <input>, so `activeElement === fallbackRef.current` alone can't tell "still exactly
  // where we parked it" from "the owner started typing here since". See `isFocusStillParked`.
  const parkedValueRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    if (busy) {
      pendingRestoreRef.current = true;
      if (document.activeElement === document.body) {
        fallbackRef.current?.focus();
      }
      parkedValueRef.current = elementValue(fallbackRef.current);
      return;
    }
    if (!pendingRestoreRef.current) return;
    pendingRestoreRef.current = false;
    const opener = openerRef.current;
    openerRef.current = null;
    const parkedValue = parkedValueRef.current;
    parkedValueRef.current = null;
    // G4/R5-4: only take focus back if the owner has not since moved it themselves — <body> (the disabled
    // control's blur target) or the parking spot this same hook used while busy are the only two places a
    // deliberate restore is allowed to override; anywhere else (a different row, a different control) is
    // left alone.
    const atBody = document.activeElement === document.body;
    const atFallback = document.activeElement === fallbackRef.current;
    if (!atBody && !atFallback) return;
    // D6/R14b: still parked and untouched — a body-blur restore never has a parked value to check
    // (`isFocusStillParked` treats `null` as "nothing to compare, go ahead"), but a fallback the owner
    // typed into (its value no longer matches what was there at parking time) is deliberate focus intent
    // and a late settle must not pull focus away from it.
    if (atFallback && !isFocusStillParked(parkedValue, elementValue(fallbackRef.current))) return;
    // P8: `opener` may point at a DOM node the run's own re-render already replaced (its list row
    // reused a key, its detail pane re-mounted) — `canReceiveFocus` catches that (`isConnected` is
    // false for a detached node) so the fallback is a deliberate choice here, not an accident of
    // whichever node React happened to reuse.
    if (canReceiveFocus(opener)) {
      opener?.focus();
    } else {
      fallbackRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fallbackRef is a stable ref object identity
  }, [busy]);

  return openerRef;
}
