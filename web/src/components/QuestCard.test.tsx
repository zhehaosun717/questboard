// FB2-10 card-face facts: 上次有动静 (live.lastActivityMs), the delivered attempt's token usage with the
// oversized-system-prompt warning, the honest 用量未知 marker, and the stalled card's 查看启动日志 entry.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestCard } from './QuestCard';
import type { Quest, Snapshot } from '../api/types';

function quest(over: Partial<Quest>): Quest {
  return {
    id: 'Q-1', kind: 'code', status: 'dispatched', brief: 'docs/briefs/Q-1-x.md',
    title: 'Q-1', parents: [], conflicts: [], allowedLanes: [], needsOwner: '',
    assignee: null, dispatches: [], ...over,
  } as Quest;
}

function snap(over: Partial<Snapshot>): Snapshot {
  return {
    generatedAt: new Date().toISOString(),
    project: { name: 'P', id: 'p1', lanes: [] },
    quests: [], roster: [], eligibility: {}, env: { treeLocked: false },
    live: {}, threads: {}, reviewPages: [], unpostedBriefs: [],
    verification: null, laneLimits: {}, openQuestions: 0, ...over,
  } as Snapshot;
}

const worker = { adventurerId: 'c1', family: 'f', lane: 'opencode', model: 'm', variant: 'v', name: 'w1', at: '2026-09-20T00:00:00Z', by: 'board' };

function render(q: Quest, s: Snapshot) {
  return renderToStaticMarkup(
    <QuestCard quest={q} index={0} snap={s} pickingCardId={null} isNew={false} statusChanged={false} onSelect={() => {}} onDropCard={() => {}} />,
  );
}

describe('QuestCard — FB2-10 card-face facts', () => {
  it('shows 上次有动静 from live.lastActivityMs', () => {
    const q = quest({ assignee: { ...worker } });
    const s = snap({ live: { w1: { state: 'running', elapsed: 60000, edits: 2, lastText: '', tokens: null, lastActivityMs: Date.now() - 5 * 60000 } } });
    expect(render(q, s)).toContain('上次有动静');
  });

  it('no lastActivityMs on the live row, no such line', () => {
    const q = quest({ assignee: { ...worker } });
    const s = snap({ live: { w1: { state: 'running', elapsed: 60000, edits: 2, lastText: '', tokens: null } } });
    expect(render(q, s)).not.toContain('上次有动静');
  });

  it('a delivered attempt shows 本次 N 条消息 · 输入 X · 缓存命中 Y', () => {
    const q = quest({ status: 'delivered', assignee: { ...worker, usage: { messages: 3, firstInputTokens: 9000, inputTokens: 42000, outputTokens: 900, cacheTokens: 12000 } } });
    const html = render(q, snap({}));
    expect(html).toContain('本次 3 条消息');
    expect(html).toContain('输入 42000');
    expect(html).toContain('缓存命中 12000');
    expect(html).not.toContain('系统提示异常大');
  });

  it('firstInputTokens over 50000 is flagged red 系统提示异常大', () => {
    const q = quest({ status: 'delivered', assignee: { ...worker, usage: { messages: 1, firstInputTokens: 90000, inputTokens: 90000, outputTokens: 10, cacheTokens: 0 } } });
    const html = render(q, snap({}));
    expect(html).toContain('系统提示异常大');
    expect(html).toContain('usage-big-prompt');
  });

  it('the null usage marker reads 用量未知, never invented numbers', () => {
    const q = quest({ status: 'delivered', assignee: { ...worker, usage: null } });
    const html = render(q, snap({}));
    expect(html).toContain('用量未知');
    expect(html).not.toContain('本次');
  });

  it('a lane with no token concept (usage absent) shows nothing about usage', () => {
    const q = quest({ status: 'delivered', assignee: { ...worker } });
    const html = render(q, snap({}));
    expect(html).not.toContain('用量未知');
    expect(html).not.toContain('本次');
  });

  it('a stalled card offers 查看启动日志; other statuses do not', () => {
    const stalled = render(quest({ status: 'stalled', assignee: { ...worker } }), snap({}));
    expect(stalled).toContain('查看启动日志');
    const running = render(quest({ assignee: { ...worker } }), snap({}));
    expect(running).not.toContain('查看启动日志');
  });

  it('falls back to the dispatch history usage when the live assignee is gone (done quest)', () => {
    const q = quest({
      status: 'done', assignee: null,
      dispatches: [{ ...worker, usage: { messages: 2, firstInputTokens: null, inputTokens: 3000, outputTokens: 100, cacheTokens: 500 } }],
    });
    const html = render(q, snap({}));
    expect(html).toContain('本次 2 条消息');
  });
});

// FB2-12 item 2: a quest a machine check produced says so on its face — the owner should be able to see at
// a glance which cards the coordinator dispatched without him.
describe('QuestCard — coordinator fast track (FB2-12 item 2)', () => {
  it('shows coordinator 快速通道 with the check name', () => {
    const q = quest({ status: 'posted', origin: 'machine-check', check: 'unity recompile' });
    expect(render(q, snap({}))).toContain('coordinator 快速通道：unity recompile');
  });

  it('says nothing about the fast track on a quest that has no origin', () => {
    expect(render(quest({ status: 'posted' }), snap({}))).not.toContain('快速通道');
  });

  it('an origin with no recorded check name still shows the origin, never an empty name', () => {
    const html = render(quest({ status: 'posted', origin: 'post-delivery-check' }), snap({}));
    expect(html).toContain('coordinator 快速通道');
    expect(html).not.toContain('：<');
  });
});
