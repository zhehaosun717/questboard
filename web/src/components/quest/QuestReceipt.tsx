import type { Quest, Snapshot, Verification } from '../../api/types';
import { formatAgo, formatClock } from '../../lib/board';
import { getLatestRuling } from '../../lib/questState';

interface QuestReceiptProps {
  quest: Quest;
  snap: Snapshot;
}

function ReceiptBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="receipt-block">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function VerificationRecord({ verification }: { verification: Verification | null }) {
  if (!verification) return <p className="receipt-none">没有记录</p>;

  const hasCounts = verification.editXml !== null || verification.playXml !== null;
  if (verification.steps.length === 0 && !hasCounts) {
    return <p className="receipt-none">没有记录</p>;
  }

  return (
    <div className="receipt-lines">
      {/* snap.verification is the project's latest gate run, shared by every quest — say so. */}
      <p className="receipt-none">看板最近一次整体验证（不是专门针对这个委托的）：</p>
      {verification.steps.map((step) => (
        <p key={`${step.kind}-${step.name}`}>
          {step.name}：{step.value}
        </p>
      ))}
      {verification.editXml ? (
        <p>编辑测试：{verification.editXml.passed}/{verification.editXml.total} 通过，失败 {verification.editXml.failed}</p>
      ) : null}
      {verification.playXml ? (
        <p>运行测试：{verification.playXml.passed}/{verification.playXml.total} 通过，失败 {verification.playXml.failed}</p>
      ) : null}
      <p className={verification.done ? 'receipt-done' : 'receipt-pending'}>
        总状态：{verification.done ? '已完成' : '还没完成'}
      </p>
    </div>
  );
}

export function QuestReceipt({ quest, snap }: QuestReceiptProps) {
  const live = quest.assignee ? snap.live[quest.assignee.name] : undefined;
  const latestDispatch = quest.dispatches[quest.dispatches.length - 1];
  const latestRuling = getLatestRuling(quest);
  const hasDelivery = Boolean(quest.lastDetail) || quest.files.length > 0 || latestDispatch !== undefined;

  return (
    <div className="receipt" aria-label="交付回执">
      <ReceiptBlock title="交了什么">
        {hasDelivery ? (
          <div className="receipt-lines">
            {quest.lastDetail ? <p>结果：{quest.lastDetail}</p> : null}
            {quest.files.length > 0 ? <p>文件：{quest.files.join('、')}</p> : null}
            {latestDispatch ? (
              <p>
                最近派遣：{latestDispatch.model} · 通道 {latestDispatch.lane} · worker {latestDispatch.name} ·{' '}
                {formatClock(latestDispatch.at)}
              </p>
            ) : null}
            {live ? <p>现场：{live.state} · {formatAgo(live.elapsed)} · {live.edits} 改动</p> : null}
          </div>
        ) : (
          <p className="receipt-none">没有记录</p>
        )}
      </ReceiptBlock>

      <ReceiptBlock title="验证了什么">
        <VerificationRecord verification={snap.verification} />
      </ReceiptBlock>

      <ReceiptBlock title="还等你决定什么">
        {quest.needsOwner.trim() ? (
          <p className="receipt-pending">{quest.needsOwner}</p>
        ) : latestRuling ? (
          <div className="receipt-lines">
            <p className="receipt-none">没有待你决定的事项</p>
            <p>最近裁决：{latestRuling.text}</p>
          </div>
        ) : (
          <p className="receipt-none">没有记录</p>
        )}
      </ReceiptBlock>
    </div>
  );
}
