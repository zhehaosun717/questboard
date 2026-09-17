import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Card } from '../api/types';
import type { RecentFailure } from '../api/failureTypes';
import { DEFAULT_LOCALE, setLocale } from '../lib/i18n';
import { CardModal, decideSave } from './CardModal';

// Renders the real CardModal.tsx. The failure block is read-only context; the status/reason form must stay
// untouched whether or not a failure exists, and stored text must stay plain escaped text.

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
  questId: 'RUN-7',
  at: '2026-09-16T08:30:00.000Z',
  summary: 'worker exited 1',
};

function render(f?: RecentFailure | null, onOpenQuest?: (questId: string) => void, c: Card = card()) {
  return renderToStaticMarkup(
    <CardModal
      card={c}
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
    const monthDay = new Date(failure.at as string).toLocaleDateString('zh-CN', {
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

  it('F4: shows 时间未知 instead of dropping the failure when at is null (legacy, no provable time)', () => {
    const html = render({ ...failure, at: null });
    expect(html).toContain('最近一次执行失败');
    expect(html).toContain('时间未知');
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

describe('CardModal status form seeds from the base (manual) layer, not the effective one', () => {
  it('seeds the select from baseStatus and the reason from baseReason, not the derived-limited status', () => {
    const html = render(
      null,
      undefined,
      card({
        status: 'limited',
        baseStatus: 'available',
        baseReason: '',
        statusReason: '',
        derived: { from: 'lanes', reason: 'codex 限额中，10:50 AM 恢复', at: '2026-09-16T08:00:00.000Z', resetsAt: '2099-01-01T00:00:00.000Z' },
      }),
    );
    // React SSR reflects a controlled <select>'s current value as the `selected` attribute on that option.
    expect(html).toMatch(/<option value="available" selected[^>]*>空闲<\/option>/);
    expect(html).not.toMatch(/<option value="limited" selected/);
  });

  it('shows the derived reason read-only, with its judged time and an honest unknown-reset note', () => {
    const html = render(
      null,
      undefined,
      card({
        status: 'limited',
        baseStatus: 'available',
        derived: { from: 'lanes', reason: 'codex 限额中', at: '2026-09-16T08:00:00.000Z', resetsAt: null },
      }),
    );
    expect(html).toContain('自动判断：codex 限额中');
    expect(html).toContain('重置时间未知');
    expect(html).toContain('确认额度已恢复');
    expect(html).toContain('不会向服务商核实额度是否真的恢复');
  });

  it('shows a real reset time instead of "重置时间未知" once one is known', () => {
    const html = render(
      null,
      undefined,
      card({
        status: 'limited',
        baseStatus: 'available',
        derived: { from: 'lanes', reason: 'codex 限额中', at: '2026-09-16T08:00:00.000Z', resetsAt: '2099-01-01T00:00:00.000Z' },
      }),
    );
    expect(html).not.toContain('重置时间未知');
    expect(html).toContain('预计');
    expect(html).toContain('恢复');
  });

  it('renders nothing derived for a plainly manual (non-derived) card', () => {
    const html = render(null, undefined, card({ status: 'paused', baseStatus: 'paused', statusReason: '手动停用' }));
    expect(html).not.toContain('自动判断');
    expect(html).not.toContain('确认额度已恢复');
    expect(html).toMatch(/<option value="paused" selected[^>]*>暂停<\/option>/);
  });

  it('B2: the derived note overrides its color for the cream .order paper, staying readable', () => {
    const html = render(
      null,
      undefined,
      card({
        status: 'limited',
        baseStatus: 'available',
        derived: { from: 'lanes', reason: 'codex 限额中', at: '2026-09-16T08:00:00.000Z', resetsAt: null },
      }),
    );
    expect(html).toMatch(/class="a-note derived" role="note" style="color:var\(--ink\)"/);
  });
});

describe('B1: a second 确认额度已恢复 must always write, never a silent no-op', () => {
  it('writes when nothing changed but the confirm action was just used (base already holds the confirm text)', () => {
    // codex-astra style: an earlier confirm already set base to available/已手动确认额度恢复; newer
    // evidence re-limited the card, and the owner clicks 确认额度已恢复 again — status/reason end up
    // identical to base, but this must still write, not silently close.
    const write = decideSave(
      { status: 'available', reason: '已手动确认额度恢复', confirmed: true },
      { status: 'available', reason: '已手动确认额度恢复' },
    );
    expect(write).toBe(true);
  });

  it('still treats an untouched save as a no-op (unchanged requirement)', () => {
    const write = decideSave(
      { status: 'available', reason: '', confirmed: false },
      { status: 'available', reason: '' },
    );
    expect(write).toBe(false);
  });

  it('writes an explicit change even without the confirm flag', () => {
    const write = decideSave(
      { status: 'paused', reason: '手动停用', confirmed: false },
      { status: 'available', reason: '' },
    );
    expect(write).toBe(true);
  });
});

describe('CardModal language switch (item 38 follow-up)', () => {
  afterEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it('renders every converted label in English, with no residual CJK outside user content', () => {
    setLocale('en');
    const html = render(
      failure,
      () => {},
      card({
        status: 'limited',
        baseStatus: 'available',
        derived: { from: 'lanes', reason: 'quota limited', at: '2026-09-16T08:00:00.000Z', resetsAt: null },
      }),
    );
    expect(html).toContain('ID CARD');
    expect(html).toContain('Model');
    expect(html).toContain('Lane');
    expect(html).toContain('Most recent failed run');
    expect(html).toContain('Quest');
    expect(html).toContain('Time');
    expect(html).toContain('View quest');
    expect(html).toContain('Auto-detected: quota limited');
    expect(html).toContain('Reset time unknown');
    expect(html).toContain('Confirm quota restored');
    expect(html).toContain('Never mind');
    expect(html).toContain('Save');
    // CONFIRM_RESTORED_REASON is deliberately excluded from translation (see the source comment): it is
    // written to the server, so it never appears here anyway since no confirm click happened.
    const stripped = html.replace(/quota limited/g, '');
    expect(stripped).not.toMatch(/[一-鿿]/);
  });
});
