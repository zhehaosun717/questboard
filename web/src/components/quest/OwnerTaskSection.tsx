import { useState } from 'react';
import { api } from '../../api/client';
import type { Quest } from '../../api/types';
import { DrawerSection } from './DrawerSection';

interface OwnerTaskSectionProps {
  quest: Quest;
  draft: string;
  onDraftChange: (text: string) => void;
  refresh: () => void;
  pushToast: (message: string) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// A 你来 quest is refused to every card, so the drawer used to offer nothing but 取消. The owner records the
// decision here (a ruling, which also closes the question threads) and marks the quest done.
export function OwnerTaskSection({ quest, draft, onDraftChange, refresh, pushToast }: OwnerTaskSectionProps) {
  const [busy, setBusy] = useState(false);
  const isOwnerQuest = quest.kind === 'owner';

  const record = async () => {
    const text = draft.trim();
    if (!text) {
      pushToast('先写下你的决定');
      return;
    }
    setBusy(true);
    try {
      await api.rule(quest.id, text);
      onDraftChange('');
      pushToast(`已记下 ${quest.id} 的决定`);
      refresh();
    } catch (err) {
      pushToast(`没记上：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!window.confirm(`把 ${quest.id} 标成已完成？`)) return;
    setBusy(true);
    try {
      const text = draft.trim();
      if (text) {
        await api.rule(quest.id, text);
        onDraftChange('');
      }
      await api.setQuestStatus(quest.id, 'done', 'owner 在任务板上标记完成');
      pushToast(`${quest.id} 已完成`);
      refresh();
    } catch (err) {
      pushToast(`没能标成完成：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DrawerSection en="YOUR CALL" zh={isOwnerQuest ? '你来做' : '等你裁决'}>
      {quest.needsOwner ? <div className="ask-box">{quest.needsOwner}</div> : null}
      {isOwnerQuest ? (
        <p className="hint owner-task-hint">
          这件事不派给模型。
          {quest.brief ? (
            <>
              要做什么写在 <code>{quest.brief}</code>。
            </>
          ) : null}
          {quest.rulings.length > 0 ? '你已经做过决定（见下面的裁决记录），没别的事就点做完了。' : '想好了写下来，做完点做完了。'}
        </p>
      ) : null}
      <textarea
        rows={3}
        placeholder={isOwnerQuest ? '写下决定或结果（会记进裁决记录，coordinator 会收到）' : '写下你的决定，coordinator 会收到'}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <div className="row end">
        <button
          className={isOwnerQuest ? 'btn' : 'btn primary'}
          type="button"
          disabled={busy}
          onClick={record}
        >
          {isOwnerQuest ? '记下决定' : '盖章裁决'}
        </button>
        {isOwnerQuest ? (
          <button className="btn primary" type="button" disabled={busy} onClick={finish}>
            做完了
          </button>
        ) : null}
      </div>
    </DrawerSection>
  );
}
