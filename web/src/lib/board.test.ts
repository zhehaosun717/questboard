import { describe, expect, it } from 'vitest';
import type { Card, Quest, Snapshot, Verdict } from '../api/types';
import {
  busyQuests,
  cardLabel,
  filterQuests,
  groupRefusals,
  hasOwnerQuestion,
  isQueueOnly,
  isSafeReviewUrl,
  paginate,
  projectScopedKey,
  questsInColumn,
  relatedQuestIds,
  reviewSourcePath,
} from './board';
import { COLUMNS, type Column } from './labels';
import { inTrayItems } from './inTray';
import { nextStep } from './nextStep';

function makeQuest(partial: Partial<Quest> & { id: string }): Quest {
  return {
    kind: 'code',
    status: 'posted',
    title: 'Test quest',
    brief: 'brief',
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
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...partial,
  };
}

function makeSnapshot(quests: Quest[] = [], roster: Card[] = []): Snapshot {
  return {
    generatedAt: '2026-09-13T00:00:00.000Z',
    project: { name: 'Test', id: 'testprojectid0', lanes: ['default'] },
    quests,
    roster,
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
  };
}

/** A board column that must exist: fail loudly naming it, never silently skip the checks. */
function columnByKey(key: Column['key']): Column {
  const col = COLUMNS.find((c) => c.key === key);
  if (!col) throw new Error(`看板列不见了：${key}`);
  return col;
}

function trayIds(snap: Snapshot): string[] {
  return inTrayItems(snap).map((item) => item.quest.id);
}

describe('board pure helpers', () => {
  it('columns sort', () => {
    const q1 = makeQuest({ id: 'q1', priority: 2, updatedAt: '2026-09-10T10:00:00.000Z', status: 'posted' });
    const q2 = makeQuest({ id: 'q2', priority: 1, updatedAt: '2026-09-10T08:00:00.000Z', status: 'posted' });
    const q3 = makeQuest({ id: 'q3', priority: 2, updatedAt: '2026-09-10T12:00:00.000Z', status: 'posted' });
    const q4 = makeQuest({ id: 'q4', priority: 3, updatedAt: '2026-09-10T15:00:00.000Z', status: 'posted' });
    const other = makeQuest({ id: 'other', status: 'done', updatedAt: '2026-09-10T20:00:00.000Z' });

    const snap = makeSnapshot([q1, q2, q3, q4, other]);

    const openCol: Column = {
      key: 'open',
      num: '01',
      title: '委托板',
      sub: 'OPEN',
      statuses: ['posted'],
    };

    const openItems = questsInColumn(snap, openCol);
    expect(openItems.map((q) => q.id)).toEqual(['q2', 'q3', 'q1', 'q4']);
  });

  it('never caps a column: the archive column returns every quest, newest first, even past its page-size hint', () => {
    const d1 = makeQuest({ id: 'd1', status: 'done', updatedAt: '2026-09-10T01:00:00.000Z' });
    const d2 = makeQuest({ id: 'd2', status: 'done', updatedAt: '2026-09-10T03:00:00.000Z' });
    const d3 = makeQuest({ id: 'd3', status: 'done', updatedAt: '2026-09-10T02:00:00.000Z' });

    const snapDone = makeSnapshot([d1, d2, d3]);
    const doneCol: Column = {
      key: 'done',
      num: '05',
      title: '卷宗室',
      sub: 'ARCHIVED',
      statuses: ['done'],
      limit: 2,
    };

    const doneItems = questsInColumn(snapDone, doneCol);
    expect(doneItems.map((q) => q.id)).toEqual(['d2', 'd3', 'd1']);
  });

  it('projectScopedKey namespaces by the snapshot project id, falling back for an older server', () => {
    const withId = makeSnapshot([]);
    expect(projectScopedKey('questboard.doneColumnOpen', withId)).toBe('questboard.doneColumnOpen.testprojectid0');
    const noId = { ...withId, project: { ...withId.project, id: undefined } };
    expect(projectScopedKey('questboard.doneColumnOpen', noId)).toBe('questboard.doneColumnOpen');
  });

  it('filterQuests matches id or title, case-insensitively, and an empty query keeps everything', () => {
    const a = makeQuest({ id: 'RUN-4', title: 'Fix the loop controller' });
    const b = makeQuest({ id: 'ART-2', title: 'Redo the banner' });
    expect(filterQuests([a, b], 'run')).toEqual([a]);
    expect(filterQuests([a, b], 'banner')).toEqual([b]);
    expect(filterQuests([a, b], '')).toEqual([a, b]);
    expect(filterQuests([a, b], 'nope')).toEqual([]);
  });

  it('paginate slices into pages and clamps a stale page number back into range', () => {
    const items = Array.from({ length: 5 }, (_, i) => `item-${i}`);
    const first = paginate(items, 1, 2);
    expect(first).toEqual({ pageItems: ['item-0', 'item-1'], page: 1, totalPages: 3, total: 5 });
    const last = paginate(items, 3, 2);
    expect(last.pageItems).toEqual(['item-4']);
    const tooFar = paginate(items, 99, 2);
    expect(tooFar.page).toBe(3);
    expect(tooFar.pageItems).toEqual(['item-4']);
    const empty = paginate<string>([], 1, 2);
    expect(empty).toEqual({ pageItems: [], page: 1, totalPages: 1, total: 0 });
  });

  it('groupRefusals groups one message across cards', () => {
    const verdicts: Record<string, Verdict> = {
      c1: { ok: true, reasons: [] },
      c2: { ok: false, reasons: [{ code: 'lane_limit', message: '通道限额' }] },
      c3: { ok: false, reasons: [{ code: 'lane_limit', message: '通道限额' }] },
      c4: { ok: false, reasons: [{ code: 'stalled', message: '卡住了' }] },
    };

    const result = groupRefusals(verdicts);
    expect(result.canTake).toEqual(['c1']);

    const laneLimitGroup = result.refused.find((r) => r.message === '通道限额');
    expect(laneLimitGroup).toBeDefined();
    expect(laneLimitGroup?.cards).toEqual(['c2', 'c3']);

    const stalledGroup = result.refused.find((r) => r.message === '卡住了');
    expect(stalledGroup).toBeDefined();
    expect(stalledGroup?.cards).toEqual(['c4']);
  });

  it('isQueueOnly true only when every reason is a conflict and false for no reasons', () => {
    expect(isQueueOnly({ ok: false, reasons: [{ code: 'conflict_running', message: 'wait' }] })).toBe(true);
    expect(
      isQueueOnly({
        ok: false,
        reasons: [
          { code: 'conflict_running', message: 'w1' },
          { code: 'conflict_running', message: 'w2' },
        ],
      }),
    ).toBe(true);
    expect(
      isQueueOnly({
        ok: false,
        reasons: [
          { code: 'conflict_running', message: 'w1' },
          { code: 'lane_limit', message: 'limit' },
        ],
      }),
    ).toBe(false);
    expect(isQueueOnly({ ok: false, reasons: [] })).toBe(false);
    expect(isQueueOnly({ ok: true, reasons: [] })).toBe(false);
    expect(isQueueOnly({ ok: true, reasons: [{ code: 'conflict_running', message: 'wait' }] })).toBe(false);
    expect(isQueueOnly(null)).toBe(false);
    expect(isQueueOnly(undefined)).toBe(false);
  });

  it('relatedQuestIds walks ancestors, descendants and conflicts and terminates on a parent cycle', () => {
    const qA = makeQuest({ id: 'A', parents: ['B'], conflicts: ['E'] });
    const qB = makeQuest({ id: 'B', parents: ['C'] });
    const qC = makeQuest({ id: 'C' });
    const qD = makeQuest({ id: 'D', parents: ['A'] });
    const qE = makeQuest({ id: 'E' });
    const qF = makeQuest({ id: 'F', conflicts: ['A'] });

    const snap = makeSnapshot([qA, qB, qC, qD, qE, qF]);
    const relatedA = relatedQuestIds(snap, 'A');

    expect(new Set(relatedA)).toEqual(new Set(['A', 'B', 'C', 'D', 'E', 'F']));

    const cycle1 = makeQuest({ id: 'cyc1', parents: ['cyc2'] });
    const cycle2 = makeQuest({ id: 'cyc2', parents: ['cyc1'] });
    const snapCycle = makeSnapshot([cycle1, cycle2]);

    const relatedCycle = relatedQuestIds(snapCycle, 'cyc1');
    expect(new Set(relatedCycle)).toEqual(new Set(['cyc1', 'cyc2']));
  });

  it('busyQuests and cardLabel', () => {
    const q1 = makeQuest({
      id: 'q1',
      status: 'dispatched',
      assignee: {
        adventurerId: 'card-1',
        family: null,
        lane: 'default',
        model: 'm1',
        variant: '',
        name: 'w1',
        at: '',
        by: '',
      },
    });
    const q2 = makeQuest({ id: 'q2', status: 'posted' });
    const snap = makeSnapshot([q1, q2]);

    expect(busyQuests(snap, 'card-1').map((q) => q.id)).toEqual(['q1']);
    expect(busyQuests(snap, 'card-2')).toEqual([]);

    const card: Card = {
      id: 'card-1',
      name: 'Agent 1',
      provider: 'test',
      lane: 'default',
      model: 'test',
      family: 'test',
      status: 'available',
      statusSince: null,
      statusReason: '',
      statusSetBy: null,
      maxParallel: 2,
    };

    expect(cardLabel(card, 0)).toBe('空闲 0/2');
    expect(cardLabel(card, 1)).toBe('空闲 1/2');
    expect(cardLabel(card, 2)).toBe('满员 2/2');

    const pausedCard = { ...card, status: 'paused' as const };
    expect(cardLabel(pausedCard, 0)).toBe('暂停');
  });

  describe('isSafeReviewUrl', () => {
    it('accepts valid /review/... paths', () => {
      expect(isSafeReviewUrl('/review/look-3')).toBe(true);
      expect(isSafeReviewUrl('/review/sub/path/123')).toBe(true);
      expect(isSafeReviewUrl('/review/arc-1?status=done')).toBe(true);
    });

    it('rejects URLs not starting with /review/', () => {
      expect(isSafeReviewUrl('javascript:alert(1)')).toBe(false);
      expect(isSafeReviewUrl('https://evil.com/review/1')).toBe(false);
      expect(isSafeReviewUrl('http://evil.com/review/1')).toBe(false);
      expect(isSafeReviewUrl('/review')).toBe(false);
      expect(isSafeReviewUrl('/other/review/1')).toBe(false);
      expect(isSafeReviewUrl('')).toBe(false);
      expect(isSafeReviewUrl(null)).toBe(false);
      expect(isSafeReviewUrl(undefined)).toBe(false);
    });

    it('rejects URLs containing .. path traversal segments', () => {
      expect(isSafeReviewUrl('/review/..')).toBe(false);
      expect(isSafeReviewUrl('/review/../etc/passwd')).toBe(false);
      expect(isSafeReviewUrl('/review/sub/..')).toBe(false);
      expect(isSafeReviewUrl('/review/a/../b')).toBe(false);
      expect(isSafeReviewUrl('/review/%2e%2e/secret')).toBe(false);
      expect(isSafeReviewUrl('/review/test?page=..')).toBe(false);
      expect(isSafeReviewUrl('/review/test#..')).toBe(false);
    });
  });

  describe('reviewSourcePath', () => {
    it('把评审目录地址转成相对清单路径', () => {
      expect(reviewSourcePath('/review/art/charA/final.html')).toBe('art/charA/final.html');
      expect(reviewSourcePath('/review/nested/dir/page.html')).toBe('nested/dir/page.html');
    });

    it('目录外地址和空地址返回 null', () => {
      expect(reviewSourcePath('/other/page.html')).toBeNull();
      expect(reviewSourcePath('/review/')).toBeNull();
      expect(reviewSourcePath('')).toBeNull();
    });
  });

  describe('column semantics (QB-FB-G)', () => {
    it('names the check column as verification, not an owner queue', () => {
      const check = COLUMNS.find((col) => col.key === 'check');
      expect([check?.title, check?.sub]).toEqual(['交差核验', 'VERIFY']);
      // FB2-02: the coordinator's queue also holds the two coordinator-bound parks — a send-back whose
      // annotations named it (needs_coordinator) and a saved owner ruling waiting for import (owner_ruled).
      expect(check?.statuses).toEqual(['delivered', 'reviewing', 'needs_coordinator', 'owner_ruled']);
    });

    it('keeps the four active zones plus the archive unchanged in membership', () => {
      const keys = COLUMNS.map((col) => col.key);
      expect(keys).toEqual(['open', 'run', 'check', 'owner', 'done']);
      expect(COLUMNS.find((col) => col.key === 'run')?.statuses).toEqual(['dispatched']);
      expect(COLUMNS.find((col) => col.key === 'owner')?.statuses).toEqual(['needs_owner', 'owner_playtest']);
      expect(COLUMNS.find((col) => col.key === 'done')?.statuses).toEqual(['done', 'superseded', 'cancelled']);
    });

    it('counts each quest in exactly one column, even a review next to the work it reviews', () => {
      const work = makeQuest({ id: 'work', status: 'delivered' });
      const review = makeQuest({
        id: 'REVIEW-work', kind: 'review', parents: ['work'], status: 'delivered',
        lastDetail: 'VERDICT: PASS', createdAt: '2026-09-13T02:00:00.000Z',
      });
      const snap = makeSnapshot([work, review]);
      const placed = COLUMNS.map((col) => questsInColumn(snap, col).map((q) => q.id).sort());
      expect(placed).toEqual([[], [], ['REVIEW-work', 'work'], [], []]);
    });

    it('hands returned ART to the owner column, not the verification column', () => {
      const art = makeQuest({ id: 'art-1', kind: 'art', status: 'delivered' });
      const code = makeQuest({ id: 'code-1', kind: 'code', status: 'delivered' });
      const tool = makeQuest({ id: 'tool-1', kind: 'tool', status: 'reviewing' });
      const snap = makeSnapshot([art, code, tool]);
      const check = columnByKey('check');
      const owner = columnByKey('owner');
      expect(questsInColumn(snap, check).map((q) => q.id)).toEqual(['code-1', 'tool-1']);
      expect(questsInColumn(snap, owner).map((q) => q.id)).toEqual(['art-1']);
      const total = COLUMNS.reduce((n, col) => n + questsInColumn(snap, col).length, 0);
      expect(total).toBe(3);
    });

    it('routes an explicit owner question out of 交差核验 into 等会长', () => {
      const asked = makeQuest({ id: 'code-q', kind: 'code', status: 'delivered', needsOwner: '两个方案选哪个？' });
      const silent = makeQuest({ id: 'code-s', kind: 'code', status: 'delivered' });
      const snap = makeSnapshot([asked, silent]);
      const check = columnByKey('check');
      const owner = columnByKey('owner');
      expect(questsInColumn(snap, check).map((q) => q.id)).toEqual(['code-s']);
      expect(questsInColumn(snap, owner).map((q) => q.id)).toEqual(['code-q']);
    });

    it('keeps a technical review quest in 交差核验 even when the review itself waits on nobody', () => {
      const work = makeQuest({ id: 'work', status: 'delivered' });
      const review = makeQuest({
        id: 'REVIEW-work', kind: 'review', parents: ['work'], status: 'delivered',
        lastDetail: 'VERDICT: FAIL', createdAt: '2026-09-13T02:00:00.000Z',
      });
      const snap = makeSnapshot([work, review]);
      const check = columnByKey('check');
      const owner = columnByKey('owner');
      expect(questsInColumn(snap, check).map((q) => q.id)).toEqual(['work', 'REVIEW-work']);
      expect(questsInColumn(snap, owner)).toEqual([]);
      expect(nextStep(review, snap).who).not.toBe('you');
      expect(trayIds(snap)).not.toContain('REVIEW-work');
    });

    it('a review without a question stays verification, even one over art, and never asks twice', () => {
      const codeWork = makeQuest({ id: 'code-work', kind: 'code', status: 'delivered' });
      const artWork = makeQuest({ id: 'art-work', kind: 'art', status: 'delivered' });
      const overCode = makeQuest({
        id: 'R-code', kind: 'review', parents: ['code-work'], status: 'delivered',
        lastDetail: 'VERDICT: PASS', createdAt: '2026-09-13T02:00:00.000Z',
      });
      const overArt = makeQuest({
        id: 'R-art', kind: 'review', parents: ['art-work'], status: 'reviewing',
        lastDetail: 'VERDICT: findings', createdAt: '2026-09-13T03:00:00.000Z',
      });
      const blank = makeQuest({
        id: 'R-blank', kind: 'review', parents: ['code-work'], status: 'delivered', needsOwner: '   ',
        lastDetail: 'VERDICT: PASS', createdAt: '2026-09-13T04:00:00.000Z',
      });
      const snap = makeSnapshot([codeWork, artWork, overCode, overArt, blank]);
      const check = columnByKey('check');
      const owner = columnByKey('owner');
      expect(questsInColumn(snap, check).map((q) => q.id).sort()).toEqual(['R-art', 'R-blank', 'R-code', 'code-work']);
      expect(questsInColumn(snap, owner).map((q) => q.id)).toEqual(['art-work']);
      // The verdict of R-art reads on its parent: the owner gets one ask (art-work), not a second one.
      expect(trayIds(snap)).toEqual(['art-work']);
      const placed = COLUMNS.map((col) => questsInColumn(snap, col).map((q) => q.id));
      expect(placed.flat().sort()).toEqual(['R-art', 'R-blank', 'R-code', 'art-work', 'code-work']);
    });

    it('routes a returned review with its own question to 等会长, counted once, as tray and next step do', () => {
      const work = makeQuest({ id: 'work', kind: 'code', status: 'delivered' });
      const review = makeQuest({
        id: 'REVIEW-code', kind: 'review', parents: ['work'], status: 'delivered',
        needsOwner: '要不要上线？', lastDetail: 'VERDICT: findings', createdAt: '2026-09-13T02:00:00.000Z',
      });
      const snap = makeSnapshot([work, review]);
      const check = columnByKey('check');
      const owner = columnByKey('owner');
      expect(questsInColumn(snap, check).map((q) => q.id)).toEqual(['work']);
      expect(questsInColumn(snap, owner).map((q) => q.id)).toEqual(['REVIEW-code']);
      expect(nextStep(review, snap).who).toBe('you');
      expect(trayIds(snap)).toEqual(['REVIEW-code']);
      const decide = inTrayItems(snap).find((item) => item.quest.id === 'REVIEW-code');
      expect(decide?.kind).toBe('decide');
      const placed = COLUMNS.map((col) => questsInColumn(snap, col).map((q) => q.id));
      expect(placed.flat().sort()).toEqual(['REVIEW-code', 'work']);
    });

    it('moves a reviewing review with a question too, and a needs_owner review is placed by status once', () => {
      const late = makeQuest({ id: 'R-late', kind: 'review', parents: [], status: 'reviewing', needsOwner: '这个结论你接受吗？' });
      const atOwner = makeQuest({ id: 'R-owner', kind: 'review', parents: [], status: 'needs_owner', needsOwner: '按哪个方案？' });
      const snap = makeSnapshot([late, atOwner]);
      const check = columnByKey('check');
      const owner = columnByKey('owner');
      expect(questsInColumn(snap, check)).toEqual([]);
      expect(questsInColumn(snap, owner).map((q) => q.id).sort()).toEqual(['R-late', 'R-owner']);
      const placed = COLUMNS.map((col) => questsInColumn(snap, col).map((q) => q.id));
      expect(placed.flat().sort()).toEqual(['R-late', 'R-owner']);
    });

    it('leaves statuses outside delivered/reviewing exactly where they were', () => {
      const quests = [
        makeQuest({ id: 'p', status: 'posted' }),
        makeQuest({ id: 'd', status: 'dispatched' }),
        makeQuest({ id: 'no', kind: 'art', status: 'needs_owner' }),
        makeQuest({ id: 'op', kind: 'art', status: 'owner_playtest' }),
        makeQuest({ id: 'f', status: 'done' }),
        makeQuest({ id: 'art-d', kind: 'art', status: 'delivered' }),
      ];
      const snap = makeSnapshot(quests);
      const placed = COLUMNS.map((col) => questsInColumn(snap, col).map((q) => q.id));
      // 01 open · 02 run · 03 check · 04 owner · 05 archive — the delivered art left check for the owner zone.
      expect(placed).toEqual([['p'], ['d'], [], ['no', 'op', 'art-d'], ['f']]);
      expect(placed.flat().length).toBe(quests.length);
    });

    it('the column agrees with the card: who the next step waits on decides the zone', () => {
      const art = makeQuest({ id: 'art-1', kind: 'art', status: 'delivered' });
      const code = makeQuest({ id: 'code-1', kind: 'code', status: 'delivered' });
      const askedReview = makeQuest({
        id: 'R-ask', kind: 'review', parents: ['code-1'], status: 'delivered', needsOwner: '要不要上线？',
        createdAt: '2026-09-13T02:00:00.000Z',
      });
      const silentReview = makeQuest({
        id: 'R-silent', kind: 'review', parents: ['art-1'], status: 'delivered', lastDetail: 'VERDICT: PASS',
        createdAt: '2026-09-13T03:00:00.000Z',
      });
      const snap = makeSnapshot([art, code, askedReview, silentReview]);
      const owner = columnByKey('owner');
      const check = columnByKey('check');
      const tray = trayIds(snap);
      for (const q of [art, code, askedReview, silentReview]) {
        const inOwner = questsInColumn(snap, owner).some((x) => x.id === q.id);
        const inCheck = questsInColumn(snap, check).some((x) => x.id === q.id);
        expect(inOwner !== inCheck).toBe(true);
        // Whatever a returned quest's column, the owner's tray must demand exactly the same set.
        expect(inOwner).toBe(tray.includes(q.id));
        if (q.kind === 'review') {
          expect(inOwner).toBe(hasOwnerQuestion(q));
        } else {
          expect(inOwner).toBe(nextStep(q, snap).who === 'you');
        }
      }
      const placed = COLUMNS.map((col) => questsInColumn(snap, col).map((x) => x.id));
      expect(placed.flat().sort()).toEqual(['R-ask', 'R-silent', 'art-1', 'code-1']);
    });
  });
});


  describe('check column backlog order (FB2-04 item 4)', () => {
    it('sorts the check column by wait time, longest-waiting first, ignoring priority', () => {
      const snap = makeSnapshot([
        makeQuest({ id: 'CK-1', status: 'delivered', statusAt: '2026-09-20T10:00:00.000Z', priority: 1 }),
        makeQuest({ id: 'CK-2', status: 'delivered', statusAt: '2026-09-19T08:00:00.000Z', priority: 3 }),
        makeQuest({ id: 'CK-3', status: 'reviewing', statusAt: '2026-09-20T01:00:00.000Z', priority: 2 }),
      ]);
      const check = COLUMNS.find((col) => col.key === 'check')!;
      expect(questsInColumn(snap, check).map((q) => q.id)).toEqual(['CK-2', 'CK-3', 'CK-1']);
    });
  });
