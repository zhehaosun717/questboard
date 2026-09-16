import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeCard } from '../../lib/testFixtures';
import { RosterCardRow } from './RosterCardRow';

// Renders the real RosterCardRow.tsx. Feedback9 row 4/5: a derived-limited card must show why (derived.reason)
// and its base/effective split, the hint must say the card is still in the roster, and edit/duplicate/delete
// must stay enabled for a derived card (only real ownership protection may disable them).

const noop = () => undefined;

function render(card: ReturnType<typeof makeCard>) {
  return renderToStaticMarkup(
    <table>
      <tbody>
        <RosterCardRow card={card} onOpenStatus={noop} onEdit={noop} onDuplicate={noop} onDelete={noop} />
      </tbody>
    </table>,
  );
}

describe('RosterCardRow derived status (real JSX)', () => {
  it('shows the derived reason and the base/effective split for a limited-by-lanes card', () => {
    const card = makeCard('card-a', {
      status: 'limited',
      baseStatus: 'available',
      derived: { from: 'lanes', reason: 'codex 限额中，10:50 AM 恢复', at: '2026-09-16T08:00:00.000Z', resetsAt: '2099-01-01T00:00:00.000Z' },
    });
    const html = render(card);
    expect(html).toContain('codex 限额中，10:50 AM 恢复');
    expect(html).toContain('基础状态：空闲');
  });

  it('never says the card is not in the roster', () => {
    const card = makeCard('card-a', {
      status: 'limited',
      baseStatus: 'available',
      derived: { from: 'lanes', reason: 'codex 限额中', at: '2026-09-16T08:00:00.000Z', resetsAt: null },
    });
    const html = render(card);
    expect(html).not.toContain('不在名册里');
    expect(html).toContain('仍在名册里');
    expect(html).toContain('（重置时间未知）');
  });

  it('leaves edit/duplicate/delete enabled for a derived-status card', () => {
    const card = makeCard('card-a', {
      status: 'limited',
      baseStatus: 'available',
      derived: { from: 'lanes', reason: 'codex 限额中', at: '2026-09-16T08:00:00.000Z', resetsAt: null },
    });
    const html = render(card);
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('disabled>');
  });

  it('shows no derived hint or split for a plainly manual card', () => {
    const card = makeCard('card-a', { status: 'paused', baseStatus: 'paused', statusReason: '手动停用' });
    const html = render(card);
    expect(html).not.toContain('derived-hint');
    expect(html).not.toContain('基础状态');
    expect(html).not.toContain('基础原因');
  });

  it('N4: labels the older manual reason on a derived row so it is not read as the current limit reason', () => {
    const card = makeCard('card-a', {
      status: 'limited',
      baseStatus: 'available',
      statusReason: '已手动确认额度恢复',
      derived: { from: 'lanes', reason: 'codex 限额中', at: '2026-09-16T08:00:00.000Z', resetsAt: null },
    });
    const html = render(card);
    expect(html).toContain('基础原因：已手动确认额度恢复');
  });
});
