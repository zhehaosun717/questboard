import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { Quest, QuestReportDetail, Snapshot, Verification } from '../../api/types';
import { REPORT_SOURCE_LABEL } from '../../lib/evidence';
import { formatAgo, formatClock } from '../../lib/board';
import { ReportPanel } from './ReportPanel';
import '../../styles/report-evidence.css';

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

function ReportReference({ report }: { report: NonNullable<Quest['report']> }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const copy = () => {
    const text = `${REPORT_SOURCE_LABEL[report.source]} ${report.ref} ${report.digest}`;
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <p className="report-ref">
      来源 {REPORT_SOURCE_LABEL[report.source]} · 路径 <code>{report.ref}</code> · 摘要 <code>{report.digest.slice(0, 12)}</code>
      <button type="button" className="btn report-ref-copy" onClick={copy}>
        {copied ? '已复制' : '复制'}
      </button>
    </p>
  );
}

type SummaryState =
  | { status: 'loading' }
  | { status: 'ready'; detail: QuestReportDetail | null }
  | { status: 'error'; message: string };

// The receipt's own report block (item 34): shown only once the snapshot's pruned `quest.report` says a
// report was actually captured for the current attempt — a legacy quest, one with no attempt, or one whose
// attempt left nothing readable simply has no `report`, and this returns null so the pre-existing receipt
// above is all that shows. The heading/paragraph summary lives only on the detail route (never the pruned
// snapshot), so it is fetched on demand, scoped to this project+quest mount; a late response after the quest
// or project has since changed is discarded (see the effect's `cancelled` guard) rather than painted over
// whatever is now shown.
function ReportSection({ quest, projectId }: { quest: Quest; projectId: string }) {
  const report = quest.report;
  const [state, setState] = useState<SummaryState>({ status: 'loading' });
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    setPanelOpen(false);
    if (!report) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    api.questDetail(quest.id)
      .then(({ quest: full }) => {
        if (cancelled) return;
        setState({ status: 'ready', detail: full.report });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, quest.id, report?.ref, report?.digest]);

  if (!report) return null;

  const summary = state.status === 'ready' ? state.detail?.summary : undefined;

  return (
    <ReceiptBlock title="最终报告">
      {state.status === 'loading' ? <p className="receipt-none">摘要读取中…</p> : null}
      {state.status === 'error' ? <p className="receipt-none">摘要读取失败：{state.message}</p> : null}
      {state.status === 'ready' ? (
        summary ? (
          <div className="receipt-lines">
            {summary.heading ? <p className="report-summary-heading">{summary.heading}</p> : null}
            {summary.paragraph ? <p>{summary.paragraph}</p> : <p className="receipt-none">没有可读的摘要段落</p>}
          </div>
        ) : (
          <p className="receipt-none">没有可读的摘要</p>
        )
      ) : null}
      <ReportReference report={report} />
      {report.truncated ? <p className="report-truncated-note">报告超过 2 MB，只显示了前面部分</p> : null}
      <div className="row report-actions">
        <button
          type="button"
          className="btn"
          aria-expanded={panelOpen}
          aria-controls={`report-panel-${quest.id}`}
          onClick={() => setPanelOpen((open) => !open)}
        >
          {panelOpen ? '收起完整报告' : '查看完整报告'}
        </button>
      </div>
      {panelOpen ? (
        <ReportPanel id={`report-panel-${quest.id}`} questId={quest.id} projectId={projectId} onClose={() => setPanelOpen(false)} />
      ) : null}
    </ReceiptBlock>
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
  // B1 (feedback 34, round 2): once a verified final report exists, `lastDetail` (a mid-content tail — see
  // sync.js tailText, which starts with "…" and cuts on no boundary for CJK text) must never stand in as
  // "the worker's own summary" above the real report. It is shown further down instead, relabelled as the
  // tail fragment it actually is.
  const hasReport = Boolean(quest.report);

  return (
    <div className="receipt" aria-label="交回的东西">
      <ReceiptBlock title="冒险者交回的东西">
        {hasDelivery ? (
          <div className="receipt-lines">
            {quest.lastDetail && !hasReport ? (
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

      <ReportSection key={`${snap.project.id ?? ''}:${quest.id}`} quest={quest} projectId={snap.project.id ?? ''} />

      {hasReport && quest.lastDetail ? (
        <ReceiptBlock title="最近记录（末尾片段）">
          <p className="receipt-none">{quest.lastDetail}</p>
        </ReceiptBlock>
      ) : null}

      <ReceiptBlock title="项目整体测试（整个项目最近一次，不是这个委托专属的）">
        <ProjectTests verification={snap.verification} />
      </ReceiptBlock>
    </div>
  );
}
