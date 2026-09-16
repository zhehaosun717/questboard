import { describe, expect, it } from 'vitest';
import type { Verdict } from '../api/types';
import { canOpenWorkOrder, dropEffectFor, dropVerdictInfo } from './graphDrop';

describe('dropVerdictInfo', () => {
  it('accepts an ok verdict as work, with a work hint', () => {
    const verdict: Verdict = { ok: true, reasons: [] };
    expect(dropVerdictInfo(verdict, true, false)).toEqual({ cls: 'drop-ok ok', message: '放下：派去做' });
  });

  it('keeps an unknown-capability warning separate from the accepted-drop hint', () => {
    const warning = '尚未确认这张卡支持 variant「high」，派遣会照常进行';
    expect(dropVerdictInfo({ ok: true, reasons: [], warnings: [{ code: 'variant_unconfirmed', message: warning }] }, true, false)).toEqual({
      cls: 'drop-ok ok',
      message: '放下：派去做',
      warning,
    });
    expect(canOpenWorkOrder({ ok: true, reasons: [], warnings: [{ code: 'variant_unconfirmed', message: warning }] })).toBe(true);
  });

  it('accepts an ok verdict as review with a review hint', () => {
    const verdict: Verdict = { ok: true, reasons: [] };
    expect(dropVerdictInfo(verdict, true, true)).toEqual({ cls: 'drop-ok ok', message: '放下：派去复核' });
  });

  it('reads a queue-only refusal on an open quest as queue, not refused', () => {
    const verdict: Verdict = { ok: false, reasons: [{ code: 'conflict_running', message: '文件冲突' }] };
    expect(dropVerdictInfo(verdict, true, false)).toEqual({ cls: 'drop-queue queue', message: '✗ 文件冲突' });
  });

  it('reads a queue-only reason as refused when the quest is not open', () => {
    const verdict: Verdict = { ok: false, reasons: [{ code: 'conflict_running', message: '文件冲突' }] };
    expect(dropVerdictInfo(verdict, false, false).cls).toBe('drop-no refused drop-refused');
  });

  it('shows the first reason and counts the rest', () => {
    const verdict: Verdict = {
      ok: false,
      reasons: [
        { code: 'a', message: '原因一' },
        { code: 'b', message: '原因二' },
      ],
    };
    expect(dropVerdictInfo(verdict, true, false)).toEqual({
      cls: 'drop-no refused drop-refused',
      message: '✗ 原因一（还有 1 条）',
    });
  });

  it('falls back to a fixed message when there is no verdict at all', () => {
    expect(dropVerdictInfo(undefined, true, false)).toEqual({
      cls: 'drop-no refused drop-refused',
      message: '✗ 没有记录',
    });
  });
});

describe('canOpenWorkOrder', () => {
  it('is true only for an ok verdict', () => {
    expect(canOpenWorkOrder({ ok: true, reasons: [] })).toBe(true);
    expect(canOpenWorkOrder({ ok: false, reasons: [] })).toBe(false);
    expect(canOpenWorkOrder(undefined)).toBe(false);
  });
});

describe('dropEffectFor', () => {
  it('is move over an accepted quest', () => {
    expect(dropEffectFor({ cls: 'drop-ok ok', message: '放下：派去做' })).toBe('move');
  });

  it('is no-drop over a refused or queue-only quest, so the cursor never lies about what a drop does', () => {
    expect(dropEffectFor({ cls: 'drop-no refused drop-refused', message: '✗ 没有记录' })).toBe('none');
    expect(dropEffectFor({ cls: 'drop-queue queue', message: '✗ 文件冲突' })).toBe('none');
  });

  it('is move with no quest under the pointer, since a drop there places the model instead of refusing', () => {
    expect(dropEffectFor(null)).toBe('move');
  });
});
