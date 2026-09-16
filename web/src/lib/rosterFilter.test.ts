import { describe, expect, test } from 'vitest';
import type { Card, CardStatus } from '../api/types';
import { NO_PROVIDER } from './rosterGroups';
import {
  EMPTY_ROSTER_FILTER,
  ROSTER_STATUSES,
  buildRosterFilterOptions,
  filterRosterCards,
  foldedProvidersFromTable,
  foldKeyFor,
  isFoldedByDefault,
  loadFoldedProviders,
  matchesRosterCard,
  openRevealedGroups,
  revealGroups,
  rosterFilterActive,
  saveFoldedProviders,
  toggleGroupFold,
  type RosterFilterState,
} from './rosterFilter';

function card(id: string, over: Partial<Card> = {}): Card {
  return {
    id,
    name: `名字-${id}`,
    provider: 'volcano',
    lane: 'ark',
    model: `model-${id}`,
    family: 'qwen',
    status: 'available' as CardStatus,
    statusSince: null,
    statusReason: '',
    statusSetBy: null,
    ...over,
  };
}

const ROSTER: readonly [Card, Card, Card, Card] = [
  card('a', { model: 'Kimi-K2-0915', lane: 'kimi', status: 'limited' }),
  card('b', { model: 'glm-4.6', provider: 'zhipu', lane: 'zcode' }),
  card('C', { model: 'DeepSeek-V3.2', provider: '', lane: 'ark', status: 'paused' }),
  card('d', { model: 'qwen3.8-flash', provider: 'volc', lane: 'deep', status: 'disabled' }),
];

describe('matchesRosterCard', () => {
  test('empty search matches everything', () => {
    expect(matchesRosterCard(ROSTER[0]!, '')).toBe(true);
    expect(matchesRosterCard(ROSTER[0]!, '   ')).toBe(true);
  });

  test('matches on card id, name and model id, case-insensitively', () => {
    expect(matchesRosterCard(ROSTER[0]!, 'A')).toBe(true); // id (upper card 'a' vs search 'A')
    expect(matchesRosterCard(ROSTER[2]!, 'c'.toUpperCase())).toBe(true); // id 'C' vs 'C'
    expect(matchesRosterCard(ROSTER[2]!, 'c')).toBe(true); // id 'C' is case-insensitive
    expect(matchesRosterCard(ROSTER[0]!, '名字-a')).toBe(true); // display name
    expect(matchesRosterCard(ROSTER[0]!, 'kimi-k2')).toBe(true); // model, mixed case both sides
    expect(matchesRosterCard(ROSTER[0]!, 'K2-0915')).toBe(true); // model substring
    expect(matchesRosterCard(ROSTER[1]!, 'GLM-4')).toBe(true);
  });

  test('does not match unrelated text', () => {
    expect(matchesRosterCard(ROSTER[0]!, 'qwen')).toBe(false);
    expect(matchesRosterCard(ROSTER[3]!, 'deepseek')).toBe(false);
  });

  test('whitespace around the query is ignored; lanes are not searched', () => {
    expect(matchesRosterCard(ROSTER[0]!, '  名字-a  ')).toBe(true); // display-name substring after trim
    expect(matchesRosterCard(ROSTER[3]!, '  qwen3.8  ')).toBe(true); // model substring after trim
    expect(matchesRosterCard(ROSTER[3]!, '  deep  ')).toBe(false); // 'deep' is only d's lane
  });
});

describe('filterRosterCards', () => {
  test('empty filter returns every card in a new array', () => {
    const out = filterRosterCards(ROSTER, EMPTY_ROSTER_FILTER);
    expect(out).toHaveLength(4);
    expect(out).not.toBe(ROSTER);
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'C', 'd']);
  });

  test('never mutates the input array', () => {
    const before = [...ROSTER];
    filterRosterCards(ROSTER, { ...EMPTY_ROSTER_FILTER, provider: 'volcano' });
    expect(ROSTER).toEqual(before);
  });

  test('provider filter compares the trimmed provider, blank counts as 未填服务商', () => {
    const out = filterRosterCards(ROSTER, { ...EMPTY_ROSTER_FILTER, provider: 'volcano' });
    expect(out.map((c) => c.id)).toEqual(['a']); // only a is volcano (b is zhipu)
    const none = filterRosterCards(ROSTER, { ...EMPTY_ROSTER_FILTER, provider: NO_PROVIDER });
    expect(none.map((c) => c.id)).toEqual(['C']);
  });

  test('lane and status filters are exact', () => {
    expect(filterRosterCards(ROSTER, { ...EMPTY_ROSTER_FILTER, lane: 'ark' }).map((c) => c.id)).toEqual(['C']);
    expect(filterRosterCards(ROSTER, { ...EMPTY_ROSTER_FILTER, status: 'available' }).map((c) => c.id)).toEqual(['b']);
    expect(filterRosterCards(ROSTER, { ...EMPTY_ROSTER_FILTER, status: 'disabled' }).map((c) => c.id)).toEqual(['d']);
  });

  test('all filters combine (AND)', () => {
    const f: RosterFilterState = { search: 'k2', provider: 'volcano', lane: 'kimi', status: 'limited' };
    expect(filterRosterCards(ROSTER, f).map((c) => c.id)).toEqual(['a']);
    const dead: RosterFilterState = { ...f, lane: 'ark' };
    expect(filterRosterCards(ROSTER, dead)).toEqual([]);
  });

  test('search alone finds across fields on any card', () => {
    expect(filterRosterCards(ROSTER, { ...EMPTY_ROSTER_FILTER, search: 'v3.2' }).map((c) => c.id)).toEqual(['C']);
    expect(filterRosterCards(ROSTER, { ...EMPTY_ROSTER_FILTER, search: 'glm' }).map((c) => c.id)).toEqual(['b']);
  });

  test('no matches gives an empty list, not an error', () => {
    expect(filterRosterCards(ROSTER, { ...EMPTY_ROSTER_FILTER, search: 'zzz-nothing' })).toEqual([]);
  });

  test('empty roster stays empty', () => {
    expect(filterRosterCards([], { ...EMPTY_ROSTER_FILTER, search: 'q' })).toEqual([]);
  });
});

describe('rosterFilterActive', () => {
  test('false for the empty state, true when any field is set', () => {
    expect(rosterFilterActive(EMPTY_ROSTER_FILTER)).toBe(false);
    expect(rosterFilterActive({ ...EMPTY_ROSTER_FILTER, search: '  ' })).toBe(false);
    expect(rosterFilterActive({ ...EMPTY_ROSTER_FILTER, search: 'q' })).toBe(true);
    expect(rosterFilterActive({ ...EMPTY_ROSTER_FILTER, provider: 'volcano' })).toBe(true);
    expect(rosterFilterActive({ ...EMPTY_ROSTER_FILTER, lane: 'ark' })).toBe(true);
    expect(rosterFilterActive({ ...EMPTY_ROSTER_FILTER, status: 'broke' })).toBe(true);
  });
});

describe('buildRosterFilterOptions', () => {
  test('collects sorted unique providers (normalized), lanes and the fixed status list', () => {
    const options = buildRosterFilterOptions(ROSTER);
    expect(options.providers).toEqual([NO_PROVIDER, 'volcano', 'volc', 'zhipu'].sort());
    expect(options.lanes).toEqual(['ark', 'deep', 'kimi', 'zcode']);
    expect(options.statuses).toEqual(ROSTER_STATUSES);
  });

  test('handles an empty roster', () => {
    const options = buildRosterFilterOptions([]);
    expect(options.providers).toEqual([]);
    expect(options.lanes).toEqual([]);
  });
});

describe('revealGroups', () => {
  test('no search keeps the saved fold set', () => {
    expect(revealGroups(ROSTER, ['a'], EMPTY_ROSTER_FILTER)).toEqual(
      new Set(['volcano', 'zhipu', NO_PROVIDER, 'volc']),
    );
  });

  test('an active search reveals only matching groups and leaves saved folds untouched', () => {
    const saved = ['volcano'];
    const revealed = revealGroups(ROSTER, saved, { ...EMPTY_ROSTER_FILTER, search: 'deep' });
    expect(revealed.has(NO_PROVIDER)).toBe(true); // card C matches via id, its group opens
    expect(revealed.has('volcano')).toBe(false); // a (k2) and b (deep lane? no—lane not searched) stay folded
    expect(saved).toEqual(['volcano']); // the caller's saved list was not mutated
  });

  test('provider/status filters also count as activity for the reveal', () => {
    const revealed = revealGroups(ROSTER, [], { ...EMPTY_ROSTER_FILTER, provider: 'zhipu' });
    expect(revealed).toEqual(new Set(['zhipu']));
  });

  test('isFoldedByDefault answers with the opposite of reveal', () => {
    const revealed = revealGroups(ROSTER, ['volcano'], EMPTY_ROSTER_FILTER);
    expect(isFoldedByDefault(revealed, 'volcano')).toBe(true); // remembered folded
    expect(isFoldedByDefault(revealed, 'zhipu')).toBe(false); // was never folded
  });
});

describe('temporary fold while filtering (QB-FB-BG)', () => {
  const deep = { ...EMPTY_ROSTER_FILTER, search: 'deep' };

  test('a click during the search only moves the temporary set and asks for no save', () => {
    const saved = ['volcano'];
    const revealed = revealGroups(ROSTER, saved, deep);
    expect(revealed.has(NO_PROVIDER)).toBe(true); // 'C' matches the search, so its group shows open
    const r = toggleGroupFold(NO_PROVIDER, { filterActive: true, rememberedFolded: saved, tempFolded: [] });
    expect(r.tempFolded).toEqual([NO_PROVIDER]);
    expect(r.rememberedFolded).toEqual(['volcano']); // the saved list survives the click untouched
    expect(r.persist).toBe(false); // nothing may be written to storage
    expect(openRevealedGroups(revealed, r.tempFolded).has(NO_PROVIDER)).toBe(false); // display: closed, and aria says so
    const again = toggleGroupFold(NO_PROVIDER, { filterActive: true, rememberedFolded: r.rememberedFolded, tempFolded: r.tempFolded });
    expect(again.tempFolded).toEqual([]); // clicking again re-opens; saved list still untouched
    expect(again.persist).toBe(false);
  });

  test('clearing the search shows the saved folds again — the click during it changed nothing', () => {
    const saved = ['volcano'];
    const during = toggleGroupFold(NO_PROVIDER, { filterActive: true, rememberedFolded: saved, tempFolded: [] });
    const cleared = revealGroups(ROSTER, during.rememberedFolded, EMPTY_ROSTER_FILTER);
    expect(cleared.has(NO_PROVIDER)).toBe(true); // never saved-folded, so it stands open
    expect(cleared.has('volcano')).toBe(false); // the old saved fold is exactly where it was
  });

  test('outside a search the toggle edits the saved list and asks to persist', () => {
    const r = toggleGroupFold('volcano', { filterActive: false, rememberedFolded: [], tempFolded: [NO_PROVIDER] });
    expect(r.rememberedFolded).toEqual(['volcano']);
    expect(r.tempFolded).toEqual([]); // a real fold clears any stale temporary ones
    expect(r.persist).toBe(true);
    const open = toggleGroupFold('volcano', { filterActive: false, rememberedFolded: r.rememberedFolded, tempFolded: [] });
    expect(open.rememberedFolded).toEqual([]);
    expect(open.persist).toBe(true);
  });

  test('openRevealedGroups subtracts exactly the temporary set', () => {
    const revealed = new Set(['a', 'b', 'c']);
    expect([...openRevealedGroups(revealed, ['b'])]).toEqual(['a', 'c']);
    expect([...openRevealedGroups(revealed, [])]).toEqual(['a', 'b', 'c']);
  });
});

describe('live table fold state', () => {
  test('turns rendered aria-expanded states into the exact folded provider list', () => {
    expect(foldedProvidersFromTable([
      { provider: 'alpha', expanded: true },
      { provider: 'beta', expanded: false },
      { provider: 'gamma', expanded: false },
      { provider: 'beta', expanded: false },
      { provider: '', expanded: false },
    ])).toEqual(['beta', 'gamma']);
  });
});

describe('folded-provider persistence', () => {
  function fakeStore(initial: Record<string, string> = {}, failOn?: 'get' | 'set') {
    const map = new Map(Object.entries(initial));
    return {
      getItem(key: string) {
        if (failOn === 'get') throw new Error('denied');
        return map.has(key) ? (map.get(key) as string) : null;
      },
      setItem(key: string, value: string) {
        if (failOn === 'set') throw new Error('quota');
        map.set(key, value);
      },
      map,
    };
  }

  test('key is the project id, not the name: two same-named projects get different keys', () => {
    // The id is the opaque digest the server sends (Snapshot.project.id). Same *name*, different roots =
    // different ids = different keys; nothing a same-named project saved can be read under another's id.
    expect(foldKeyFor('fixture-a')).toBe('questboard.roster.folded.fixture-a');
    expect(foldKeyFor('fixture-a')).not.toBe(foldKeyFor('other'));
    const a = fakeStore();
    saveFoldedProviders(a, 'id-project-one', ['volcano']);
    expect(loadFoldedProviders(a, 'id-project-two')).toEqual([]); // isolation, not name reuse
  });

  test('an old server without an id gets no persistence, never a name fallback', () => {
    expect(foldKeyFor('')).toBeNull();
    expect(foldKeyFor(undefined)).toBeNull();
    expect(saveFoldedProviders(fakeStore(), undefined, ['volcano'])).toBe(false);
    expect(loadFoldedProviders(fakeStore({ 'questboard.roster.folded.fixture-a': '["x"]' }), undefined)).toEqual([]);
  });

  test('round-trips a provider list through storage', () => {
    const store = fakeStore();
    expect(saveFoldedProviders(store, 'proj', ['volcano', NO_PROVIDER])).toBe(true);
    expect(loadFoldedProviders(store, 'proj')).toEqual(['volcano', NO_PROVIDER]);
  });

  test('missing, corrupt or non-string entries degrade to an empty list', () => {
    expect(loadFoldedProviders(fakeStore(), 'proj')).toEqual([]);
    expect(loadFoldedProviders(fakeStore({ 'questboard.roster.folded.proj': '{oops' }), 'proj')).toEqual([]);
    expect(loadFoldedProviders(fakeStore({ 'questboard.roster.folded.proj': '{"a":1}' }), 'proj')).toEqual([]);
    expect(loadFoldedProviders(fakeStore({ 'questboard.roster.folded.proj': '[1,"ok",null]' }), 'proj')).toEqual(['ok']);
    expect(loadFoldedProviders(fakeStore({ 'questboard.roster.folded.proj': '["a","a"]' }), 'proj')).toEqual(['a']);
  });

  test('a throwing storage (private mode) never breaks loading or saving', () => {
    expect(loadFoldedProviders(fakeStore({}, 'get'), 'proj')).toEqual([]);
    const store = fakeStore({}, 'set');
    expect(saveFoldedProviders(store, 'proj', ['volcano'])).toBe(false);
    expect(loadFoldedProviders(store, 'proj')).toEqual([]);
  });

  test('null storage (missing localStorage) is safe', () => {
    expect(loadFoldedProviders(null, 'proj')).toEqual([]);
    expect(saveFoldedProviders(null, 'proj', ['volcano'])).toBe(false);
  });

  test('folds survive a remount: a fresh load returns what was saved', () => {
    const store = fakeStore();
    saveFoldedProviders(store, 'proj', ['zhipu']);
    // simulate remount reading the same storage again
    expect(loadFoldedProviders(store, 'proj')).toEqual(['zhipu']);
  });
});
