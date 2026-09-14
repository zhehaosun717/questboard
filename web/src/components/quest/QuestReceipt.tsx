import type { Quest, Snapshot, Verification } from '../../api/types';
import { formatAgo, formatClock } from '../../lib/board';

interface QuestReceiptProps {
  quest: Quest;
  snap: Snapshot;
}

const CLAIMED = new Set<Quest['status']>(['delivered', 'reviewing', 'done']);

function ReceiptBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="receipt-block">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function ProjectTests({ verification }: { verification: Verification | null }) {
  if (!verification || (verification.steps.length === 0 && !verification.editXml && !verification.playXml)) {
    return <p className="receipt-none">没有记录</p>;
  }
  return (
    <div className="receipt-lines">
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

// What came back, told as what it is: the worker's own summary is not a check, the listed files are the ones
// the brief allowed (not a diff), and the test run belongs to the whole project. Decisions live in 下一步.
export function QuestReceipt({ quest, snap }: QuestReceiptProps) {
  const assignee = quest.assignee;
  const live = assignee ? snap.live[assignee.name] : undefined;
  const latestDispatch = quest.dispatches[quest.dispatches.length - 1];
  const hasDelivery = Boolean(quest.lastDetail) || quest.files.length > 0 || latestDispatch !== undefined;

  return (
    <div className="receipt" aria-label="交回的东西">
      <ReceiptBlock title="冒险者交回的东西">
        {hasDelivery ? (
          <div className="receipt-lines">
            {quest.lastDetail ? (
              <p>
                {CLAIMED.has(quest.status) ? '它自己的总结' : '最近记录'}：{quest.lastDetail}
              </p>
            ) : null}
            {quest.files.length > 0 ? <p>委托书允许改的文件：{quest.files.join('、')}</p> : null}
            {latestDispatch ? (
              <p>
                最近一次派出：{latestDispatch.model} · 接入方式 {latestDispatch.lane} · 编号 {latestDispatch.name} ·{' '}
                {formatClock(latestDispatch.at)}
              </p>
            ) : null}
            {live ? <p>现场：{live.state} · {formatAgo(live.elapsed)} · {live.edits} 处改动</p> : null}
          </div>
        ) : (
          <p className="receipt-none">还没有交回任何东西</p>
        )}
      </ReceiptBlock>

      <ReceiptBlock title="项目整体测试（整个项目最近一次，不是这个委托专属的）">
        <ProjectTests verification={snap.verification} />
      </ReceiptBlock>
    </div>
  );
}
