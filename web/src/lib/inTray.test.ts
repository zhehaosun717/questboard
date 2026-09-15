import { describe, expect, it } from 'vitest';
import { inTrayItems, TRAY_KIND_LABEL, TRAY_STAMP_LABEL } from './inTray';
import { makeAssignee, makeQuest, makeSnapshot } from './testFixtures';

const round = makeAssignee('card-1', { at: '2026-09-13T01:00:00.000Z' });

describe('inTrayItems', () => {
  it('returns empty array when snapshot has no quests', () => {
    expect(inTrayItems(makeSnapshot({ quests: [] }))).toEqual([]);
  });

  it('excludes archived quests', () => {
    const doneQuest = makeQuest({ id: 'done', status: 'done', lastDetail: 'owner 验收通过' });
    const supersededQuest = makeQuest({ id: 'superseded', status: 'superseded' });
    const cancelledQuest = makeQuest({ id: 'cancelled', status: 'cancelled' });
    const snap = makeSnapshot({ quests: [doneQuest, supersededQuest, cancelledQuest] });

    const items = inTrayItems(snap);
    expect(items).toEqual([]);
  });

  it('excludes quests waiting on an adventurer or reviewer', () => {
    const dispatchedQuest = makeQuest({
      id: 'working',
      status: 'dispatched',
      assignee: makeAssignee('card-1'),
    });
    const workQuest = makeQuest({
      id: 'work',
      kind: 'art',
      status: 'reviewing',
      dispatches: [round],
    });
    const reviewQuest = makeQuest({
      id: 'REVIEW-work',
      kind: 'review',
      parents: ['work'],
      status: 'dispatched',
      assignee: makeAssignee('card-2'),
      createdAt: '2026-09-13T02:00:00.000Z',
    });
    const unassignableQuest = makeQuest({ id: 'unassignable', status: 'posted' });

    const snap = makeSnapshot({
      quests: [dispatchedQuest, workQuest, reviewQuest, unassignableQuest],
    });

    const items = inTrayItems(snap);
    expect(items.map((i) => i.quest.id)).not.toContain('working');
    expect(items.map((i) => i.quest.id)).not.toContain('work');
    expect(items.map((i) => i.quest.id)).not.toContain('unassignable');
  });

  it('keeps returned code and tool work out of the owner tray: the coordinator verifies it', () => {
    const code = makeQuest({ id: 'code', kind: 'code', status: 'delivered', dispatches: [round] });
    const tool = makeQuest({ id: 'tool', kind: 'tool', status: 'reviewing', dispatches: [round] });
    const review = makeQuest({
      id: 'REVIEW-code', kind: 'review', parents: ['code'], status: 'delivered',
      lastDetail: 'VERDICT: PASS', createdAt: '2026-09-13T02:00:00.000Z',
    });
    const items = inTrayItems(makeSnapshot({ quests: [code, tool, review] }));
    expect(items.map((i) => i.quest.id)).toEqual([]);
  });

  it('lists returned art once: the work to sign off, not also its returned review', () => {
    const work = makeQuest({ id: 'work', kind: 'art', status: 'reviewing', dispatches: [round] });
    const review = makeQuest({
      id: 'REVIEW-work', kind: 'review', parents: ['work'], status: 'delivered',
      lastDetail: 'VERDICT: PASS', createdAt: '2026-09-13T02:00:00.000Z',
    });
    const items = inTrayItems(makeSnapshot({ quests: [work, review] }));
    expect(items.map((i) => [i.quest.id, i.kind])).toEqual([['work', 'sign-off']]);
  });

  it('counts a returned technical review once: its verdict sits on the parent, nothing enters the tray twice', () => {
    const code = makeQuest({ id: 'code', status: 'reviewing', dispatches: [round] });
    const review = makeQuest({
      id: 'REVIEW-code', kind: 'review', parents: ['code'], status: 'delivered',
      lastDetail: 'VERDICT: PASS WITH FINDINGS', createdAt: '2026-09-13T02:00:00.000Z',
    });
    const items = inTrayItems(makeSnapshot({ quests: [code, review] }));
    expect(items).toEqual([]);
  });

  it('lets an explicit question on a review reach the owner despite the review kind', () => {
    const code = makeQuest({ id: 'code', status: 'delivered', dispatches: [round] });
    const review = makeQuest({
      id: 'REVIEW-code', kind: 'review', parents: ['code'], status: 'delivered',
      lastDetail: 'VERDICT: PASS', needsOwner: '这个改动要不要上生产？', createdAt: '2026-09-13T02:00:00.000Z',
    });
    const items = inTrayItems(makeSnapshot({ quests: [code, review] }));
    expect(items.map((i) => [i.quest.id, i.kind])).toEqual([['REVIEW-code', 'decide']]);
  });

  it('detects each kind correctly', () => {
    const signOffQuest = makeQuest({
      id: 'q-signoff',
      kind: 'art',
      status: 'delivered',
      dispatches: [round],
    });
    const decideQuest1 = makeQuest({
      id: 'q-decide1',
      needsOwner: '选方案 A 还是 B？',
    });
    const decideQuest2 = makeQuest({
      id: 'q-decide2',
      status: 'needs_owner',
    });
    const releaseQuest = makeQuest({
      id: 'q-release',
      status: 'stalled',
      assignee: makeAssignee('card-1'),
    });
    const ownerQuest = makeQuest({
      id: 'q-owner',
      kind: 'owner',
    });
    const playtestQuest = makeQuest({
      id: 'q-playtest',
      kind: 'art',
      status: 'owner_playtest',
    });

    const snap = makeSnapshot({
      quests: [signOffQuest, decideQuest1, decideQuest2, releaseQuest, ownerQuest, playtestQuest],
    });

    const items = inTrayItems(snap);
    const itemMap = new Map(items.map((item) => [item.quest.id, item]));

    expect(itemMap.get('q-signoff')?.kind).toBe('sign-off');
    expect(itemMap.get('q-decide1')?.kind).toBe('decide');
    expect(itemMap.get('q-decide2')?.kind).toBe('decide');
    expect(itemMap.get('q-release')?.kind).toBe('release');
    expect(itemMap.get('q-owner')?.kind).toBe('owner');
    expect(itemMap.get('q-playtest')?.kind).toBe('owner');
  });

  it('maintains the specified ordering: kind order, priority, then oldest createdAt', () => {
    const qOwner = makeQuest({
      id: 'owner-p2',
      kind: 'owner',
      priority: 2,
      createdAt: '2026-09-13T01:00:00.000Z',
    });
    const qRelease = makeQuest({
      id: 'release-p2',
      status: 'stalled',
      assignee: makeAssignee('card-1'),
      priority: 2,
      createdAt: '2026-09-13T01:00:00.000Z',
    });
    const qDecide = makeQuest({
      id: 'decide-p2',
      needsOwner: '确认',
      priority: 2,
      createdAt: '2026-09-13T01:00:00.000Z',
    });
    const qSignOff = makeQuest({
      id: 'signoff-p2',
      kind: 'art',
      status: 'delivered',
      dispatches: [round],
      priority: 2,
      createdAt: '2026-09-13T01:00:00.000Z',
    });

    // Provided in reverse kind order
    const snapKinds = makeSnapshot({
      quests: [qOwner, qRelease, qDecide, qSignOff],
    });
    const itemsKinds = inTrayItems(snapKinds);
    expect(itemsKinds.map((i) => i.kind)).toEqual(['sign-off', 'decide', 'release', 'owner']);

    // Priority ordering within same kind (priority 1 is highest)
    const qSignOffP1 = makeQuest({
      id: 'signoff-p1',
      kind: 'art',
      status: 'delivered',
      dispatches: [round],
      priority: 1,
      createdAt: '2026-09-13T01:00:00.000Z',
    });
    const qSignOffP2 = makeQuest({
      id: 'signoff-p2-b',
      kind: 'art',
      status: 'delivered',
      dispatches: [round],
      priority: 2,
      createdAt: '2026-09-13T01:00:00.000Z',
    });
    const qSignOffP3 = makeQuest({
      id: 'signoff-p3',
      kind: 'art',
      status: 'delivered',
      dispatches: [round],
      priority: 3,
      createdAt: '2026-09-13T01:00:00.000Z',
    });
    const snapPriorities = makeSnapshot({
      quests: [qSignOffP3, qSignOffP2, qSignOffP1],
    });
    const itemsPriorities = inTrayItems(snapPriorities);
    expect(itemsPriorities.map((i) => i.quest.id)).toEqual(['signoff-p1', 'signoff-p2-b', 'signoff-p3']);

    // Oldest createdAt ordering within same kind and priority
    const qOlder = makeQuest({
      id: 'older',
      kind: 'owner',
      priority: 2,
      createdAt: '2026-09-13T01:00:00.000Z',
    });
    const qMiddle = makeQuest({
      id: 'middle',
      kind: 'owner',
      priority: 2,
      createdAt: '2026-09-13T02:00:00.000Z',
    });
    const qNewer = makeQuest({
      id: 'newer',
      kind: 'owner',
      priority: 2,
      createdAt: '2026-09-13T03:00:00.000Z',
    });
    const snapDates = makeSnapshot({
      quests: [qNewer, qOlder, qMiddle],
    });
    const itemsDates = inTrayItems(snapDates);
    expect(itemsDates.map((i) => i.quest.id)).toEqual(['older', 'middle', 'newer']);
  });

  it('exports kind labels and stamp labels', () => {
    expect(TRAY_KIND_LABEL['sign-off']).toBe('交差');
    expect(TRAY_KIND_LABEL.decide).toBe('拍板');
    expect(TRAY_KIND_LABEL.release).toBe('失联');
    expect(TRAY_KIND_LABEL.owner).toBe('你来');

    expect(TRAY_STAMP_LABEL['sign-off']).toBe('去验收');
    expect(TRAY_STAMP_LABEL.decide).toBe('去拍板');
    expect(TRAY_STAMP_LABEL.release).toBe('去确认');
    expect(TRAY_STAMP_LABEL.owner).toBe('去处理');
  });
});
