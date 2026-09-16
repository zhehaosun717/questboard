import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Card } from '../api/types';
import type { RecentFailure } from '../api/failureTypes';
import { CardBadge } from './CardBadge';

// Renders the real CardBadge.tsx. The failure line is additive historical context: it must appear next to
// (not instead of) the owner-set status and derived quota notes, and must never touch drag, keyboard or
// the card identity attributes.

function card(over: Partial<Card> = {}): Card {
  return {
    id: 'card-a',
    name: 'Card A',
    provider: 'openai',
    lane: 'oc',
    model: 'm',
    family: 'f',
    status: 'available',
    statusSince: null,
    statusReason: '',
    statusSetBy: null,
    ...over,
  };
}

const failure: RecentFailure = {
  questId: 'RUN-1',
  at: '2026-09-16T08:30:00.000Z',
  summary: 'worker exited 1',
};

function render(c: Card, f?: RecentFailure | null) {
  return renderToStaticMarkup(
    <CardBadge
      card={c}
      busyQuests={[]}
      failure={f}
      isDragging={false}
      onEdit={() => {}}
      onHover={() => {}}
      onDragStart={() => {}}
      onDragEnd={() => {}}
    />,
  );
}

describe('CardBadge recent execution failure (real JSX)', () => {
  it('shows a concise neutral recent-failure line naming the quest, never "当前不可用"', () => {
    const html = render(card(), failure);
    expect(html).toContain('最近一次执行失败');
    expect(html).toContain('RUN-1');
    expect(html).toContain('fail-flag');
    expect(html).not.toContain('当前不可用');
  });

  it('shows nothing new when there is no failure (old server or no history)', () => {
    const html = render(card(), null);
    expect(html).not.toContain('最近一次执行失败');
    expect(html).not.toContain('fail-flag');
  });

  it('leaves an owner-paused card with its own status line, drag and keyboard attributes intact', () => {
    const html = render(
      card({ status: 'paused', statusSince: '2026-09-01T00:00:00.000Z', statusReason: '手动停用' }),
      failure,
    );
    expect(html).toContain('手动停用');
    expect(html).toContain('最近一次执行失败');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-adv="card-a"');
    expect(html).toContain('draggable="false"');
  });

  it('leaves a quota-limited card with its derived auto note next to the failure line', () => {
    const html = render(
      card({ status: 'limited', derived: { from: 'lanes', reason: '额度限额中' } }),
      failure,
    );
    expect(html).toContain('额度限额中');
    expect(html).toContain('自动判断，限额过去后自动恢复');
    expect(html).toContain('最近一次执行失败');
  });
});
