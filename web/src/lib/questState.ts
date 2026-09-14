import type { Quest, Snapshot, Verdict, Ruling } from '../api/types';
import { COLUMNS, OPEN_STATUSES } from './labels';

export type QuestFlowKey = 'open' | 'run' | 'owner' | 'other';

const RUN_STATUSES = COLUMNS.find((column) => column.key === 'run')?.statuses ?? [];
const OWNER_STATUSES = [
  ...(COLUMNS.find((column) => column.key === 'check')?.statuses ?? []),
  ...(COLUMNS.find((column) => column.key === 'owner')?.statuses ?? []),
];

export const QUEST_FLOW_LABEL: Record<QuestFlowKey, string> = {
  open: '可以派遣',
  run: '正在执行',
  owner: '等我处理',
  other: '',
};

export function getQuestFlowKey(quest: Quest): QuestFlowKey {
  if (quest.needsOwner.trim().length > 0 || OWNER_STATUSES.includes(quest.status)) {
    return 'owner';
  }
  if (RUN_STATUSES.includes(quest.status)) {
    return quest.assignee ? 'run' : 'other';
  }
  if (OPEN_STATUSES.includes(quest.status)) return 'open';
  return 'other';
}

export function getQuestVerdict(
  snap: Snapshot,
  questId: string,
  cardId: string,
): Verdict | undefined {
  return snap.eligibility[questId]?.[cardId];
}

export function hasEligibleCard(snap: Snapshot, questId: string): boolean {
  const verdicts = snap.eligibility[questId];
  return verdicts ? Object.values(verdicts).some((verdict) => verdict.ok) : false;
}

export function getLatestRuling(quest: Quest): Ruling | undefined {
  const lastIndex = quest.rulings.length - 1;
  return lastIndex >= 0 ? quest.rulings[lastIndex] : undefined;
}
