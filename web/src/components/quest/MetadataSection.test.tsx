import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { makeQuest, makeSnapshot } from '../../lib/testFixtures';
import {
  focusAfterCancel, holdsSlotMessage, MetadataSection, unmountEffect,
} from './MetadataSection';

const noop = () => undefined;

describe('MetadataSection collapsed shell (real JSX, SSR)', () => {
  it('renders collapsed with no fields until opened — a real mount can only open it via a toggle event, which SSR never fires', () => {
    const quest = makeQuest({ id: 'A-1' });
    const snap = makeSnapshot({ quests: [quest] });
    const html = renderToStaticMarkup(
      <MetadataSection quest={quest} snap={snap} refresh={noop} pushToast={noop} />,
    );
    expect(html).toContain('修改委托');
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).not.toContain('标题');
  });
});

// B1: React 19 StrictMode (main.tsx) runs an effect's setup -> cleanup -> setup on every mount, in that
// order, before the component is considered actually mounted. A guard ref that only ever gets set in
// cleanup (never reset in setup) survives that cycle stuck at its cleanup value forever, so every branch
// downstream of `if (unmountedRef.current) return;` in save() becomes permanently dead — the busy state
// never clears and no toast/refresh ever runs, even though the request actually succeeded. This drives the
// exact same setup/cleanup pair `useEffect(() => unmountEffect(unmountedRef), [])` calls, without needing a
// DOM (not installed here) to mount React and trigger it via a real StrictMode double-invoke.
describe('B1: unmountEffect survives a StrictMode mount -> cleanup -> mount cycle', () => {
  it('resets the ref to false on every setup, so a simulated remount does not leave it stuck true', () => {
    const ref = { current: false };
    const cleanup1 = unmountEffect(ref); // first (StrictMode-simulated) mount
    expect(ref.current).toBe(false);
    cleanup1(); // StrictMode's simulated unmount
    expect(ref.current).toBe(true);
    const cleanup2 = unmountEffect(ref); // the real mount that follows
    expect(ref.current).toBe(false); // must not still read true — this is exactly the B1 bug
    cleanup2(); // the eventual real unmount
    expect(ref.current).toBe(true);
  });
});

// B2: the real 409 body for a holds_slot refusal (src/server/questRoutes.js) puts the owner-facing
// explanation only in `reasons[0].message`; `err.message` is the bare English `'refused'`. Uses the exact
// shape the server sends, not a hand-mocked one.
describe('B2: holdsSlotMessage shows the server\'s reason, never the bare "refused"', () => {
  it('reads the holds_slot reason out of the real 409 shape', () => {
    const err = new ApiError('refused', [{ code: 'holds_slot', message: 'HOLD-1 有 worker 占着（dispatched），先释放再改' }]);
    expect(holdsSlotMessage(err)).toBe('HOLD-1 有 worker 占着（dispatched），先释放再改');
  });

  it('falls back to err.message if a future server ever omits reasons for this code', () => {
    const err = new ApiError('refused', [{ code: 'something_else', message: 'x' }]);
    expect(holdsSlotMessage(err)).toBe('refused');
  });
});

// N2: Cancel collapses the section and removes the Cancel button (the element that had focus) from the DOM
// with it. No DOM library is installed here (see the note above), so this hand-rolls the one behaviour these
// tests need from the real DOM: document.activeElement reflects whichever element's focus() was last
// called — enough to prove focusAfterCancel actually calls it, without mounting React.
function makeFocusable(name: string, document: { activeElement: unknown }) {
  const el = { name, focus: () => { document.activeElement = el; } };
  return el;
}

describe('N2: focus after Cancel never falls back to <body>', () => {
  it('refocuses the section summary — the closest thing this UI has to an "edit" toggle', () => {
    const document = { activeElement: null as unknown };
    const summary = makeFocusable('summary', document);
    focusAfterCancel(summary);
    expect(document.activeElement).toBe(summary);
  });

  it('does nothing (never throws) if the summary ref was never attached', () => {
    expect(() => focusAfterCancel(null)).not.toThrow();
    expect(() => focusAfterCancel(undefined)).not.toThrow();
  });
});
