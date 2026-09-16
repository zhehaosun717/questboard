import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { EvidenceItem, Quest, QuestEvidence } from '../../api/types';
import { formatClock } from '../../lib/board';
import { DrawerSection } from './DrawerSection';
import '../../styles/report-evidence.css';

const KIND_LABEL: Record<EvidenceItem['kind'], string> = {
  report: '工作者报告',
  'project-verification': '项目验证记录',
  hook: '验证钩子',
};

const STATE_LABEL: Record<EvidenceItem['state'], string> = {
  passed: '通过',
  findings: '通过但有问题',
  failed: '失败',
  unknown: '未识别',
  missing: '缺失',
  not_configured: '未配置',
  queued: '排队中',
  running: '运行中',
  timedout: '超时',
};

interface EvidenceSectionProps {
  quest: Quest;
  projectId: string;
}

type SectionState =
  | { status: 'loading' }
  | { status: 'ready'; evidence: QuestEvidence | null }
  | { status: 'error'; message: string };

// Exported for EvidenceSection.test.tsx: a pure row renderer, testable with real JSX/SSR without needing the
// on-demand fetch (which never resolves under this project's no-jsdom test setup) to settle first.
export function EvidenceRow({ item }: { item: EvidenceItem }) {
  const [copied, setCopied] = useState(false);
  const reference = [item.source, item.ref, item.digest].filter((part): part is string => Boolean(part));
  const copy = () => {
    if (!reference.length) return;
    navigator.clipboard?.writeText(reference.join(' · ')).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <div className={`attempt-evidence-item attempt-evidence-${item.state}${item.bound ? '' : ' attempt-evidence-unbound'}`}>
      <div className="attempt-evidence-head">
        <strong>{KIND_LABEL[item.kind]}</strong>
        <span className="attempt-evidence-chip">{STATE_LABEL[item.state] ?? item.state}</span>
        {/* F6: missing/not_configured mean there is no record at all, not a wrong-version one — the chip
            (and its reason line below) already say why, so 未绑定到本次尝试 would only be noise here. */}
        {!item.bound && item.state !== 'missing' && item.state !== 'not_configured' ? (
          <span className="attempt-evidence-chip attempt-evidence-chip-unbound">未绑定到本次尝试</span>
        ) : null}
      </div>
      {reference.length ? (
        <p className="attempt-evidence-ref">
          {item.source ? (
            <>
              来源 {item.source}{' '}
            </>
          ) : null}
          {item.ref ? (
            <>
              · 路径 <code>{item.ref}</code>{' '}
            </>
          ) : null}
          {item.digest ? (
            <>
              · 摘要 <code>{item.digest.slice(0, 12)}</code>{' '}
            </>
          ) : null}
          <button type="button" className="btn attempt-evidence-copy" onClick={copy}>
            {copied ? '已复制' : '复制'}
          </button>
        </p>
      ) : null}
      {item.capturedAt ? <p className="attempt-evidence-time">记录时间：{formatClock(item.capturedAt)}</p> : null}
      {item.reason ? <p className="attempt-evidence-reason">{item.reason}</p> : null}
    </div>
  );
}

// The three attempt-bound evidence items (S2, src/core/evidence.js), fetched on demand from the detail route
// alongside the receipt's own report block — never part of the snapshot fan-out, never polled. This owns its
// own DrawerSection wrapper (like the EVIDENCE ladder above it): an older server that sends no `evidence`
// field at all renders exactly as before this section existed — no heading, nothing — once the fetch settles,
// not just an empty body under a visible heading. A late response after the quest or project changed is
// discarded rather than painted over the current one.
export function EvidenceSection({ quest, projectId }: EvidenceSectionProps) {
  const [state, setState] = useState<SectionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.questDetail(quest.id)
      .then(({ quest: full }) => {
        if (cancelled) return;
        setState({ status: 'ready', evidence: full.evidence ?? null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, quest.id]);

  if (state.status === 'ready' && !state.evidence) return null;

  return (
    <DrawerSection en="ATTEMPT EVIDENCE" zh="本次尝试的证据">
      {state.status === 'loading' ? <p className="receipt-none">证据读取中…</p> : null}
      {state.status === 'error' ? <p className="receipt-none">证据读取失败：{state.message}</p> : null}
      {state.status === 'ready' && state.evidence ? (
        <div className="attempt-evidence">
          <p className="attempt-evidence-attempt">
            {/* F6: the worker name (when the server sends it), not the bare attemptId UUID; an older server
                without attemptName still shows the id so the line is never blank for a real attempt. */}
            本次尝试：{state.evidence.attemptName ?? state.evidence.attemptId ?? '还没有派遣'}
            {state.evidence.attemptAt ? ` · ${formatClock(state.evidence.attemptAt)}` : ''}
          </p>
          {state.evidence.items.map((item) => (
            <EvidenceRow key={item.kind} item={item} />
          ))}
        </div>
      ) : null}
    </DrawerSection>
  );
}
