import { describe, expect, it } from 'vitest';
import type { Card, CardStatus } from '../api/types';
import { groupByProvider, NO_PROVIDER } from './rosterGroups';

function card(id: string, provider: string, lane: string, status: CardStatus = 'available'): Card {
  return {
    id,
    name: id,
    provider,
    lane,
    model: `${id}-model`,
    family: id,
    status,
    statusSince: null,
    statusReason: '',
    statusSetBy: null,
  };
}

describe('groupByProvider', () => {
  it('keeps the roster order for groups and for the cards inside each group', () => {
    const groups = groupByProvider([
      card('luna', 'OpenAI Codex', 'codex'),
      card('kimi', 'Kimi', 'opencode'),
      card('astra', 'OpenAI Codex', 'codex'),
    ]);
    expect(groups.map((g) => g.provider)).toEqual(['OpenAI Codex', 'Kimi']);
    expect(groups[0]?.cards.map((c) => c.id)).toEqual(['luna', 'astra']);
  });

  it('lists each lane once and counts only available cards', () => {
    const [group] = groupByProvider([
      card('a', 'DeepSeek', 'opencode'),
      card('b', 'DeepSeek', 'dsh', 'paused'),
      card('c', 'DeepSeek', 'opencode', 'limited'),
    ]);
    expect(group?.lanes).toEqual(['opencode', 'dsh']);
    expect(group?.available).toBe(1);
  });

  it('puts cards without a provider in one named group instead of an empty heading', () => {
    const groups = groupByProvider([card('x', '  ', 'codex'), card('y', '', 'codex')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.provider).toBe(NO_PROVIDER);
  });

  it('returns no groups for an empty roster', () => {
    expect(groupByProvider([])).toEqual([]);
  });
});
