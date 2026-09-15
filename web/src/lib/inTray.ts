import type { Quest, Snapshot } from '../api/types';
import { nextStep, type NextStep } from './nextStep';
import { isArchived } from './questState';

// The owner's in-tray: only what the OWNER must do. Returned code and tool work waits on the coordinator's
// technical review and stays out (nextStep says who); a review quest's verdict is decided on the work it
// reviews and never enters twice. One exception outranks the kind: an explicit question on the quest itself.
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
    // A review's verdict is judged on the work it reviews and never asks for acceptance on its own.
    // The one thing that can pull a review into the tray is an explicit question on it.
    const asked = Boolean(quest.needsOwner && quest.needsOwner.trim()) || quest.status === 'needs_owner';
    if (isArchived(quest) || (quest.kind === 'review' && !asked)) {
      continue;
    }
    // Only steps whose next move is the owner's (who === 'you') enter the tray. Technical sign-off waits
    // on the coordinator instead: it is deliberately not the owner's inbox.
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
