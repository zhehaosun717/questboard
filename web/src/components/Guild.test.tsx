import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Card, Snapshot } from '../api/types';
import { Guild } from './Guild';

// Renders the real Guild.tsx (not a stand-in). renderToStaticMarkup can't compute flex layout — a real
// browser check for that lives in the QB-FB-ROSTER-FONTS-VISUAL evidence folder — but it does catch a
// markup regression on the provider-name truncation fix: the name must keep a title attribute carrying the
// full provider id (the tooltip a CSS ellipsis needs), and must never be dropped from the DOM.

function card(id: string, provider: string): Card {
  return {
    id,
    name: id,
    provider,
    lane: 'oc',
    model: 'm',
    family: 'f',
    status: 'available',
    statusSince: null,
    statusReason: '',
    statusSetBy: null,
  };
}

function snapshot(roster: Card[]): Snapshot {
  return {
    generatedAt: new Date().toISOString(),
    project: { name: 'P', id: 'proj-1', lanes: [] },
    quests: [],
    roster,
    eligibility: {},
    env: { treeLocked: false },
    live: {},
    threads: {},
    reviewPages: [],
    unpostedBriefs: [],
    verification: null,
    laneLimits: {},
    openQuestions: 0,
  };
}

function render(roster: Card[]) {
  return renderToStaticMarkup(
    <Guild
      roster={roster}
      snap={snapshot(roster)}
      draggingCardId={null}
      onEditCard={() => {}}
      onHoverCard={() => {}}
      onDragStart={() => {}}
      onDragEnd={() => {}}
    />,
  );
}

describe('Guild provider heading (real JSX)', () => {
  it('gives a long provider id a title tooltip on the name span instead of hiding it', () => {
    const html = render([card('a1', 'a-very-long-provider-identifier')]);
    expect(html).toContain('class="guild-group-name" title="a-very-long-provider-identifier"');
    expect(html).toContain('a-very-long-provider-identifier</span>');
  });

  it('keeps icon, name, count and toggle together for a short provider id', () => {
    const html = render([card('a1', 'openai'), card('a2', 'openai')]);
    expect(html).toContain('provider-mark');
    expect(html).toContain('guild-group-name');
    expect(html).toContain('guild-group-count');
    expect(html).toContain('aria-expanded=');
    expect(html).toContain('共 2 位');
  });
});

describe('Guild truth badges and unproven import fold (FB2-07 item 5)', () => {
  it('an unverified card carries a 未验证 badge', () => {
    const html = render([{ ...card('u1', 'opencode'), verified: 'unverified' as const }]);
    expect(html).toContain('card-verified-badge');
    expect(html).toContain('未验证');
  });

  it('a verified-ok card carries no badge', () => {
    const html = render([{ ...card('ok1', 'opencode'), verified: 'ok' as const }]);
    expect(html).not.toContain('card-verified-badge');
  });

  it('batch-imported cards that never delivered fold behind 未验证的导入卡 by default', () => {
    const proven = { ...card('p1', 'opencode'), importedFrom: 'opencode', neverDelivered: false };
    const unproven = { ...card('u2', 'opencode'), importedFrom: 'opencode', neverDelivered: true };
    const manual = card('m1', 'opencode');
    const html = render([proven, unproven, manual]);
    expect(html).toContain('guild-unproven-toggle');
    expect(html).toContain('aria-expanded="false"');
    // the proven and manual cards render as badges; the unproven one is behind the fold
    const badgeIds = Array.from(html.matchAll(/data-adv="([^"]+)"/g)).map((m) => m[1]);
    expect(badgeIds).toContain('p1');
    expect(badgeIds).toContain('m1');
    expect(badgeIds).not.toContain('u2');
  });

  it('a provider group with no unproven imports has no fold toggle', () => {
    const html = render([card('m1', 'openai')]);
    expect(html).not.toContain('guild-unproven-toggle');
  });
});
