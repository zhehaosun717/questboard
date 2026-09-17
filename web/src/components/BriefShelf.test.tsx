import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BriefDiscovery, UnpostedBrief } from '../api/types';
import { DEFAULT_LOCALE, setLocale } from '../lib/i18n';
import { BriefShelf } from './BriefShelf';

// Renders the real BriefShelf.tsx (not a stand-in). Requirement 2 (revision 3): the old/dispatched counts
// and the "还有 N 项未列出" line must stay truthful even when the server's excluded list is capped at 300
// rows — these are computed from briefDiscovery.byKind/excludedTotal, never by counting the (possibly
// capped) excluded array on this side, so a folder with many more than 300 skipped files must never render
// "0" for a kind that genuinely has entries.

const brief = (id: string): UnpostedBrief => ({ package: id, brief: `docs/briefs/${id}-x.md`, title: `${id} title`, writtenAt: '2026-09-16T00:00:00.000Z' });

function discovery(overrides: Partial<BriefDiscovery> = {}): BriefDiscovery {
  return {
    scannedAt: '2026-09-16T00:00:00.000Z',
    folders: ['docs/briefs'],
    recentDays: 7,
    excluded: [],
    excludedTotal: 0,
    excludedTruncated: false,
    byKind: {},
    errors: [],
    truncated: false,
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof BriefShelf>[0]> = {}) {
  return renderToStaticMarkup(<BriefShelf unpostedBriefs={[]} {...props} />);
}

describe('BriefShelf (real render)', () => {
  it('with no briefDiscovery, behaves exactly as the plain list did before this field existed', () => {
    const html = render({ unpostedBriefs: [brief('RUN-1')] });
    expect(html).toContain('RUN-1');
    expect(html).not.toContain('为什么还有');
  });

  it('empty shelf still reads as "nothing new", not broken', () => {
    const html = render({ unpostedBriefs: [] });
    expect(html).toContain('没有待发布的 brief');
  });

  it('shows the true old/dispatched counts even when the excluded rows behind them were capped out of the payload', () => {
    // 305 unrelated badId exclusions ate the whole MAX_EXCLUDED=300 budget server-side, so the actual old and
    // dispatched rows never made it into `excluded` at all — byKind must still carry their true counts.
    const html = render({
      briefDiscovery: discovery({
        excluded: Array.from({ length: 300 }, (_, i) => ({ brief: `docs/briefs/notes-${i}.md`, reason: '文件名不像委托编号', kind: 'badId' as const })),
        excludedTotal: 307,
        excludedTruncated: true,
        byKind: { badId: 305, old: 1, dispatched: 1 },
      }),
    });
    expect(html).toContain('也显示超出时间窗口的 1 份');
    expect(html).toContain('也显示已在别处派遣过的 1 份');
    expect(html).not.toContain('的 0 份');
  });

  it('the "还有 N 项未列出" line accounts for rows that did not survive the cap, not just the ones shown', () => {
    const html = render({
      briefDiscovery: discovery({
        excluded: Array.from({ length: 300 }, (_, i) => ({ brief: `docs/briefs/notes-${i}.md`, reason: '文件名不像委托编号', kind: 'badId' as const })),
        excludedTotal: 350,
        excludedTruncated: true,
        byKind: { badId: 350 },
      }),
    });
    // "为什么还有 350 个文件没出现" button label uses the true other-kind total (350), not the 300 shown.
    expect(html).toContain('为什么还有 350 个文件没出现');
  });

  it('never shows a stale "为什么还有" prompt when every exclusion is old/dispatched (fully explained above)', () => {
    const html = render({
      briefDiscovery: discovery({
        excluded: [
          { package: 'RUN-7', brief: 'docs/briefs/RUN-7-old.md', title: 'old', writtenAt: '2026-08-01T00:00:00.000Z', reason: '超出最近 7 天的窗口', kind: 'old' },
        ],
        excludedTotal: 1,
        byKind: { old: 1 },
      }),
    });
    expect(html).toContain('也显示超出时间窗口的 1 份');
    expect(html).not.toContain('为什么还有');
  });
});

describe('BriefShelf language switch (item 38 follow-up)', () => {
  afterEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it('renders every converted label in English, with no residual CJK outside user/server content', () => {
    setLocale('en');
    const html = render({
      unpostedBriefs: [brief('RUN-1')],
      briefDiscovery: discovery({
        excluded: [
          { brief: 'docs/briefs/notes-1.md', reason: 'bad id', kind: 'badId' as const },
        ],
        excludedTotal: 2,
        byKind: { badId: 1, old: 1, dispatched: 1 },
      }),
      onRescan: () => {},
    });
    expect(html).toContain('Briefs not on the board yet');
    expect(html).toContain('Last 7 days');
    expect(html).toContain('Rescan now');
    expect(html).toContain('Also show 1 outside the time window');
    expect(html).toContain('Also show 1 already dispatched elsewhere');
    // RUN-1's own docs/briefs path is user/server content and is expected in the stripped check below.
    expect(html.replace(/RUN-1|docs\/briefs\/[\w-]+\.md/g, '')).not.toMatch(/[一-鿿]/);
  });

  it('the empty and diagnostics states also render fully in English', () => {
    setLocale('en');
    const html = render({
      unpostedBriefs: [],
      briefDiscovery: discovery({
        excluded: [{ brief: 'docs/briefs/notes-1.md', reason: 'bad id', kind: 'badId' as const }],
        excludedTotal: 5,
        byKind: { badId: 5 },
      }),
    });
    expect(html).toContain('No briefs waiting to be posted');
    expect(html).toContain('Why are 5 files still missing?');
  });
});
