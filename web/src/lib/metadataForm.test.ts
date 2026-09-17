import { describe, expect, it } from 'vitest';
import {
  adoptedFieldLabels, applyConflictChoice, changedFieldLabels, describeConflict, detectConflicts, diffDraft,
  draftFromQuest, hasChanges, isQuestOccupied, liveConflict, mergeConflictBaseline, occupiedReason, rebaseDraft,
  snapshotToastMessage, translateServerMessage,
} from './metadataForm';
import { makeAssignee, makeQuest } from './testFixtures';

describe('draftFromQuest / diffDraft', () => {
  it('round-trips a quest into a draft with independent array copies', () => {
    const quest = makeQuest({ id: 'A-1', parents: ['P-1'], conflicts: ['C-1'], allowedLanes: ['codex'] });
    const draft = draftFromQuest(quest);
    draft.parents.push('P-2');
    expect(quest.parents).toEqual(['P-1']); // the quest's own array is untouched
  });

  it('produces an empty payload for an untouched draft', () => {
    const quest = makeQuest({ id: 'A-1' });
    const draft = draftFromQuest(quest);
    expect(diffDraft(draft, draft)).toEqual({});
    expect(hasChanges(diffDraft(draft, draft))).toBe(false);
  });

  it('includes only the fields that actually changed', () => {
    const quest = makeQuest({ id: 'A-1', title: 'old', needsOwner: 'pick one' });
    const baseline = draftFromQuest(quest);
    const draft = { ...baseline, title: 'new' };
    const payload = diffDraft(baseline, draft);
    expect(payload).toEqual({ title: 'new' });
  });

  it('sends a deliberately cleared field (blank counts as changed)', () => {
    const quest = makeQuest({ id: 'A-1', needsOwner: 'pick one' });
    const baseline = draftFromQuest(quest);
    const draft = { ...baseline, needsOwner: '' };
    expect(diffDraft(baseline, draft)).toEqual({ needsOwner: '' });
  });

  it('treats a same-content, same-order list as unchanged, but any reorder/add/remove as changed', () => {
    const quest = makeQuest({ id: 'A-1', parents: ['P-1', 'P-2'] });
    const baseline = draftFromQuest(quest);
    expect(diffDraft(baseline, { ...baseline, parents: ['P-1', 'P-2'] })).toEqual({});
    expect(diffDraft(baseline, { ...baseline, parents: ['P-2', 'P-1'] })).toEqual({ parents: ['P-2', 'P-1'] });
    expect(diffDraft(baseline, { ...baseline, parents: ['P-1'] })).toEqual({ parents: ['P-1'] });
    expect(diffDraft(baseline, { ...baseline, parents: ['P-1', 'P-2', 'P-3'] })).toEqual({ parents: ['P-1', 'P-2', 'P-3'] });
  });

  it('reports every changed field together', () => {
    const quest = makeQuest({ id: 'A-1', title: 'old', brief: 'docs/briefs/a.md' });
    const baseline = draftFromQuest(quest);
    const draft = { ...baseline, title: 'new', brief: 'docs/briefs/b.md', conflicts: ['C-9'] };
    expect(diffDraft(baseline, draft)).toEqual({ title: 'new', brief: 'docs/briefs/b.md', conflicts: ['C-9'] });
  });
});

describe('isQuestOccupied / occupiedReason', () => {
  it('is false for a posted quest with no assignee', () => {
    expect(isQuestOccupied(makeQuest({ id: 'A-1', status: 'posted' }))).toBe(false);
  });

  it('is true while dispatched with an assignee, false for a delivered/done quest', () => {
    const dispatched = makeQuest({ id: 'A-1', status: 'dispatched', assignee: makeAssignee('card-1') });
    expect(isQuestOccupied(dispatched)).toBe(true);
    expect(occupiedReason(dispatched)).toMatch(/先别改/);
    expect(isQuestOccupied(makeQuest({ id: 'A-2', status: 'delivered', assignee: makeAssignee('card-1') }))).toBe(false);
    expect(isQuestOccupied(makeQuest({ id: 'A-3', status: 'done' }))).toBe(false);
  });

  it('is true while stalled with an assignee still attached (unconfirmed worker) — same as a running quest', () => {
    const stalled = makeQuest({ id: 'A-1', status: 'stalled', assignee: makeAssignee('card-1') });
    expect(isQuestOccupied(stalled)).toBe(true);
    expect(occupiedReason(stalled)).toMatch(/失联/);
  });

  it('a stalled quest with no assignee (already released) is not occupied', () => {
    expect(isQuestOccupied(makeQuest({ id: 'A-1', status: 'stalled', assignee: null }))).toBe(false);
  });
});

// N4: the server (src/core/metadataUpdate.js, src/server/questRoutes.js) answers with honest English. Every
// exact shape it can produce for the owner-facing metadata form is checked here against the real message
// text, not a paraphrase, so a future wording change in the backend surfaces as a failing test instead of a
// silently-stale translation.
describe('translateServerMessage: known server shapes become plain Chinese naming the id', () => {
  it('a deleted/unreachable quest (the real 404 body for this route)', () => {
    expect(translateServerMessage('quest not found')).toBe('这个委托已经不在看板上了');
  });

  it('a missing parent, the exact validateParents wording', () => {
    const raw = 'parent NOPE-9 not found; post it first (POST /api/quests, package NOPE-9) or fix the id, then try A-1 again';
    expect(translateServerMessage(raw)).toBe('前置委托 NOPE-9 不存在，请先创建它，或者改成别的编号再试一次');
  });

  it('a self-parent', () => {
    expect(translateServerMessage('A-1 cannot be its own parent')).toBe('不能把 A-1 设成自己的前置委托');
  });

  it('a parent cycle', () => {
    expect(translateServerMessage('parents would create a cycle back to A-1')).toBe('这样连下去会绕回 A-1，形成循环依赖');
  });

  it('a non-package-id parent', () => {
    expect(translateServerMessage('parents must be package ids, got not-an-id')).toBe('前置委托必须是委托编号，收到的是 not-an-id');
  });

  it('a self-conflict', () => {
    expect(translateServerMessage('A-1 cannot conflict with itself')).toBe('不能把 A-1 设成和自己冲突');
  });

  it('a non-package-id conflict', () => {
    expect(translateServerMessage('conflicts must be package ids, got not-an-id')).toBe('冲突列表必须是委托编号，收到的是 not-an-id');
  });

  it('an unknown lane, keeping the server\'s own defined-lanes list', () => {
    expect(translateServerMessage('unknown lane ghost; this project defines codex, opencode'))
      .toBe('没有这个工具：ghost；这个项目里配置的工具是 codex, opencode');
  });

  it('a required-brief refusal', () => {
    expect(translateServerMessage('brief is required')).toBe('简报路径不能为空');
  });

  it('a badly-shaped brief path', () => {
    expect(translateServerMessage('brief must be <dir>/<file>.md with <dir> one of docs/briefs, docs/owner'))
      .toBe('简报路径格式不对，应该是 <目录>/<文件>.md，允许的目录是 docs/briefs, docs/owner');
  });

  it('an unrecognized message is shown verbatim, under a Chinese prefix, never bare', () => {
    expect(translateServerMessage('some future server refusal')).toBe('服务器说：some future server refusal');
  });
});

describe('changedFieldLabels', () => {
  it('is empty for two identical drafts', () => {
    const draft = draftFromQuest(makeQuest({ id: 'A-1' }));
    expect(changedFieldLabels(draft, draft)).toEqual([]);
  });

  it('names every field that actually differs, in field order', () => {
    const a = draftFromQuest(makeQuest({ id: 'A-1', title: 'old', parents: ['P-1'] }));
    const b = { ...a, title: 'new', parents: ['P-2'] };
    expect(changedFieldLabels(a, b)).toEqual(['标题', '前置委托']);
  });

  it('treats a same-content list as unchanged', () => {
    const a = draftFromQuest(makeQuest({ id: 'A-1', conflicts: ['C-1', 'C-2'] }));
    const b = { ...a, conflicts: ['C-1', 'C-2'] };
    expect(changedFieldLabels(a, b)).toEqual([]);
  });
});

// Round 2 PM ruling for F-2/F-3: a field changed on both sides is a conflict, never a silent overwrite.
// R2 scenario from the review: the owner typed a new title and collapsed; the coordinator also changed the
// title before the owner reopened.
describe('detectConflicts (F-2/F-3): a field changed on both sides is flagged, never silently adopted', () => {
  it('is empty when the owner touched nothing (R1/R4: everything just follows the server)', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', title: 'old', needsOwner: 'old question' }));
    const draft = oldBaseline; // untouched
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', title: 'server title', needsOwner: 'server question' }));
    expect(detectConflicts(oldBaseline, draft, serverDraft)).toEqual({});
  });

  it('is empty when the owner touched a field but the server left it alone (the ordinary edit-in-progress case)', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', title: 'old' }));
    const draft = { ...oldBaseline, title: 'owner is typing this' };
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', title: 'old' })); // server unchanged
    expect(detectConflicts(oldBaseline, draft, serverDraft)).toEqual({});
  });

  it('R2: flags a field both sides changed, naming both values — the exact scenario the review reproduced', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'STALE-1', title: '原标题' }));
    const draft = { ...oldBaseline, title: '我改的标题' };
    const serverDraft = draftFromQuest(makeQuest({ id: 'STALE-1', title: '别人改的标题' }));
    expect(detectConflicts(oldBaseline, draft, serverDraft)).toEqual({
      title: { server: '别人改的标题', mine: '我改的标题' },
    });
  });

  it('only flags the fields actually touched by the owner, even if the server changed several', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', title: 'old', needsOwner: 'old question' }));
    const draft = { ...oldBaseline, title: 'owner edit' }; // touched only title
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', title: 'server edit', needsOwner: 'server edit too' }));
    expect(detectConflicts(oldBaseline, draft, serverDraft)).toEqual({
      title: { server: 'server edit', mine: 'owner edit' },
    });
  });

  it('flags a list field the same way (parents changed on both sides)', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', parents: ['P-1'] }));
    const draft = { ...oldBaseline, parents: ['P-1', 'P-2'] };
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', parents: ['P-1', 'P-3'] }));
    expect(detectConflicts(oldBaseline, draft, serverDraft)).toEqual({
      parents: { server: ['P-1', 'P-3'], mine: ['P-1', 'P-2'] },
    });
  });
});

describe('mergeConflictBaseline: a conflicting field never moves its baseline (the "do NOT move the revision" ruling)', () => {
  it('keeps the OLD baseline value for a conflicting field, but adopts the server value everywhere else', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', title: 'old', needsOwner: 'old question' }));
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', title: 'server title', needsOwner: 'server question' }));
    const conflicts = { title: { server: 'server title', mine: 'owner title' } };
    const merged = mergeConflictBaseline(oldBaseline, serverDraft, conflicts);
    expect(merged.title).toBe('old'); // held back — still the pre-conflict anchor
    expect(merged.needsOwner).toBe('server question'); // not conflicting, follows the server as usual
  });

  it('is identical to serverDraft when there are no conflicts', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', title: 'old' }));
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', title: 'server title' }));
    expect(mergeConflictBaseline(oldBaseline, serverDraft, {})).toEqual(serverDraft);
  });
});

describe('adoptedFieldLabels: only the truly-adopted fields may claim "已经显示最新内容"', () => {
  it('names a server-changed, non-conflicting field', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', needsOwner: 'old question' }));
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', needsOwner: 'server question' }));
    expect(adoptedFieldLabels(oldBaseline, serverDraft, {})).toEqual(['需要你决定的事']);
  });

  it('excludes a conflicting field even though its server value also changed (the F-2 toast-wording bug)', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', title: 'old', needsOwner: 'old question' }));
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', title: 'server title', needsOwner: 'server question' }));
    const conflicts = { title: { server: 'server title', mine: 'owner title' } };
    // title changed on the server too, but it's conflicting (still shows the owner's edit) — must not be
    // named as "already showing the latest content".
    expect(adoptedFieldLabels(oldBaseline, serverDraft, conflicts)).toEqual(['需要你决定的事']);
  });

  it('is empty when every server change is conflicting', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', title: 'old' }));
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', title: 'server title' }));
    const conflicts = { title: { server: 'server title', mine: 'owner title' } };
    expect(adoptedFieldLabels(oldBaseline, serverDraft, conflicts)).toEqual([]);
  });
});

describe('describeConflict: 「字段：服务器已改成 X，你这边是 Y」, naming both values', () => {
  it('formats a plain-text field', () => {
    expect(describeConflict('title', { server: '别人改的标题', mine: '我改的标题' }))
      .toBe('标题：服务器已改成 别人改的标题，你这边是 我改的标题');
  });

  it('formats a list field, joined with 、', () => {
    expect(describeConflict('parents', { server: ['P-1', 'P-3'], mine: ['P-1', 'P-2'] }))
      .toBe('前置委托：服务器已改成 P-1、P-3，你这边是 P-1、P-2');
  });

  it('shows （空） for an empty string or empty list, never a blank gap', () => {
    expect(describeConflict('title', { server: '', mine: '我的标题' })).toBe('标题：服务器已改成 （空），你这边是 我的标题');
    expect(describeConflict('parents', { server: [], mine: ['P-1'] })).toBe('前置委托：服务器已改成 （空），你这边是 P-1');
  });
});

// N-2 (round 2 review): conflict.mine is captured once, at detection — if the owner keeps typing the
// conflicting field afterward, the banner must describe what 用我的 would actually send, not that stale value.
describe('liveConflict: the banner\'s "你这边是" always matches the live draft, not the value at detection', () => {
  it('replaces the captured "mine" with the current draft value for that field', () => {
    const conflict = { server: '别人改的标题', mine: '开着两边改-我' };
    const draft = draftFromQuest(makeQuest({ id: 'A-1', title: '开着两边改-我又改了' }));
    expect(liveConflict('title', conflict, draft)).toEqual({ server: '别人改的标题', mine: '开着两边改-我又改了' });
  });

  it('leaves "server" untouched', () => {
    const conflict = { server: '别人改的标题', mine: '我改的标题' };
    const draft = draftFromQuest(makeQuest({ id: 'A-1', title: '我改的标题' }));
    expect(liveConflict('title', conflict, draft).server).toBe('别人改的标题');
  });

  it('composes with describeConflict to render the live value in the sentence', () => {
    const conflict = { server: '别人改的标题', mine: '开着两边改-我' };
    const draft = draftFromQuest(makeQuest({ id: 'A-1', title: '开着两边改-我又改了' }));
    expect(describeConflict('title', liveConflict('title', conflict, draft)))
      .toBe('标题：服务器已改成 别人改的标题，你这边是 开着两边改-我又改了');
  });
});

describe('applyConflictChoice: 用服务器的 drops the edit, 用我的 keeps it — both re-anchor the baseline', () => {
  const oldBaseline = draftFromQuest(makeQuest({ id: 'STALE-1', title: '原标题' }));
  const draft = { ...oldBaseline, title: '我改的标题' };
  const conflict = { server: '别人改的标题', mine: '我改的标题' };

  it('用服务器的: the draft drops the owner\'s edit and shows the server value', () => {
    const { draft: nextDraft, baseline } = applyConflictChoice(draft, oldBaseline, 'title', conflict, 'server');
    expect(nextDraft.title).toBe('别人改的标题');
    expect(baseline.title).toBe('别人改的标题'); // re-anchored, so the field is no longer "touched" either
  });

  it('用我的: the draft keeps the owner\'s edit, but the baseline re-anchors so the next save is explicit', () => {
    const { draft: nextDraft, baseline } = applyConflictChoice(draft, oldBaseline, 'title', conflict, 'mine');
    expect(nextDraft.title).toBe('我改的标题'); // unchanged — the deliberate overwrite
    expect(baseline.title).toBe('别人改的标题'); // re-anchored to what the owner just saw and chose to overwrite
    // proof this becomes an explicit overwrite, not a silent one: the field is still "touched" against the
    // new baseline, so diffDraft still sends it — exactly what a deliberate choice should do.
    expect(diffDraft(baseline, nextDraft)).toEqual({ title: '我改的标题' });
  });

  it('leaves every other field untouched', () => {
    const withOtherField = { ...oldBaseline, needsOwner: 'something else entirely' };
    const { baseline } = applyConflictChoice(withOtherField, oldBaseline, 'title', conflict, 'mine');
    expect(baseline.needsOwner).toBe(oldBaseline.needsOwner);
  });
});

// Round 2 PM ruling 3 test list, reproduced at the pure-logic level (no DOM library is installed — see
// TaskChipPicker.test.tsx's own note): both-sides-changed on reopen is blocked until chosen; choosing 用我的
// saves with the new revision; choosing 用服务器的 drops the edit; collapsing after a 409 keeps the banner.
describe('end-to-end conflict flow (R2/R3, blocked-until-chosen)', () => {
  it('both-sides-changed on reopen: conflicts is non-empty, so the caller must block saving until resolved', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'STALE-1', title: '原标题' }));
    const draft = { ...oldBaseline, title: '我改的标题' };
    const serverDraft = draftFromQuest(makeQuest({ id: 'STALE-1', title: '别人改的标题' }));
    const conflicts = detectConflicts(oldBaseline, draft, serverDraft);
    expect(Object.keys(conflicts)).toEqual(['title']); // save must be blocked (Object.keys(conflicts).length > 0)
    expect(rebaseDraft(oldBaseline, draft, serverDraft).title).toBe('我改的标题'); // still shows the owner's edit, not "已经显示最新内容"
  });

  it('choosing 用我的 then saves with the current server revision (an explicit overwrite)', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'STALE-1', title: '原标题' }));
    const draft = { ...oldBaseline, title: '我改的标题' };
    const serverDraft = draftFromQuest(makeQuest({ id: 'STALE-1', title: '别人改的标题', revision: 2 }));
    const conflicts = detectConflicts(oldBaseline, draft, serverDraft);
    const { draft: resolvedDraft, baseline: resolvedBaseline } = applyConflictChoice(
      draft, oldBaseline, 'title', conflicts.title!, 'mine',
    );
    expect(Object.keys(detectConflicts(resolvedBaseline, resolvedDraft, serverDraft))).toEqual([]); // no longer conflicting
    expect(diffDraft(resolvedBaseline, resolvedDraft)).toEqual({ title: '我改的标题' }); // still sent — the overwrite
  });

  it('choosing 用服务器的 drops the edit — nothing left to save for that field', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'STALE-1', title: '原标题' }));
    const draft = { ...oldBaseline, title: '我改的标题' };
    const serverDraft = draftFromQuest(makeQuest({ id: 'STALE-1', title: '别人改的标题' }));
    const conflicts = detectConflicts(oldBaseline, draft, serverDraft);
    const { draft: resolvedDraft, baseline: resolvedBaseline } = applyConflictChoice(
      draft, oldBaseline, 'title', conflicts.title!, 'server',
    );
    expect(resolvedDraft.title).toBe('别人改的标题');
    expect(diffDraft(resolvedBaseline, resolvedDraft)).toEqual({}); // the edit is gone, nothing to send
  });

  it('collapse after a 409 keeps the banner: re-detecting conflicts against the same still-unresolved edit reproduces it, never silently clears', () => {
    // R3 from the review: a save got a 409 (the stale banner appeared); the owner then collapses and
    // reopens once the next snapshot lands. Re-running detectConflicts against the SAME oldBaseline (which
    // mergeConflictBaseline never moved for the conflicting field) reproduces the same conflict — proving a
    // plain collapse/reopen cannot silently drop it the way F-3 did.
    const oldBaseline = draftFromQuest(makeQuest({ id: 'HOLD-1', title: '我这边的标题' }));
    const draft = { ...oldBaseline, title: '我这边的标题（还没保存）' };
    const serverDraftAtFirstConflict = draftFromQuest(makeQuest({ id: 'HOLD-1', title: '第一次冲突时的标题' }));
    const firstConflicts = detectConflicts(oldBaseline, draft, serverDraftAtFirstConflict);
    expect(Object.keys(firstConflicts)).toEqual(['title']);
    const heldBaseline = mergeConflictBaseline(oldBaseline, serverDraftAtFirstConflict, firstConflicts);
    expect(heldBaseline.title).toBe(oldBaseline.title); // still the old anchor, not the server's newer value

    // A later snapshot arrives (collapse/reopen); detect again against the held baseline, not a re-baselined one.
    const serverDraftLater = draftFromQuest(makeQuest({ id: 'HOLD-1', title: '第一次冲突时的标题' }));
    const secondConflicts = detectConflicts(heldBaseline, draft, serverDraftLater);
    expect(Object.keys(secondConflicts)).toEqual(['title']); // still flagged — the banner must stay up
  });
});

// F-4 (round 2 review): applyServerSnapshot's caller (reopen vs. still-open) and the presence of leftover
// unsaved edits change which sentence is true — a single template got both wrong in two of these branches.
describe('snapshotToastMessage: the caller\'s context decides which clauses are true (F-4)', () => {
  it('reopen, with unsaved edits left: "在收起期间被更新了" plus the leftover-edits clause', () => {
    expect(snapshotToastMessage('STALE-1', ['需要你决定的事'], { wasCollapsed: true, hasUnsavedChanges: true }))
      .toBe('STALE-1 在收起期间被更新了（需要你决定的事），已经显示最新内容，你没保存的其他修改还留着');
  });

  it('reopen, no unsaved edits (C8): "在收起期间被更新了" without the leftover-edits clause', () => {
    expect(snapshotToastMessage('NOED-1', ['标题'], { wasCollapsed: true, hasUnsavedChanges: false }))
      .toBe('NOED-1 在收起期间被更新了（标题），已经显示最新内容');
  });

  it('open section, with unsaved edits left (C6): "刚刚被别人更新了" plus the leftover-edits clause', () => {
    expect(snapshotToastMessage('LIVE-1', ['需要你决定的事'], { wasCollapsed: false, hasUnsavedChanges: true }))
      .toBe('LIVE-1 刚刚被别人更新了（需要你决定的事），已经显示最新内容，你没保存的其他修改还留着');
  });

  it('open section, no unsaved edits: "刚刚被别人更新了" without the leftover-edits clause', () => {
    expect(snapshotToastMessage('LIVE-2', ['标题'], { wasCollapsed: false, hasUnsavedChanges: false }))
      .toBe('LIVE-2 刚刚被别人更新了（标题），已经显示最新内容');
  });

  it('joins several adopted fields with 、', () => {
    expect(snapshotToastMessage('DUP-1', ['标题', '需要你决定的事'], { wasCollapsed: true, hasUnsavedChanges: false }))
      .toBe('DUP-1 在收起期间被更新了（标题、需要你决定的事），已经显示最新内容');
  });
});

describe('rebaseDraft: reopening a collapsed section onto newer server data (R4)', () => {
  it('adopts every server value when the owner touched nothing', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', title: 'old' }));
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', title: 'server changed it' }));
    expect(rebaseDraft(oldBaseline, oldBaseline, serverDraft)).toEqual(serverDraft);
  });

  it('keeps the owner\'s edit for a field they touched, but adopts the server\'s newer value elsewhere', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', title: 'old', needsOwner: 'old question' }));
    const draft = { ...oldBaseline, title: 'owner is typing this' }; // touched only title
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', title: 'old', needsOwner: 'server updated this' }));
    const result = rebaseDraft(oldBaseline, draft, serverDraft);
    expect(result.title).toBe('owner is typing this'); // the owner's in-progress edit survives
    expect(result.needsOwner).toBe('server updated this'); // untouched field follows the server
  });

  it('keeps an owner-edited list field even when the server changed a different list field', () => {
    const oldBaseline = draftFromQuest(makeQuest({ id: 'A-1', parents: ['P-1'], conflicts: ['C-1'] }));
    const draft = { ...oldBaseline, parents: ['P-1', 'P-2'] }; // touched only parents
    const serverDraft = draftFromQuest(makeQuest({ id: 'A-1', parents: ['P-1'], conflicts: ['C-1', 'C-2'] }));
    const result = rebaseDraft(oldBaseline, draft, serverDraft);
    expect(result.parents).toEqual(['P-1', 'P-2']);
    expect(result.conflicts).toEqual(['C-1', 'C-2']);
  });
});
