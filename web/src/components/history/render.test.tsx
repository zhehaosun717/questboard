import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DispatchEvent } from '../../api/historyEvents';
import { emptyHistoryFilters, groupEventsByTask, parseTimeBounds } from '../../lib/history';
import { HistoryEvents } from './HistoryEvents';
import { HistoryFilterBar } from './HistoryFilterBar';
import { ProjectTests } from './ProjectTests';

function ev(partial: Partial<DispatchEvent> & { seq: number; event: string }): DispatchEvent {
  return {
    at: '2026-09-12T10:00:00.000Z',
    package: 'RUN-1',
    lane: 'codex',
    model: 'gpt-5.6-luna',
    variant: 'high',
    name: 'codex-run-1',
    by: 'owner',
    detail: '',
    ...partial,
  };
}

describe('HistoryEvents render', () => {
  const events = [
    ev({ seq: 1, event: 'posted', package: 'A', lane: null, model: null, name: null }),
    ev({ seq: 2, event: 'dispatched', package: 'A', detail: '启动脚本' }),
    ev({ seq: 3, event: 'status_dispatched', package: 'A', lane: null, model: null, name: null }), // stall recovery: real, not an echo
    ev({ seq: 4, event: 'status_reviewing', package: 'A', lane: null, model: null, name: null }),
    ev({ seq: 5, event: 'delivered', package: 'A' }),
    ev({ seq: 6, event: 'delivered', package: 'B' }),
  ];
  const groups = groupEventsByTask(events);

  it('renders one block per task, newest task first, with Chinese kind labels', () => {
    const html = renderToStaticMarkup(<HistoryEvents groups={groups} />);
    expect(html).toContain('任务 B');
    expect(html).toContain('任务 A');
    expect(html.indexOf('任务 B')).toBeLessThan(html.indexOf('任务 A'));
    expect(html).toContain('交差了，待验收');
    expect(html).toContain('发布委托');
    expect(html).toContain('启动脚本');
  });

  it('renders every record as a plain visible line — no fold, no per-line package id (review 25756a14 B3/B4)', () => {
    const html = renderToStaticMarkup(<HistoryEvents groups={groups} />);
    // No folding concept survives: status_dispatched (stall recovery) and status_reviewing both show
    // as ordinary main lines, and there is no <details> to hide anything behind.
    expect(html).not.toContain('<details');
    expect(html).not.toContain('系统状态记录');
    expect(html).toContain('委托状态：进行中'); // status_dispatched's own label
    expect(html).toContain('委托状态：复核中'); // status_reviewing
    // The task id appears once, in the group heading, never repeated on the per-line strong tag
    // that used to overflow the page at 1024/1440 (B4).
    expect(html).not.toContain('hist-ev-pkg');
    expect((html.match(/>A</g) ?? []).length).toBe(1);
  });

  it('keeps real seq order for every line, status lines interleaved with main ones (B1)', () => {
    const html = renderToStaticMarkup(<HistoryEvents groups={groups} />);
    // Isolate task A's own block (B renders first, newest-first) so B's own 交差了，待验收 cannot be
    // mistaken for A's. Inside A: posted → dispatched → its recovery → reviewing → delivered, in the
    // order it actually happened.
    const aSection = html.slice(html.indexOf('任务 A'));
    const order = ['发布委托', '派出开工', '委托状态：进行中', '委托状态：复核中', '交差了，待验收'];
    const indices = order.map((label) => aSection.indexOf(label));
    expect(indices.every((i) => i >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('renders nothing for an empty group list (the parent owns the no-results line)', () => {
    const html = renderToStaticMarkup(<HistoryEvents groups={[]} />);
    expect(html).not.toContain('hist-group');
  });

  it('shows lane, model AND name together on a line that has all three (review 73f4bd71 B1)', () => {
    const html = renderToStaticMarkup(<HistoryEvents groups={groups} />);
    // seq 2 (dispatched) carries lane 'codex', model 'gpt-5.6-luna'/'high' and name 'codex-run-1' —
    // the old whoText dropped the model whenever a name was also present.
    expect(html).toContain('codex · gpt-5.6-luna/high · codex-run-1');
  });

  it('flags a record whose own time cannot be recognised, per line (revision 4)', () => {
    const withBadTime = groupEventsByTask([
      ev({ seq: 10, event: 'dispatched', package: 'C', at: 'not-a-date' }),
    ]);
    const html = renderToStaticMarkup(<HistoryEvents groups={withBadTime} />);
    expect(html).toContain('hist-ev-badtime');
    expect(html).toContain('时间未识别');
  });

  it('gives a long detail a keyboard-reachable expand control, not just a title tooltip (review 73f4bd71 B3)', () => {
    const longDetail = '详情'.repeat(60); // well past the clamp threshold
    const withLongDetail = groupEventsByTask([
      ev({ seq: 11, event: 'dispatched', package: 'D', detail: longDetail }),
    ]);
    const html = renderToStaticMarkup(<HistoryEvents groups={withLongDetail} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('展开全文');
    expect(html).toContain(longDetail); // the full real text is present, never a fabricated summary
  });

  it('a short detail has no expand control — nothing to expand into', () => {
    const withShortDetail = groupEventsByTask([
      ev({ seq: 12, event: 'dispatched', package: 'E', detail: '短' }),
    ]);
    const html = renderToStaticMarkup(<HistoryEvents groups={withShortDetail} />);
    expect(html).not.toContain('hist-ev-detail-toggle');
  });
});

describe('HistoryFilterBar render', () => {
  const options = { lanes: ['agy', 'codex'], models: ['gpt-5.6-luna'], kinds: ['dispatched', 'status_*'] };

  it('offers every loaded value and counts matches over loaded', () => {
    const html = renderToStaticMarkup(
      <HistoryFilterBar
        value={{ ...emptyHistoryFilters, packageText: 'run' }}
        options={options}
        matched={4}
        loaded={10}
        timeError={null}
        invalidAtCount={0}
        onChange={() => undefined}
        onClear={() => undefined}
        idPrefix="t"
      />,
    );
    expect(html).toContain('<option value="codex">');
    expect(html).toContain('符合条件 4 / 已加载 10 条');
    expect(html).toContain('清除筛选');
  });

  it('says how many matched records have a time the window could not judge, without hiding them', () => {
    const html = renderToStaticMarkup(
      <HistoryFilterBar
        value={{ ...emptyHistoryFilters, from: '2026-09-11T09:00' }}
        options={options}
        matched={5}
        loaded={10}
        timeError={null}
        invalidAtCount={2}
        onChange={() => undefined}
        onClear={() => undefined}
        idPrefix="t"
      />,
    );
    expect(html).toContain('2 条时间无法识别');
    // Informational, not an error: the note uses the note style, not the error one (review 25756a14
    // "give forced hints normal informational styling").
    expect(html).toContain('hist-filter-note');
    expect(html).not.toMatch(/hist-filter-error">[^<]*其中/);
  });

  it('offers a way to inspect the unrecognised-time records, not just a count (revision 4)', () => {
    const html = renderToStaticMarkup(
      <HistoryFilterBar
        value={{ ...emptyHistoryFilters, onlyInvalidAt: false }}
        options={options}
        matched={10}
        loaded={10}
        timeError={null}
        invalidAtCount={2}
        onChange={() => undefined}
        onClear={() => undefined}
        idPrefix="t"
      />,
    );
    expect(html).toContain('hist-filter-inspect');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('只看这些记录');
  });

  it('the inspect toggle reflects the active onlyInvalidAt state', () => {
    const html = renderToStaticMarkup(
      <HistoryFilterBar
        value={{ ...emptyHistoryFilters, onlyInvalidAt: true }}
        options={options}
        matched={2}
        loaded={10}
        timeError={null}
        invalidAtCount={2}
        onChange={() => undefined}
        onClear={() => undefined}
        idPrefix="t"
      />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('显示全部记录');
  });

  it('refuses an invalid time window in the open, not silently', () => {
    const bad = parseTimeBounds('乱', '');
    expect(bad.error).not.toBeNull();
    const html = renderToStaticMarkup(
      <HistoryFilterBar
        value={emptyHistoryFilters}
        options={options}
        matched={0}
        loaded={0}
        timeError={bad.error}
        invalidAtCount={0}
        onChange={() => undefined}
        onClear={() => undefined}
        idPrefix="t"
      />,
    );
    expect(html).toContain(bad.error!);
  });
});

describe('ProjectTests render', () => {
  it('labels the result as project-wide and disclaims per-task proof', () => {
    const html = renderToStaticMarkup(
      <ProjectTests
        verification={{
          steps: [
            { name: 'build', kind: 'exit', value: '0' },
            { name: 'build', kind: 'exit', value: '1' },
          ],
          done: true,
          editXml: null,
          playXml: null,
        }}
        asOf={null}
        lanesState="ok"
      />,
    );
    expect(html).toContain('项目测试');
    expect(html).toContain('不能作为任何一个委托完成的证明');
    // the duplicated step collapses into the latest verdict only
    expect(html.match(/退出码 1/g)?.length).toBe(1);
    expect(html).not.toContain('退出码 0');
  });

  it('says so plainly when a successful read genuinely found no verification configured', () => {
    const html = renderToStaticMarkup(<ProjectTests verification={null} asOf={null} lanesState="ok" />);
    expect(html).toContain('没有配置验证');
  });

  // Revision 6 F2: before the first successful lanes read, `verification` is null for a reason that has
  // nothing to do with the project's own config — the panel must say so, never claim "not configured".
  it('says it is still reading while the first lanes read is pending, never "not configured"', () => {
    const html = renderToStaticMarkup(<ProjectTests verification={null} asOf={null} lanesState="loading" />);
    expect(html).toContain('正在读取');
    expect(html).not.toContain('没有配置验证');
  });

  it('says the read failed while the first lanes read has failed, never "not configured"', () => {
    const html = renderToStaticMarkup(<ProjectTests verification={null} asOf={null} lanesState="failed" />);
    expect(html).toContain('读取失败');
    expect(html).not.toContain('没有配置验证');
  });
});
