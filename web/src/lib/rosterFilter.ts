import type { Card, CardStatus } from '../api/types';
import { NO_PROVIDER, groupByProvider } from './rosterGroups';

/**
 * Shared roster discovery logic (QB-FB-B): the guild sidebar and the 冒险者（模型）page use one filter
 * model and one fold model, so searching for an adventurer behaves identically in both places.
 * Everything here is pure (storage is passed in); React state and localStorage access live in the
 * components. Fold display = the revealed set (saved folds, or the filter's temporary reveal) minus the
 * session-only closed overrides picked while filtering — saved folds are never touched during a search.
 */

export interface RosterFilterState {
  search: string;
  /** '' = any provider; otherwise a provider as normalized by cardProvider (blank = NO_PROVIDER). */
  provider: string;
  /** '' = any lane. */
  lane: string;
  /** '' = any status. */
  status: '' | CardStatus;
}

export const EMPTY_ROSTER_FILTER: RosterFilterState = { search: '', provider: '', lane: '', status: '' };

/** The status filter order, newest roster vocabulary first; 'broke' stays because the roster can hold it. */
export const ROSTER_STATUSES: readonly CardStatus[] = ['available', 'limited', 'broke', 'paused', 'disabled'];

/** Provider group name a card belongs to: trimmed, blank becomes 未填服务商 (same rule as groupByProvider). */
export function cardProvider(card: Card): string {
  return card.provider.trim() || NO_PROVIDER;
}

/** Does this card match the free-text query? Case-insensitive substring over id, name and model id. */
export function matchesRosterCard(card: Card, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return (
    card.id.toLowerCase().includes(needle) ||
    card.name.toLowerCase().includes(needle) ||
    card.model.toLowerCase().includes(needle)
  );
}

/** One card against the whole filter state. The fields combine: everything set must match (AND). */
function passesRosterFilter(card: Card, filter: RosterFilterState): boolean {
  if (!matchesRosterCard(card, filter.search)) return false;
  if (filter.provider && cardProvider(card) !== filter.provider) return false;
  if (filter.lane && card.lane !== filter.lane) return false;
  if (filter.status && card.status !== filter.status) return false;
  return true;
}

/** The roster narrowed by the filter. Returns a new array and never mutates or reorders the input. */
export function filterRosterCards(cards: readonly Card[], filter: RosterFilterState): Card[] {
  return cards.filter((card) => passesRosterFilter(card, filter));
}

/** Is anything set? Drives result counts, the clearing affordance and the forced group reveal. */
export function rosterFilterActive(filter: RosterFilterState): boolean {
  return (
    filter.search.trim() !== '' ||
    filter.provider !== '' ||
    filter.lane !== '' ||
    filter.status !== ''
  );
}

export interface RosterFilterOptions {
  providers: string[];
  lanes: string[];
  statuses: readonly CardStatus[];
}

/**
 * The option lists for the shared filter bar, built from the FULL roster (a result set must not shrink
 * the choices). Sorted by code point with the default sort, so the order cannot depend on locale.
 */
export function buildRosterFilterOptions(cards: readonly Card[]): RosterFilterOptions {
  const providers = [...new Set(cards.map(cardProvider))].sort();
  const lanes = [...new Set(cards.map((card) => card.lane))].sort();
  return { providers, lanes, statuses: ROSTER_STATUSES };
}

/**
 * Which provider groups should stand open right now.
 * - While any filter is active: every group that contains a match is open (a search must never hide a
 *   result in a folded group), groups without a match stay closed.
 * - With no filter: the remembered folds apply — a group in rememberedFolded is closed, everything else
 *   is open. The remembered list itself is never mutated here, so clearing the search restores the
 *   owner's saved choices untouched.
 */
export function revealGroups(
  cards: readonly Card[],
  rememberedFolded: readonly string[],
  filter: RosterFilterState,
): Set<string> {
  const active = rosterFilterActive(filter);
  const folded = new Set(rememberedFolded);
  const revealed = new Set<string>();
  for (const group of groupByProvider(cards)) {
    const open = active
      ? group.cards.some((card) => passesRosterFilter(card, filter))
      : !folded.has(group.provider);
    if (open) revealed.add(group.provider);
  }
  return revealed;
}

/** Does this provider group stand closed by default given the revealed set? */
export function isFoldedByDefault(revealed: ReadonlySet<string>, provider: string): boolean {
  return !revealed.has(provider);
}

/**
 * Which groups actually stand open on screen: what the filter/remembered state reveals, minus the
 * TEMPORARY folds the owner set during this search. The temporary set is display-only — it never enters
 * the remembered list, and clearing the search (which drops the temp set) restores that list untouched.
 */
export function openRevealedGroups(revealed: ReadonlySet<string>, tempFolded: Iterable<string>): Set<string> {
  const temp = new Set(tempFolded);
  const open = new Set<string>();
  for (const provider of revealed) if (!temp.has(provider)) open.add(provider);
  return open;
}

/**
 * One group-header click. Only an unfiltered click changes what is remembered (`persist: true`). While a
 * filter is active the click just adds or clears this group's temporary fold, so the aria state follows
 * what the owner actually sees and the saved folds cannot be rewritten behind a search.
 */
export function toggleGroupFold(
  provider: string,
  ctx: { filterActive: boolean; rememberedFolded: readonly string[]; tempFolded: Iterable<string> },
): { tempFolded: string[]; rememberedFolded: string[]; persist: boolean } {
  if (ctx.filterActive) {
    const temp = new Set(ctx.tempFolded);
    if (temp.has(provider)) temp.delete(provider);
    else temp.add(provider);
    return { tempFolded: [...temp], rememberedFolded: [...ctx.rememberedFolded], persist: false };
  }
  const remembered = ctx.rememberedFolded.includes(provider)
    ? ctx.rememberedFolded.filter((p) => p !== provider)
    : [...ctx.rememberedFolded, provider];
  return { tempFolded: [], rememberedFolded: remembered, persist: true };
}

export interface FoldedProviderButtonState {
  provider: string;
  expanded: boolean;
}

/** Convert the table's rendered provider-button state into the fold list used by bulk selection. */
export function foldedProvidersFromTable(buttons: readonly FoldedProviderButtonState[]): string[] {
  return [...new Set(buttons.filter((button) => !button.expanded).map((button) => button.provider).filter(Boolean))];
}

/** localStorage-style subset the fold helpers need, so tests can pass a fake. */
export type FoldStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The one storage key for this project's fold set, namespaced by the project's stable opaque id
 * (Snapshot.project.id, digested from its root). The project *name* is deliberately not the key: two
 * same-named projects served on the same port share one browser storage, and a name key would leak one
 * guild's folds into the other. An old server that sends no id gets no persistence rather than a false
 * promise of isolation — callers check foldKeyFor and say so visibly.
 */
export const FOLD_KEY_PREFIX = 'questboard.roster.folded.';

export function foldKeyFor(projectId: string | undefined | null): string | null {
  const id = typeof projectId === 'string' ? projectId.trim() : '';
  return id ? `${FOLD_KEY_PREFIX}${id}` : null;
}

/** Read the remembered folds. No id, no storage, or anything unreadable = no folds (never throws). */
export function loadFoldedProviders(storage: FoldStorage | null, projectId: string | undefined | null): string[] {
  if (!storage) return [];
  const key = foldKeyFor(projectId);
  if (!key) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const kept = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
    return [...new Set(kept)];
  } catch {
    return [];
  }
}

/**
 * Remember the folds. False when the server sent no project id (not namespaced, not saved) or storage
 * refuses (private mode, quota) — folding still works for this visit.
 */
export function saveFoldedProviders(
  storage: FoldStorage | null,
  projectId: string | undefined | null,
  providers: readonly string[],
): boolean {
  if (!storage) return false;
  const key = foldKeyFor(projectId);
  if (!key) return false;
  try {
    storage.setItem(key, JSON.stringify([...providers]));
    return true;
  } catch {
    return false;
  }
}

/** The browser's localStorage, or null when unavailable (SSR, blocked). Never throws. */
export function foldStorage(): FoldStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const PROVIDER_ACCENTS = ['var(--cobalt)', 'var(--pcb)', 'var(--violet)', 'var(--teal)', 'var(--amber)', 'var(--grey)'] as const;

/**
 * A stable accent token per provider, drawn only from the board.css theme variables so it adapts to every
 * theme. The accent is never the whole marker: providerMark spells the name out in text alongside it.
 */
export function providerAccent(provider: string): string {
  let hash = 0;
  for (const ch of provider) hash = (hash * 31 + ch.codePointAt(0)!) % 1_000_003;
  return PROVIDER_ACCENTS[hash % PROVIDER_ACCENTS.length]!;
}

/** A short text marker for a provider group (first code point, uppercased) — readable without color. */
export function providerMark(provider: string): string {
  const trimmed = provider.trim();
  if (!trimmed) return '?';
  const first = trimmed.codePointAt(0)!;
  return String.fromCodePoint(first).toUpperCase();
}
