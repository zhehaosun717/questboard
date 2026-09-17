import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../../api/client';
import type { Card, RosterBulkResult } from '../../api/types';
import {
  BulkActions,
  bulkSelectionToken,
  formatBulkApplyToast,
  formatBulkError,
  formatBulkResultBreakdown,
  formatBulkResultItem,
  formatBulkResultTitle,
  invalidateBulkOperationForIdentityChange,
  isBulkOperationCurrent,
  splitDeniedActiveCards,
} from './BulkActions';

function card(id: string, name = id, over: Partial<Card> = {}): Card {
  return {
    id,
    name,
    provider: 'synthetic',
    lane: 'code',
    model: `model-${id}`,
    family: 'family',
    status: 'available',
    statusSince: null,
    statusReason: '',
    statusSetBy: null,
    ...over,
  };
}

function render(matchingCards: Card[], selectedIds: string[], visibleCards = matchingCards) {
  return renderToStaticMarkup(
    <BulkActions
      matchingCards={matchingCards}
      visibleCards={visibleCards}
      selectedIds={selectedIds}
      onToggle={() => {}}
      onSelectPage={() => {}}
      onSelectAllMatching={() => {}}
      onClear={() => {}}
      refresh={() => {}}
      pushToast={() => {}}
      sourceToken="synthetic-source"
    />,
  );
}

describe('BulkActions', () => {
  it('keeps a quota-derived card selectable and exposes its direct checkbox', () => {
    const html = render([card('quota', 'Quota', { derived: { from: 'lanes', reason: '额度限额中', at: null, resetsAt: null } })], ['quota']);
    expect(html).toContain('aria-label="选择 Quota"');
    expect(html).toContain('checked=""');
    expect(html).toContain('选择全部匹配（1）');
  });

  it('distinguishes visible rows from all matching cards and explains folded exclusions', () => {
    const html = render([card('one', 'One'), card('folded', 'Folded')], [], [card('one', 'One')]);
    expect(html).toContain('选择可见的（1）');
    expect(html).toContain('选择全部匹配（2）');
    expect(html).toContain('1 张匹配卡片在折叠组内');
    expect(html).toContain('aria-label="选择 Folded"');
  });

  it('keeps hidden selections explicit and offers preview, apply, result and delete-confirm controls', () => {
    const html = render([card('one', 'One')], ['one', 'hidden-card']);
    expect(html).toContain('有 1 张已选卡片被当前筛选隐藏');
    expect(html).toContain('hidden-card');
    expect(html).toContain('预览批量修改');
    expect(html).toContain('删除所选');
    expect(html).toContain('清空选择');
  });

  it('changes the async identity when the source changes or selection is cleared', () => {
    expect(bulkSelectionToken('project-a', ['one'])).not.toBe(bulkSelectionToken('project-b', ['one']));
    expect(bulkSelectionToken('project-a', ['one'])).not.toBe(bulkSelectionToken('project-a', []));
  });

  it('invalidates only transient dialogs while retaining a completed server receipt', () => {
    const result = { ok: true, applied: true, action: 'update' as const, actor: 'owner', ids: ['one'], revision: '4', fingerprint: 'f', changedFields: ['status'], preservedFields: [], deniedActiveCards: [], statusNote: '', results: [], counts: { requested: 1, ready: 1, changed: 1, unchanged: 0, denied: 0, failed: 0, partial: 0 } };
    const next = invalidateBulkOperationForIdentityChange({
      busy: true,
      preview: result,
      pendingRequest: { ids: ['one'], patch: { status: 'available' } },
      result,
      operationToken: { sourceToken: 'old', selectionKey: 'old-selection' },
      deleteConfirm: true,
      error: 'old error',
      staleRefused: true,
    });
    expect(next).toMatchObject({ busy: false, preview: null, pendingRequest: null, result, operationToken: null, deleteConfirm: false, error: null, staleRefused: false });
  });

  it('rejects a late continuation after source, selection, unmount or sequence changes', () => {
    const token = { sourceToken: 'project-a', selectionKey: 'project-a\u0000["one"]' };
    const current = { mounted: true, sourceToken: token.sourceToken, selectionKey: token.selectionKey, sequence: 7 };
    expect(isBulkOperationCurrent(token, current, 7)).toBe(true);
    expect(isBulkOperationCurrent(token, { ...current, sourceToken: 'project-b' }, 7)).toBe(false);
    expect(isBulkOperationCurrent(token, { ...current, selectionKey: 'project-a\u0000[]' }, 7)).toBe(false);
    expect(isBulkOperationCurrent(token, { ...current, mounted: false }, 7)).toBe(false);
    expect(isBulkOperationCurrent(token, current, 8)).toBe(false);
  });

  it('shows the server refusal reason without exposing the raw stale marker', () => {
    const message = formatBulkError(new ApiError('stale', [{ code: 'stale_revision', message: '名册已经变化，请重新预览。' }]));
    expect(message).toContain('名册已经变化');
    expect(message.toLowerCase()).not.toContain('stale');
  });

  it('reports partial fields and does not turn a partial write into success', () => {
    const partial: RosterBulkResult = {
      id: 'one',
      ok: false,
      ready: true,
      denied: false,
      changedFields: [],
      preservedFields: [],
      partial: true,
      appliedFields: ['env'],
      error: '状态记录失败',
    };
    const message = formatBulkResultItem(partial);
    expect(message).toContain('部分写入');
    expect(message).toContain('env');
    expect(message).toContain('状态记录失败');
  });

  it('puts every apply count in the owner toast, including partial writes, in one count wording', () => {
    const message = formatBulkApplyToast({
      counts: { requested: 6, ready: 6, changed: 4, unchanged: 0, denied: 1, failed: 1, partial: 1 },
    });
    expect(message).toContain('4 张改了');
    expect(message).toContain('0 张没变');
    expect(message).toContain('1 张被拒绝');
    expect(message).toContain('1 张失败');
    expect(message).toContain('1 张部分完成');
  });

  // F1: the result dialog's breakdown paragraph must use the same "{n} 张…" wording as the title and the
  // toast, and must not repeat the title's "批量操作结束" prefix.
  it('shows the full count breakdown under the result title without repeating its prefix', () => {
    const breakdown = formatBulkResultBreakdown({
      counts: { requested: 6, ready: 6, changed: 4, unchanged: 0, denied: 1, failed: 1, partial: 1 },
    });
    expect(breakdown).not.toContain('批量操作结束');
    expect(breakdown).toContain('4 张改了');
    expect(breakdown).toContain('0 张没变');
    expect(breakdown).toContain('1 张被拒绝');
    expect(breakdown).toContain('1 张失败');
    expect(breakdown).toContain('1 张部分完成');
  });

  // X8: a quota-evidence refusal must not be shown under the "还在进行或结果未定" heading, and the result
  // dialog's own title must say how many changed and how many were refused instead of a bare "done".
  it('separates quota-evidence refusals from active/undetermined refusals', () => {
    const deniedActiveCards = [
      { id: 'quota-card', reasons: [{ code: 'quota_evidence', message: '卡片 quota-card 当前仍有具体的限额证据' }] },
      { id: 'active-card', reasons: [{ code: 'holds_slot', message: '不能批量修改 active-card：还有 worker 在用这张卡' }] },
      { id: 'unresolved-card', reasons: [{ code: 'unresolved_attempt', message: '结果还没确定，先手动确认' }] },
    ];
    const { quota, active } = splitDeniedActiveCards(deniedActiveCards);
    expect(quota.map((item) => item.id)).toEqual(['quota-card']);
    expect(active.map((item) => item.id)).toEqual(['active-card', 'unresolved-card']);
  });

  it('never claims the result is done when every card was refused, and names both counts', () => {
    const allRefused = formatBulkResultTitle({
      counts: { requested: 3, ready: 0, changed: 0, unchanged: 0, denied: 3, failed: 0, partial: 0 },
    });
    expect(allRefused).not.toContain('完成');
    expect(allRefused).toContain('0');
    expect(allRefused).toContain('3');

    const mixed = formatBulkResultTitle({
      counts: { requested: 5, ready: 4, changed: 4, unchanged: 0, denied: 1, failed: 0, partial: 0 },
    });
    expect(mixed).toContain('4');
    expect(mixed).toContain('1');
  });
});
