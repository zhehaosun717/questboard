import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { Quest, QuestReportDetail, Snapshot, Verification } from '../../api/types';
import { RAW_TAIL_LABEL, REPORT_SOURCE_LABEL } from '../../lib/evidence';
import { formatAgo, formatClock } from '../../lib/board';
import { t, useT } from '../../lib/i18n';
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

// M5: a copy failure (the clipboard API rejects, or is absent entirely — e.g. an insecure context) used to
// be silently ignored, leaving the button reading 复制 with nothing to show for the click. It now says so,
// the same short-lived way a success does, so the owner knows to copy the reference by hand instead of
// clicking 复制 again expecting a different result.
type CopyState = 'idle' | 'copied' | 'failed';

// Pulled out so the "no clipboard API at all" branch (an insecure context, or a very old browser) is
// unit-testable directly: `navigator.clipboard?.writeText(text)` alone silently evaluates to `undefined`
// there — no `.then` ever runs, so the click used to leave the button with nothing to show for it at all,
// not even the "failed" state below.
export function copyAttempt(clipboard: Pick<Clipboard, 'writeText'> | undefined, text: string): Promise<void> {
  return clipboard ? clipboard.writeText(text) : Promise.reject(new Error('clipboard API unavailable'));
}

function ReportReference({ report }: { report: NonNullable<Quest['report']> }) {
  const t = useT();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const copy = () => {
    const text = `${REPORT_SOURCE_LABEL[report.source]} ${report.ref} ${report.digest}`;
    copyAttempt(navigator.clipboard, text).then(
      () => {
        setCopyState('copied');
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopyState('idle'), 1500);
      },
      () => {
        setCopyState('failed');
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopyState('idle'), 3000);
      },
    );
  };
  return (
    <p className="report-ref">
      {t('evidenceSection.sourceLabel')} {REPORT_SOURCE_LABEL[report.source]} {t('evidenceSection.pathLabel')} <code>{report.ref}</code> {t('evidenceSection.digestLabel')} <code>{report.digest.slice(0, 12)}</code>
      <button type="button" className="btn report-ref-copy" onClick={copy}>
        {copyState === 'copied' ? t('questReceipt.copied') : t('questReceipt.copy')}
      </button>
      {copyState === 'failed' ? <span className="report-panel-error">{t('questReceipt.copyFailed')}</span> : null}
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
  const t = useT();
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
    <ReceiptBlock title={t('questReceipt.finalReportTitle')}>
      {state.status === 'loading' ? <p className="receipt-none">{t('questReceipt.summaryLoading')}</p> : null}
      {state.status === 'error' ? <p className="receipt-none">{t('questReceipt.summaryLoadFailed', { error: state.message })}</p> : null}
      {state.status === 'ready' ? (
        summary ? (
          <div className="receipt-lines">
            {summary.heading ? <p className="report-summary-heading">{summary.heading}</p> : null}
            {summary.paragraph ? <p>{summary.paragraph}</p> : <p className="receipt-none">{t('questReceipt.noParagraph')}</p>}
          </div>
        ) : (
          <p className="receipt-none">{t('questReceipt.noSummary')}</p>
        )
      ) : null}
      <ReportReference report={report} />
      {report.truncated ? <p className="report-truncated-note">{t('common.reportTruncated')}</p> : null}
      <div className="row report-actions">
        <button
          type="button"
          className="btn"
          aria-expanded={panelOpen}
          aria-controls={`report-panel-${quest.id}`}
          onClick={() => setPanelOpen((open) => !open)}
        >
          {panelOpen ? t('questReceipt.collapseReport') : t('questReceipt.viewReport')}
        </button>
      </div>
      {panelOpen ? (
        <ReportPanel id={`report-panel-${quest.id}`} questId={quest.id} projectId={projectId} onClose={() => setPanelOpen(false)} />
      ) : null}
    </ReceiptBlock>
  );
}

function ProjectTests({ verification }: { verification: Verification | null }) {
  const t = useT();
  if (!verification || (verification.steps.length === 0 && !verification.editXml && !verification.playXml)) {
    return <p className="receipt-none">{t('questReceipt.noRecord')}</p>;
  }
  return (
    <div className="receipt-lines">
      {verification.steps.map((step) => (
        <p key={`${step.kind}-${step.name}`}>
          {t('questReceipt.stepLine', { name: step.name, value: step.value })}
        </p>
      ))}
      {verification.editXml ? (
        <p>{t('questReceipt.editTests', { passed: verification.editXml.passed, total: verification.editXml.total, failed: verification.editXml.failed })}</p>
      ) : null}
      {verification.playXml ? (
        <p>{t('questReceipt.runTests', { passed: verification.playXml.passed, total: verification.playXml.total, failed: verification.playXml.failed })}</p>
      ) : null}
      <p className={verification.done ? 'receipt-done' : 'receipt-pending'}>
        {t('questReceipt.overallStatus', { status: verification.done ? t('status.done') : t('questReceipt.notDone') })}
      </p>
    </div>
  );
}

// What came back, told as what it is: the worker's own summary is not a check, the listed files are the ones
// the brief allowed (not a diff), and the test run belongs to the whole project. Decisions live in 下一步.
// Calls `t()` directly rather than `useT()`: QuestReceipt.test.tsx calls this component as a plain function
// (see reportSectionKey) to inspect the element tree without a DOM, which only works if this top-level call
// makes no hook calls of its own — `useSyncExternalStore` needs a real React render pass. The child sections
// below are always reached through an actual render (renderToStaticMarkup or the app), so they use `useT()`.
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
    <div className="receipt" aria-label={t('questReceipt.ariaLabel')}>
      <ReceiptBlock title={t('questReceipt.deliveredTitle')}>
        {hasDelivery ? (
          <div className="receipt-lines">
            {quest.lastDetail && !hasReport ? (
              <p>
                {CLAIMED.has(quest.status) ? t('questReceipt.ownSummary') : t('questReceipt.recentRecord')}{t('questReceipt.detailSeparator')}{quest.lastDetail}
              </p>
            ) : null}
            {quest.files.length > 0 ? <p>{t('questReceipt.allowedFiles', { files: quest.files.join(t('common.listSeparator')) })}</p> : null}
            {latestDispatch ? (
              <p>
                {t('questReceipt.lastDispatch', { model: latestDispatch.model, lane: latestDispatch.lane, name: latestDispatch.name, time: formatClock(latestDispatch.at) })}
              </p>
            ) : null}
            {live ? <p>{t('questReceipt.live', { state: live.state, ago: formatAgo(live.elapsed), edits: live.edits })}</p> : null}
          </div>
        ) : (
          <p className="receipt-none">{t('questReceipt.noDelivery')}</p>
        )}
      </ReceiptBlock>

      {/* N4/item 1: keyed on the report's own ref+digest too, not just project+quest — a same quest that
          gets a new dispatch attempt while its drawer stays open must remount ReportSection instead of
          reusing its state, so switching between two attempts' reports never shows a stale panel. */}
      <ReportSection
        key={`${snap.project.id ?? ''}:${quest.id}:${quest.report?.ref ?? ''}:${quest.report?.digest ?? ''}`}
        quest={quest}
        projectId={snap.project.id ?? ''}
      />

      {hasReport && quest.lastDetail ? (
        <ReceiptBlock title={RAW_TAIL_LABEL()}>
          <p className="receipt-none">{quest.lastDetail}</p>
        </ReceiptBlock>
      ) : null}

      <ReceiptBlock title={t('questReceipt.projectTestsTitle')}>
        <ProjectTests verification={snap.verification} />
      </ReceiptBlock>
    </div>
  );
}
