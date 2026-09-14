import type { Quest, Snapshot } from '../api/types';
import { nextStep, type NextStep } from './nextStep';
import { isArchived } from './questState';

export type TrayKind = 'sign-off' | 'decide' | 'release' | 'owner';

export interface TrayItem {
  quest: Quest;
  step: NextStep;
  kind: TrayKind;
}

export const TRAY_KIND_LABEL: Record<TrayKind, string> = {
  'sign-off': '交差',
  decide: '拍板',
  release: '失联',
  owner: '你来',
};

export const TRAY_STAMP_LABEL: Record<TrayKind, string> = {
  'sign-off': '去验收',
  decide: '去拍板',
  release: '去确认',
  owner: '去处理',
};

const KIND_ORDER: Record<TrayKind, number> = {
  'sign-off': 0,
  decide: 1,
  release: 2,
  owner: 3,
};

function resolveKind(quest: Quest, step: NextStep): TrayKind {
  if (step.action === 'sign-off') {
    return 'sign-off';
  }
  if (Boolean(quest.needsOwner && quest.needsOwner.trim()) || quest.status === 'needs_owner') {
    return 'decide';
  }
  if (step.action === 'release') {
    return 'release';
  }
  return 'owner';
}

export function inTrayItems(snap: Snapshot): TrayItem[] {
  const items: TrayItem[] = [];

  for (const quest of snap.quests) {
    // A returned review is decided on the work it reviews, which is already in the tray as 交差.
    if (isArchived(quest) || quest.kind === 'review') {
      continue;
    }
    const step = nextStep(quest, snap);
    if (step.who !== 'you') {
      continue;
    }
    items.push({
      quest,
      step,
      kind: resolveKind(quest, step),
    });
  }

  items.sort((a, b) => {
    const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (kindDiff !== 0) return kindDiff;

    const priorityDiff = a.quest.priority - b.quest.priority;
    if (priorityDiff !== 0) return priorityDiff;

    return a.quest.createdAt.localeCompare(b.quest.createdAt);
  });

  return items;
}
