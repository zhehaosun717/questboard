// Test-only builders for the board's data shapes. Every field is a real field of the API types, so a test
// that sets a field the types do not have fails the type check instead of passing on made-up data.
import type { Assignee, Card, Quest, Snapshot } from '../api/types';

const AT = '2026-09-13T00:00:00.000Z';

export function makeQuest(partial: Partial<Quest> & { id: string }): Quest {
  return {
    kind: 'code',
    status: 'posted',
    title: '测试委托',
    brief: 'docs/briefs/x.md',
    priority: 2,
    parents: [],
    conflicts: [],
    allowedLanes: [],
    needsOwner: '',
    reviewPage: '',
    assignee: null,
    dispatches: [],
    rulings: [],
    files: [],
    createdAt: AT,
    updatedAt: AT,
    ...partial,
  };
}

export function makeCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    name: '测试冒险者',
    provider: '测试提供方',
    lane: '测试接入方式',
    model: '测试模型',
    family: '测试系列',
    status: 'available',
    statusSince: null,
    statusReason: '',
    statusSetBy: null,
    ...overrides,
  };
}

export function makeAssignee(adventurerId: string, overrides: Partial<Assignee> = {}): Assignee {
  return {
    adventurerId,
    family: null,
    lane: '测试接入方式',
    model: `${adventurerId}-model`,
    variant: '',
    name: `${adventurerId}-worker`,
    at: AT,
    by: 'owner',
    ...overrides,
  };
}

export function makeSnapshot(parts: Partial<Snapshot> = {}): Snapshot {
  return {
    generatedAt: AT,
    project: { name: '测试项目', lanes: ['测试接入方式'] },
    quests: [],
    roster: [makeCard('card-1')],
    eligibility: {},
    reviewEligibility: {},
    env: { treeLocked: false },
    live: {},
    threads: {},
    reviewPages: [],
    unpostedBriefs: [],
    verification: null,
    laneLimits: {},
    openQuestions: 0,
    ...parts,
  };
}
