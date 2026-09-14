import { useState } from 'react';
import { api } from '../../api/client';
import type { Quest } from '../../api/types';
import { DrawerSection } from './DrawerSection';

interface ReviewSectionProps {
  quest: Quest;
  draft: string;
  onDraftChange: (text: string) => void;
  refresh: () => void;
  pushToast: (message: string) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Returned work sat under 等我处理 with nothing to press. Accepting marks the quest done. Sending it back
// returns it to the open column with the reason in the ruling record and the last detail, so the coordinator
// and whoever takes it next both see what was wrong.
export function ReviewSection({ quest, draft, onDraftChange, refresh, pushToast }: ReviewSectionProps) {
  const [busy, setBusy] = useState(false);

  const accept = async () => {
    if (!window.confirm(`${quest.id} 验收通过，标成已完成？`)) return;
    setBusy(true);
    try {
      const note = draft.trim();
      if (note) await api.rule(quest.id, `验收通过：${note}`);
      await api.setQuestStatus(quest.id, 'done', note ? `owner 验收通过：${note}` : 'owner 验收通过');
      onDraftChange('');
      pushToast(`${quest.id} 已验收`);
      refresh();
    } catch (err) {
      pushToast(`验收没成功：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const sendBack = async () => {
    const reason = draft.trim();
    if (!reason) {
      pushToast('打回要写明哪里不对，下一个接手的人要看');
      return;
    }
    if (!window.confirm(`把 ${quest.id} 打回悬赏中重做？`)) return;
    setBusy(true);
    try {
      await api.rule(quest.id, `打回重做：${reason}`);
      await api.setQuestStatus(quest.id, 'posted', `打回重做：${reason}`);
      onDraftChange('');
      pushToast(`${quest.id} 已打回，回到悬赏中`);
      refresh();
    } catch (err) {
      pushToast(`打回没成功：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DrawerSection en="SIGN-OFF" zh="验收">
      <p className="hint owner-task-hint">
        看完上面的交付回执：没问题就验收通过；要改就写明哪里不对再打回，委托会回到悬赏中重新派。
      </p>
      <textarea
        rows={3}
        placeholder="验收备注（可不写）；打回时必须写原因"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <div className="row end">
        <button className="btn danger" type="button" disabled={busy} onClick={sendBack}>
          打回重做
        </button>
        <button className="btn primary" type="button" disabled={busy} onClick={accept}>
          验收通过
        </button>
      </div>
    </DrawerSection>
  );
}
