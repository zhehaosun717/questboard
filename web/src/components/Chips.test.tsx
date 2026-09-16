import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeCard, makeSnapshot } from '../lib/testFixtures';
import { Chips } from './Chips';

// Renders the real Chips.tsx. Feedback9 row 5/N18: snapshot.laneLimits[lane] can keep a card the owner has
// since manually re-limited (no more `derived`) — the chip must still say 限额中, but must never show that
// kept card's stale bounce `until` once it is no longer the automatic reason.

function laneLimit(over: Partial<{ until: string | null; adventurerId: string }> = {}) {
  return {
    since: '2026-09-16T08:00:00.000Z',
    at: '2026-09-16T08:00:00.000Z',
    until: '10:50 AM',
    resetsAt: '2099-01-01T00:00:00.000Z',
    adventurerId: 'card-a',
    name: 'a',
    cards: {},
    ...over,
  };
}

describe('Chips lane-limit wording (real JSX)', () => {
  it('shows the recovery time for a card that is still automatically (derived) limited', () => {
    const card = makeCard('card-a', {
      status: 'limited',
      derived: { from: 'lanes', reason: 'codex 限额中，10:50 AM 恢复', at: '2026-09-16T08:00:00.000Z', resetsAt: '2099-01-01T00:00:00.000Z' },
    });
    const snap = makeSnapshot({ roster: [card], laneLimits: { codex: laneLimit() } });
    const html = renderToStaticMarkup(<Chips snap={snap} connected error={null} />);
    expect(html).toContain('codex 限额中，10:50 AM 恢复');
  });

  it('drops the stale recovery time once the kept card is manually limited (no derived)', () => {
    const card = makeCard('card-a', { status: 'limited', statusReason: '手动限额' });
    const snap = makeSnapshot({ roster: [card], laneLimits: { codex: laneLimit() } });
    const html = renderToStaticMarkup(<Chips snap={snap} connected error={null} />);
    expect(html).toContain('codex 限额中');
    expect(html).not.toContain('10:50 AM');
  });

  it('shows no recovery time when the limit entry itself has none', () => {
    const card = makeCard('card-a', {
      status: 'limited',
      derived: { from: 'lanes', reason: 'codex 限额中', at: '2026-09-16T08:00:00.000Z', resetsAt: null },
    });
    const snap = makeSnapshot({ roster: [card], laneLimits: { codex: laneLimit({ until: null }) } });
    const html = renderToStaticMarkup(<Chips snap={snap} connected error={null} />);
    expect(html).toContain('codex 限额中');
    expect(html).not.toContain('恢复');
  });

  it('B3: never shows a dated recovery text once resetsAt is null (dated Codex-style until)', () => {
    const card = makeCard('card-a', {
      status: 'limited',
      derived: { from: 'lanes', reason: 'codex 限额中', at: '2026-09-16T08:00:00.000Z', resetsAt: null },
    });
    const limit = { ...laneLimit({ until: 'Sep 1st, 2026 1:54 PM' }), resetsAt: null };
    const snap = makeSnapshot({ roster: [card], laneLimits: { codex: limit } });
    const html = renderToStaticMarkup(<Chips snap={snap} connected error={null} />);
    expect(html).toContain('codex 限额中');
    expect(html).not.toContain('Sep 1st, 2026 1:54 PM');
  });

  it('B3: never shows a recovery time that has already passed', () => {
    const card = makeCard('card-a', {
      status: 'limited',
      derived: { from: 'lanes', reason: 'codex 限额中', at: '2026-09-16T08:00:00.000Z', resetsAt: '2020-01-01T00:00:00.000Z' },
    });
    const limit = { ...laneLimit(), resetsAt: '2020-01-01T00:00:00.000Z' };
    const snap = makeSnapshot({ roster: [card], laneLimits: { codex: limit } });
    const html = renderToStaticMarkup(<Chips snap={snap} connected error={null} />);
    expect(html).toContain('codex 限额中');
    expect(html).not.toContain('10:50 AM');
  });
});
