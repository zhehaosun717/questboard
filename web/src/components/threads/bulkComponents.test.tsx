import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThreadBulkBar } from './ThreadBulkBar';
import { ThreadDetailPane } from './ThreadDetailPane';
import { TrashConfirmDialog } from './TrashConfirmDialog';
import { TRASH_EXPLANATION } from '../../api/threadBatch';
import type { ThreadWithTrash } from '../../api/threadBatch';
import type { ThreadDetail } from '../../api/types';

const thread = (id: string, title: string): ThreadWithTrash => ({
  id,
  title,
  tags: [],
  author: 'owner',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  pinned: false,
  closed: false,
  messageCount: 0,
  lastMessageAt: null,
});

const bar = (props: Partial<React.ComponentProps<typeof ThreadBulkBar>> = {}) =>
  renderToStaticMarkup(
    <ThreadBulkBar
      visibleCount={4}
      selectedCount={2}
      trashView={false}
      busy={false}
      status={null}
      onSelectVisible={() => {}}
      onClear={() => {}}
      onAction={() => {}}
      {...props}
    />,
  );

describe('ThreadBulkBar renders real controls', () => {
  it('offers every live-list action and the visible count', () => {
    const html = bar();
    for (const label of ['关闭', '重新打开', '置顶', '取消置顶', '删除', '选中可见', '清除']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('已选 2 / 可见 4');
    expect(html).toContain('aria-label="批量操作"');
    expect(html).not.toContain('还原');
  });

  it('disables every action while the selection is empty but keeps 选中可见 usable', () => {
    const html = bar({ selectedCount: 0 });
    // clear + close + reopen + pin + unpin + delete = 6 disabled; 选中可见 stays enabled to start a selection.
    expect((html.match(/disabled=""/g) || []).length).toBe(6);
    expect(html).toMatch(/<button[^>]*>\s*选中可见\s*<\/button>/);
  });

  it('shows only 还原所选 in the recycle view', () => {
    const html = bar({ trashView: true });
    expect(html).toContain('还原所选');
    expect(html).not.toContain('>删除<');
    expect(html).not.toContain('>关闭<');
  });

  it('announces a finished run through aria-live and keeps partial wording', () => {
    const html = bar({ status: '部分完成：1 个已关闭，1 个失败（t_b：thread not found）' });
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('部分完成');
  });

  it('marks the request cap when the selection reaches it', () => {
    const html = bar({ selectedCount: 100, visibleCount: 130 });
    expect(html).toContain('已达单次上限 100 个');
  });

  it('disables everything and names the in-flight run while busy', () => {
    const html = bar({ busy: true });
    // 选中可见 + 清除 + close/reopen/pin/unpin/删除 = 7; a busy bar is honest, never a silent no-op.
    expect((html.match(/disabled=""/g) || []).length).toBe(7);
    expect(html).toContain('批量操作处理中…');
    expect(html).toContain('role="status"');
  });
});

describe('TrashConfirmDialog confirms count, ids and semantics', () => {
  it('lists the exact threads and explains the recycle bin', () => {
    const html = renderToStaticMarkup(
      <TrashConfirmDialog
        selected={[thread('t_a1', '机器人 8'), thread('t_b2', 'leachate')]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('把这 2 个主题放入回收站');
    expect(html).toContain(TRASH_EXPLANATION);
    expect(html).toContain('t_a1');
    expect(html).toContain('机器人 8');
    expect(html).toContain('t_b2');
    expect(html).toContain('确认放入回收站（2 个）');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
  });

  it('summarises long selections instead of rendering a wall', () => {
    const many = Array.from({ length: 15 }, (_, i) => thread(`t_${i}`, `主题 ${i}`));
    const html = renderToStaticMarkup(
      <TrashConfirmDialog selected={many} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain('另有 5 个');
    expect(html).toContain('把这 15 个主题放入回收站');
  });
});

const detail = (overrides: Partial<ThreadDetail> = {}): ThreadDetail => ({
  id: 't_live',
  title: '回收站里的讨论',
  tags: ['question'],
  author: 'owner',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  pinned: false,
  closed: false,
  messageCount: 1,
  lastMessageAt: '2026-09-01T00:00:00.000Z',
  messages: [
    { id: 'm_1', threadId: 't_live', body: '第一条', author: 'owner', createdAt: '2026-09-01T00:00:00.000Z' },
  ],
  ...overrides,
});

describe('ThreadDetailPane shows the actual state of a bin thread', () => {
  const pane = (props: Partial<React.ComponentProps<typeof ThreadDetailPane>> = {}) =>
    renderToStaticMarkup(
      <ThreadDetailPane
        activeThread={detail()}
        activeError={null}
        author="owner"
        onAuthorChange={() => {}}
        replyBody=""
        onReplyBodyChange={() => {}}
        refusalMessage={null}
        replySubmitting={false}
        onTogglePin={() => {}}
        onToggleClose={() => {}}
        onSendReply={() => {}}
        {...props}
      />,
    );

  it('live thread: composer, no bin stamp, no restore button', () => {
    const html = pane();
    expect(html).toContain('发送回复');
    expect(html).not.toContain('在回收站中');
    expect(html).not.toContain('还原');
  });

  it('trashed thread: bin stamp, restore buttons, no composer', () => {
    const html = pane({ trashed: true, onRestoreFromTrash: () => {} });
    expect(html).toContain('在回收站中');
    expect(html).toContain('还原出回收站');
    expect(html).toContain('还原此主题');
    expect(html).not.toContain('发送回复');
  });

  it('restore waits for a running bulk action instead of racing it (F5)', () => {
    const html = pane({ trashed: true, onRestoreFromTrash: () => {}, restoreBusy: true });
    expect(html).toContain('disabled=""');
    expect((html.match(/disabled=""/g) || []).length).toBe(2);
  });

  it('R5-3: 置顶/关闭 disable together while a pane write is in flight', () => {
    const html = pane({ writeBusy: true });
    expect(html).toContain('发送回复');
    // 置顶 + 关闭 = 2 disabled (the reply send button has its own `replySubmitting` gate, unaffected here).
    expect((html.match(/disabled=""/g) || []).length).toBe(2);
  });

  it('closed trashed thread keeps both facts visible (restore must not imply reopen)', () => {
    const html = pane({
      trashed: true,
      onRestoreFromTrash: () => {},
      activeThread: detail({ closed: true }),
    });
    expect(html).toContain('在回收站中');
    expect(html).toContain('已关闭');
    expect(html).toContain('还原后保持原样继续');
  });
});
