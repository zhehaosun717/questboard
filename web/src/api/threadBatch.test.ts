import { describe, expect, it } from 'vitest';
import {
  MAX_THREAD_BULK_IDS,
  MAX_THREAD_ID_LENGTH,
  THREAD_BULK_ACTIONS,
  UNKNOWN_ERROR_ZH,
  bulkErrorLabel,
  bulkThreads,
  bulkActionLabel,
  canActOnThread,
  describeBulkReport,
  describeFieldErrors,
  describeThreadError,
  isAtBulkCap,
  listThreads,
  pruneToVisible,
  selectAllVisible,
  toggleSelectedIds,
  validateBulkIds,
} from './threadBatch';
import type { ThreadWithTrash } from './threadBatch';

const thread = (id: string, extra: Partial<ThreadWithTrash> = {}): ThreadWithTrash => ({
  id,
  title: `主题 ${id}`,
  tags: [],
  author: 'owner',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  pinned: false,
  closed: false,
  messageCount: 0,
  lastMessageAt: null,
  ...extra,
});

describe('bulk id rules mirror the server', () => {
  it('refuses empty, oversize and duplicate arrays, passes clean ones', () => {
    expect(validateBulkIds([])).toMatch(/非空/);
    expect(validateBulkIds(['t_a', 't_a'])).toMatch(/重复/);
    expect(validateBulkIds([' '] as string[])).toMatch(/空/);
    expect(validateBulkIds(Array.from({ length: MAX_THREAD_BULK_IDS + 1 }, (_, i) => `t_${i}`))).toMatch(/100/);
    expect(validateBulkIds(['t_a', 't_b'])).toBeNull();
    expect(THREAD_BULK_ACTIONS).toEqual(['close', 'reopen', 'pin', 'unpin', 'trash', 'restore']);
  });

  it('refuses over-long ids outright — a bound is never a silent truncation (F6)', () => {
    expect(validateBulkIds(['x'.repeat(MAX_THREAD_ID_LENGTH + 1)])).toMatch(/128/);
    expect(validateBulkIds(['x'.repeat(MAX_THREAD_ID_LENGTH)])).toBeNull();
  });
});

describe('trashed threads only accept restore', () => {
  it('gates every action on the trash flag', () => {
    expect(canActOnThread('close', false)).toBe(true);
    expect(canActOnThread('trash', false)).toBe(true);
    expect(canActOnThread('restore', false)).toBe(false);
    expect(canActOnThread('restore', true)).toBe(true);
    expect(canActOnThread('trash', true)).toBe(false);
    expect(canActOnThread('pin', true)).toBe(false);
  });
});

describe('selection helpers keep the selection visible and bounded', () => {
  it('toggles one id without duplicates', () => {
    expect(toggleSelectedIds(['t_a'], 't_a')).toEqual([]);
    expect(toggleSelectedIds(['t_a'], 't_b')).toEqual(['t_a', 't_b']);
  });

  it('never lets a toggle push the selection past the request cap (F2)', () => {
    const full = Array.from({ length: MAX_THREAD_BULK_IDS }, (_, i) => `t_${i}`);
    expect(isAtBulkCap(full)).toBe(true);
    expect(isAtBulkCap(full.slice(0, 99))).toBe(false);
    const blocked = toggleSelectedIds(full, 't_extra');
    expect(blocked).toHaveLength(MAX_THREAD_BULK_IDS);
    expect(blocked).not.toContain('t_extra');
    // Deselecting always works, even at the cap — the owner can shrink back down.
    expect(toggleSelectedIds(full, 't_0')).toHaveLength(MAX_THREAD_BULK_IDS - 1);
  });

  it('selects visible threads up to the request cap only', () => {
    const many = Array.from({ length: MAX_THREAD_BULK_IDS + 20 }, (_, i) => thread(`t_${i}`));
    const picked = selectAllVisible(many, []);
    expect(picked).toHaveLength(MAX_THREAD_BULK_IDS);
    expect(selectAllVisible([thread('t_a'), thread('t_b')], ['t_a'])).toEqual(['t_a', 't_b']);
  });

  it('drops ids that the current filter no longer shows', () => {
    expect(pruneToVisible(['t_a', 't_b', 't_c'], ['t_a', 't_c'])).toEqual(['t_a', 't_c']);
    expect(pruneToVisible(['t_a'], [])).toEqual([]);
  });
});

describe('server refusals read as plain Chinese (F3)', () => {
  it('maps the known per-id and write errors', () => {
    expect(bulkErrorLabel('thread not found')).toBe('主题不存在（可能已被删除）');
    expect(bulkErrorLabel('thread is in the recycle bin; restore it first')).toContain('请先还原');
    expect(bulkErrorLabel('thread is not in the recycle bin')).toContain('无需还原');
    expect(bulkErrorLabel('thread is already in the recycle bin')).toContain('已经在回收站');
    expect(bulkErrorLabel('thread is closed')).toContain('已关闭');
  });

  it('maps the origin refusals and recognizes a bare HTTP status as the one other safe shape', () => {
    expect(bulkErrorLabel('origin http://evil.example refused')).toContain('只有本机的板页能写入');
    expect(bulkErrorLabel('cross-site request refused (cors)')).toContain('只有本机的板页能写入');
    expect(bulkErrorLabel('HTTP 500')).toBe('请求失败（HTTP 500）');
  });

  it('R5-5: never echoes an unrecognized server/network body verbatim — generic Chinese fallback only', () => {
    expect(bulkErrorLabel('some future english surprise')).toBe(UNKNOWN_ERROR_ZH);
    // P9c: a fake EACCES/path/token body must never reach the DOM as-is.
    const leak = 'EACCES open /srv/private/threads.jsonl token=abc123';
    const label = bulkErrorLabel(leak);
    expect(label).toBe(UNKNOWN_ERROR_ZH);
    expect(label).not.toContain('/srv/private');
    expect(label).not.toContain('token=abc123');
  });

  it('describeBulkReport shows the Chinese reason for a known failure', () => {
    const text = describeBulkReport({
      action: 'trash',
      changed: 1,
      failed: 1,
      results: [
        { id: 't_a', ok: true },
        { id: 't_b', ok: false, error: 'thread not found' },
      ],
    }, ['t_a', 't_b']);
    expect(text).toContain('部分完成');
    expect(text).toContain('t_b：主题不存在（可能已被删除）');
    expect(text).not.toContain('thread not found');
  });

  it('R5-5: describeBulkReport never echoes an unrecognized per-id failure verbatim', () => {
    const text = describeBulkReport({
      action: 'close',
      changed: 0,
      failed: 1,
      results: [{ id: 't_a', ok: false, error: 'brand new server error' }],
    }, ['t_a']);
    expect(text).not.toContain('brand new server error');
    expect(text).toContain(UNKNOWN_ERROR_ZH);
  });

  it('R13: a result id the client never sent is not named raw — only sent ids are echoed', () => {
    const text = describeBulkReport({
      action: 'pin',
      changed: 0,
      failed: 1,
      results: [{ id: 'srv-injected-id', ok: false, error: 'thread not found' }],
    }, ['t_a']);
    expect(text).not.toContain('srv-injected-id');
    expect(text).toContain('未知 id');
  });
});

describe('describeBulkReport keeps partial runs honest', () => {
  it('names a full success with the Chinese action word', () => {
    const text = describeBulkReport({
      action: 'close',
      changed: 2,
      failed: 0,
      results: [
        { id: 't_a', ok: true },
        { id: 't_b', ok: true },
      ],
    }, ['t_a', 't_b']);
    expect(text).toBe(`已${bulkActionLabel('close')} 2 个主题`);
  });

  it('lists failed ids with their reason when some ids did not change', () => {
    const text = describeBulkReport({
      action: 'trash',
      changed: 1,
      failed: 1,
      results: [
        { id: 't_a', ok: true },
        { id: 't_b', ok: false, error: 'thread not found' },
      ],
    }, ['t_a', 't_b']);
    expect(text).toContain('部分完成');
    expect(text).toContain('1 个失败');
    // F3: the known server string arrives in Chinese, not raw English.
    expect(text).toContain('t_b：主题不存在（可能已被删除）');
    expect(text).not.toContain('thread not found');
  });

  it('says nothing succeeded when every id failed', () => {
    const text = describeBulkReport({
      action: 'restore',
      changed: 0,
      failed: 1,
      results: [{ id: 't_a', ok: false, error: 'not in recycle bin' }],
    }, ['t_a']);
    expect(text).toContain('没有成功');
    expect(text).not.toContain('部分完成');
  });

  it('a non-numeric `changed` (a path/token string) is never rendered raw — the ok count stands in', () => {
    const leak = 'EACCES open /srv/private/threads.jsonl token=abc123';
    const text = describeBulkReport({
      action: 'pin',
      // @ts-expect-error — exactly the untrusted-server-value shape this guard exists for
      changed: leak,
      failed: 0,
      results: [
        { id: 't_a', ok: true },
        { id: 't_b', ok: true },
      ],
    }, ['t_a', 't_b']);
    expect(text).not.toContain(leak);
    expect(text).not.toContain('/srv/private');
    expect(text).not.toContain('token=abc123');
    expect(text).toBe(`已${bulkActionLabel('pin')} 2 个主题`);
  });

  it('an object-valued `changed` never reaches React/string concatenation raw — the ok count stands in', () => {
    const text = describeBulkReport({
      action: 'close',
      // @ts-expect-error — same untrusted shape, an object rather than a string
      changed: { code: 'X', max: 5 },
      failed: 1,
      results: [
        { id: 't_a', ok: true },
        { id: 't_b', ok: false, error: 'thread not found' },
      ],
    }, ['t_a', 't_b']);
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('1 个已' + bulkActionLabel('close'));
  });

  it('a negative or non-integer `changed` falls back to the ok count, never a raw negative/fraction', () => {
    const negative = describeBulkReport({
      action: 'trash',
      changed: -3,
      failed: 0,
      results: [{ id: 't_a', ok: true }],
    }, ['t_a']);
    expect(negative).toBe(`已${bulkActionLabel('trash')} 1 个主题`);

    const fraction = describeBulkReport({
      action: 'trash',
      changed: 1.5,
      failed: 0,
      results: [{ id: 't_a', ok: true }],
    }, ['t_a']);
    expect(fraction).toBe(`已${bulkActionLabel('trash')} 1 个主题`);

    const unsafe = describeBulkReport({
      action: 'trash',
      changed: Number.MAX_SAFE_INTEGER + 10,
      failed: 0,
      results: [{ id: 't_a', ok: true }],
    }, ['t_a']);
    expect(unsafe).toBe(`已${bulkActionLabel('trash')} 1 个主题`);
  });

  it('a genuine finite nonnegative integer `changed` is still shown as-is', () => {
    const text = describeBulkReport({
      action: 'unpin',
      changed: 5,
      failed: 0,
      results: [
        { id: 't_a', ok: true },
        { id: 't_b', ok: true },
        { id: 't_c', ok: true },
        { id: 't_d', ok: true },
        { id: 't_e', ok: true },
      ],
    }, ['t_a', 't_b', 't_c', 't_d', 't_e']);
    expect(text).toBe(`已${bulkActionLabel('unpin')} 5 个主题`);
  });
});

describe('validation failed maps to a fixed, actionable Chinese line', () => {
  it('bulkErrorLabel/describeThreadError map the exact server message, never the generic fallback', () => {
    expect(bulkErrorLabel('validation failed')).not.toBe(UNKNOWN_ERROR_ZH);
    expect(bulkErrorLabel('validation failed')).toBe('填写内容有误，请检查后重试');
  });

  it('describeThreadError maps a validation-failed rejection to the fixed line — shared by create/reply/bulk, so a reply refusal with no per-field detail of its own still says why', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'validation failed', fields: { body: 'body must be 20000 characters or fewer' } }), { status: 400 })) as typeof fetch;
    try {
      await bulkThreads('close', ['t_a']);
      throw new Error('expected bulkThreads to reject');
    } catch (err) {
      expect(describeThreadError(err)).toBe('填写内容有误，请检查后重试');
      expect(describeThreadError(err)).not.toBe(UNKNOWN_ERROR_ZH);
    }
  });
});

describe('describeFieldErrors (D3): NewThreadModal fields are untrusted runtime data', () => {
  it('maps the known server messages to fixed Chinese, per field', () => {
    expect(describeFieldErrors({ author: 'author is required' })).toEqual({ author: '请填写你的名字' });
    expect(describeFieldErrors({ title: 'title must be 120 characters or fewer' })).toEqual({
      title: '标题最多 120 个字符',
    });
    expect(describeFieldErrors({ body: 'body is required', tag: 'tag must use letters, numbers, underscores, or hyphens and be 40 characters or fewer' })).toEqual({
      body: '请填写第一条消息',
      tag: '标签只能使用字母、数字、下划线或连字符，最多 40 个字符',
    });
  });

  it('R11: an unrecognized string never reaches the DOM raw — a path/token body becomes the generic line', () => {
    const leak = 'EACCES open /srv/private/threads.jsonl token=abc123';
    const result = describeFieldErrors({ title: leak });
    expect(result.title).not.toContain('/srv/private');
    expect(result.title).not.toContain('token=abc123');
    expect(result.title).not.toBe(leak);
  });

  it('R11b: a non-string value (object/array) never reaches React as a child — generic fallback, no throw', () => {
    expect(() => describeFieldErrors({ title: { code: 'X', max: 5 } })).not.toThrow();
    const objResult = describeFieldErrors({ title: { code: 'X', max: 5 } });
    expect(typeof objResult.title).toBe('string');
    const arrResult = describeFieldErrors({ author: ['a', 'b'] });
    expect(typeof arrResult.author).toBe('string');
  });

  it('only reads the allowlisted field names — an unexpected key is ignored, not echoed', () => {
    const result = describeFieldErrors({ extra: 'ignored', author: 'author is required' });
    expect(Object.keys(result)).toEqual(['author']);
    expect(result).not.toHaveProperty('extra');
  });

  it('rejects a fields payload that is itself an array or not an object', () => {
    expect(describeFieldErrors(['author is required'])).toEqual({});
    expect(describeFieldErrors('author is required')).toEqual({});
    expect(describeFieldErrors(null)).toEqual({});
    expect(describeFieldErrors(undefined)).toEqual({});
  });
});

describe('requests use the real endpoints', () => {
  it('bulkThreads posts the exact server shape and refuses bad ids before any fetch', async () => {
    const sent: RequestInit[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(init as RequestInit);
      return new Response(JSON.stringify({ action: 'close', changed: 1, failed: 0, results: [{ id: 't_a', ok: true }] }), { status: 200 });
    }) as typeof fetch;
    const report = await bulkThreads('close', ['t_a']);
    expect(report.changed).toBe(1);
    expect(JSON.parse(String(sent[0]?.body))).toEqual({ action: 'close', ids: ['t_a'] });
    expect((sent[0]?.headers as Record<string, string>)['content-type']).toBe('application/json');
    await expect(bulkThreads('close', [])).rejects.toThrow(/非空/);
    await expect(bulkThreads('close', ['t_a', 't_a'])).rejects.toThrow(/重复/);
  });

  it('D2: bulkThreads throws the raw server text exactly once — translation is describeThreadError\'s job', async () => {
    // Before D2, `request()` pre-translated this via `bulkErrorLabel` before throwing, so
    // `describeThreadError`'s own `bulkErrorLabel` call downstream ran on already-Chinese text, matched
    // nothing in `SERVER_ERROR_ZH`, and fell through to the generic fallback even for known refusals
    // (revision6's regression). `bulkThreads`/`listThreads` now match client.ts's `call()`: throw raw.
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'cross-site request refused (cors)' }), { status: 403 })) as typeof fetch;
    await expect(bulkThreads('pin', ['t_a'])).rejects.toThrow('cross-site request refused (cors)');
  });

  it('D2: describeThreadError maps a raw bulkThreads/listThreads rejection exactly once', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'thread not found' }), { status: 404 })) as typeof fetch;
    try {
      await bulkThreads('pin', ['t_a']);
      throw new Error('expected bulkThreads to reject');
    } catch (err) {
      expect(describeThreadError(err)).toBe('主题不存在（可能已被删除）');
    }
  });

  it('R5-5: an unrecognized server refusal still never reaches the DOM verbatim — via describeThreadError', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'action must be one of close, reopen, pin, unpin, trash, restore' }), { status: 400 })) as typeof fetch;
    try {
      await bulkThreads('purge' as never, ['t_a']);
      throw new Error('expected bulkThreads to reject');
    } catch (err) {
      expect(describeThreadError(err)).toBe(UNKNOWN_ERROR_ZH);
    }
  });

  it('a bodyless failure still throws the client-synthesized bare HTTP status, mapped once downstream', async () => {
    globalThis.fetch = (async () => new Response('', { status: 502 })) as typeof fetch;
    await expect(bulkThreads('pin', ['t_a'])).rejects.toThrow('HTTP 502');
  });

  it('listThreads adds trash=only only for the recycle view', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ threads: [] }), { status: 200 });
    }) as typeof fetch;
    await listThreads({ status: 'open' });
    await listThreads({ status: 'all', q: '  测试  ', trash: true });
    expect(urls[0]).toBe('/api/threads?status=open');
    expect(urls[1]).toContain('status=all');
    expect(urls[1]).toContain('q=%E6%B5%8B%E8%AF%95');
    expect(urls[1]).toContain('trash=only');
  });
});
