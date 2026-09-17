import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeAssignee, makeQuest, makeSnapshot } from '../lib/testFixtures';
import { cancelActionFor, cancelReasonPromptFor, QuestDrawer } from './QuestDrawer';

const noop = () => undefined;

function render(quest: ReturnType<typeof makeQuest>, snap: ReturnType<typeof makeSnapshot>) {
  return renderToStaticMarkup(
    <QuestDrawer
      quest={quest}
      snap={snap}
      draft=""
      onDraftChange={noop}
      onClose={noop}
      onSelectQuest={noop}
      onAssignCard={noop}
      refresh={noop}
      pushToast={noop}
      setDragging={noop}
    />,
  );
}

describe('QuestDrawer 修改委托 hook-in', () => {
  it('routes only dispatched attempts through the new cancellation request', () => {
    expect(cancelActionFor('dispatched')).toBe('request');
    expect(cancelActionFor('stalled')).toBe('held-status');
    expect(cancelReasonPromptFor('request')).toBe('请写明取消原因');
    expect(cancelReasonPromptFor('request')).not.toContain('停止');
    expect(cancelReasonPromptFor('request')).not.toContain('释放');
    expect(cancelReasonPromptFor('held-status')).toContain('如何确认这个冒险者已经停止');
    expect(cancelReasonPromptFor('status')).toBeNull();
    for (const status of ['posted', 'needs_owner', 'delivered', 'reviewing'] as const) {
      expect(cancelActionFor(status)).toBe('status');
    }
  });

  it('shows a collapsed 修改委托 section, below 下一步/evidence and above 交回的东西 (RECEIPT)', () => {
    const quest = makeQuest({ id: 'A-1', status: 'delivered', lastDetail: 'owner 验收' });
    const snap = makeSnapshot({ quests: [quest] });
    const html = render(quest, snap);
    expect(html).toContain('修改委托');
    // Anchor on the DrawerSection headings themselves (<span>EN</span>zh), not any mention of the words
    // elsewhere — ReviewSection's own hint text also says "交回的东西" earlier in the drawer.
    expect(html.indexOf('修改委托')).toBeGreaterThan(html.indexOf('<span>EVIDENCE</span>'));
    expect(html.indexOf('修改委托')).toBeLessThan(html.indexOf('<span>RECEIPT</span>'));
  });

  it('is collapsed by default — no form fields rendered until opened', () => {
    const quest = makeQuest({ id: 'A-1' });
    const snap = makeSnapshot({ quests: [quest] });
    const html = render(quest, snap);
    expect(html).toContain('<details');
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).not.toContain('标题');
    expect(html).not.toContain('前置委托');
  });

  it('shows a manual resolve control for scoped cancellation evidence while keeping the attempt visible', () => {
    const quest = makeQuest({
      id: 'A-1',
      status: 'dispatched',
      assignee: makeAssignee('card-1'),
      cancelRequest: {
        requestId: 'req-1', attemptId: 'attempt-1', at: '2026-09-13T00:00:00.000Z', bySource: 'ui',
        reason: 'stop', result: 'stopped_by_wrapper', detail: 'direct child only',
      },
    });
    const html = render(quest, makeSnapshot({ quests: [quest] }));
    expect(html).toContain('确认已停止并人工释放');
    expect(html).toContain('ON QUEST');
  });

  it('shows the live worker heartbeat age in the ON QUEST block', () => {
    const quest = makeQuest({ id: 'A-1', status: 'dispatched', assignee: makeAssignee('card-1') });
    const snap = makeSnapshot({
      quests: [quest],
      live: {
        [quest.assignee!.name]: {
          state: 'running', elapsed: 5000, edits: 0, lastText: '', tokens: null,
          heartbeat: { at: '2026-09-13T00:00:00.000Z', ageMs: 7000, token: 'run-token', phase: 'running' },
        },
      },
    });
    const html = render(quest, snap);
    expect(html).toContain('最近心跳：7 秒前');
  });

  it('shows the API cancellation note and manual resolve control for stopped_by_api', () => {
    const quest = makeQuest({
      id: 'A-api',
      status: 'dispatched',
      assignee: makeAssignee('card-1'),
      cancelRequest: {
        requestId: 'req-api', attemptId: 'attempt-api', at: '2026-09-13T00:00:00.000Z', bySource: 'ui',
        reason: 'stop', result: 'stopped_by_api', detail: '后续读取确认 session 已结束',
      },
    });
    const html = render(quest, makeSnapshot({ quests: [quest] }));
    expect(html).toContain('后续读取确认 session 已结束');
    expect(html).toContain('确认已停止并人工释放');
  });

  it('shows the bound reason and manual-required note for a stalled attempt without an adapter', () => {
    const quest = makeQuest({
      id: 'A-3', status: 'stalled', assignee: makeAssignee('card-1'),
      lastDetail: '超过消息上限 10 条 | manual_required：无法自动停止，请手动处理',
    });
    const html = render(quest, makeSnapshot({ quests: [quest] }));
    expect(html).toContain('超过消息上限 10 条');
    expect(html).toContain('无法自动停止，请手动处理');
  });

  it('shows an existing cancellation request state without the no-adapter manual hint', () => {
    for (const result of ['pending', 'stopped_by_wrapper'] as const) {
      const quest = makeQuest({
        id: `A-${result}`, status: 'stalled', assignee: makeAssignee('card-1'),
        lastDetail: '超过时长上限 1 分钟',
        cancelRequest: {
          requestId: 'req-1', attemptId: 'attempt-1', at: '2026-09-13T00:00:00.000Z', bySource: 'limit',
          reason: '超过时长上限 1 分钟', result,
        },
      });
      const html = render(quest, makeSnapshot({ quests: [quest] }));
      expect(html).toContain(result);
      expect(html).not.toContain('无法自动停止，请手动处理');
    }
  });

  it('shows the binding source and counts for a linked review page (feedback 11)', () => {
    const quest = makeQuest({ id: 'A-2', kind: 'art', reviewPage: 'p1' });
    const snap = makeSnapshot({
      quests: [quest],
      reviewPages: [
        { page: 'p1', title: '角色A', url: '/review/art/charA/final.html', total: 2, answered: 1 },
      ],
    });
    const html = render(quest, snap);
    expect(html).toContain('绑定来源：评审目录/art/charA/final.html');
    expect(html).toContain('已批注 1/2');
  });
});
