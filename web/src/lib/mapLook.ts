import type { Quest, QuestStatus } from '../api/types';
import { STATUS } from './labels';

/**
 * Direction B adventure map pin colours by quest status.
 *
 * - ready/open green: #4f8a4b
 * - on quest blue: #3f6f9e
 * - waiting on the owner wax red: #a8322a
 * - failed/stalled dark red: #7a221b
 * - done/cancelled grey: #9a8b72
 */
export const MAP_PIN_COLORS: Record<QuestStatus, string> = {
  posted: '#4f8a4b',
  bounced: '#4f8a4b',
  lane_limited: '#4f8a4b',
  dispatched: '#3f6f9e',
  delivered: '#a8322a',
  reviewing: '#a8322a',
  needs_owner: '#a8322a',
  owner_playtest: '#a8322a',
  failed: '#7a221b',
  stalled: '#7a221b',
  done: '#9a8b72',
  superseded: '#9a8b72',
  cancelled: '#9a8b72',
};

export const DEFAULT_PIN_COLOR = '#9a8b72';

export function pinColor(status: QuestStatus | undefined | null): string {
  if (!status) return DEFAULT_PIN_COLOR;
  return MAP_PIN_COLORS[status] ?? DEFAULT_PIN_COLOR;
}

/**
 * The place label's status line. `adventurerName` is the roster name of whoever is working; the assignee's own
 * `name` is the dispatch run name (e.g. `run4`), which means nothing on a map, so the model stands in instead.
 */
export function questStatusLine(quest: Quest, adventurerName?: string): string {
  if (quest.status === 'dispatched' && quest.assignee) {
    return `${adventurerName || quest.assignee.model} 在做`;
  }
  return STATUS[quest.status] || quest.status;
}
