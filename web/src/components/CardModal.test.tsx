import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Card } from '../api/types';
import type { RecentFailure } from '../api/failureTypes';
import { CardModal } from './CardModal';

// Renders the real CardModal.tsx. The failure block is read-only context; the status/reason form must stay
// untouched whether or not a failure exists, and stored text must stay plain escaped text.

function card(): Card {
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
  };
}

const failure: RecentFailure = {
  questId: 'RUN-7',
  at: '2026-09-16T08:30:00.000Z',
  summary: 'worker exited 1',
};

function render(f?: RecentFailure | null, onOpenQuest?: (questId: string) => void) {
  return renderToStaticMarkup(
    <CardModal
      card={card()}
      failure={f}
      onOpenQuest={onOpenQuest}
      onClose={() => {}}
      onSuccess={() => {}}
      onError={() => {}}
    />,
  );
}

describe('CardModal recent execution failure (real JSX)', () => {
  it('shows quest, time, bounded summary and a drawer button when the quest can be opened', () => {
    const html = render(failure, () => {});
    expect(html).toContain('最近一次执行失败');
    expect(html).toContain('RUN-7');
    const monthDay = new Date(failure.at).toLocaleDateString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
    });
    expect(html).toContain(monthDay);
    expect(html).toContain('worker exited 1');
    expect(html).toContain('查看任务');
    expect(html).toContain('fail-block');
  });

  it('renders stored text as plain escaped text, never as markup', () => {
    const html = render({ ...failure, summary: '<script>alert(1)</script>' }, () => {});
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('still shows the block without the drawer button when the quest cannot be opened', () => {
    const html = render(failure);
    expect(html).toContain('最近一次执行失败');
    expect(html).not.toContain('查看任务');
  });

  it('ignores an unusable timestamp without crashing', () => {
    const html = render({ ...failure, at: 'not-a-date' });
    expect(html).toContain('not-a-date');
  });

  it('changes nothing for a card without failure, and status editing still renders', () => {
    const html = render(null);
    expect(html).not.toContain('最近一次执行失败');
    expect(html).not.toContain('fail-block');
    expect(html).toContain('id="advStatus"');
    expect(html).toContain('id="advNote"');
    expect(html).toContain('算了');
    expect(html).toContain('盖章保存');
  });
});
