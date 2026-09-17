import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Quest, UpstreamEvidenceKind, UpstreamEvidenceState, UpstreamParent, UpstreamReview } from '../../api/types';
import { formatClock } from '../../lib/board';
import { DrawerSection } from './DrawerSection';
import '../../styles/report-evidence.css';

const KIND_LABEL: Record<UpstreamEvidenceKind, string> = {
  report: '模型自报',
  'project-verification': '项目测试',
  hook: '验证钩子',
};

const STATE_LABEL: Record<UpstreamEvidenceState, string> = {
  passed: '通过',
  failed: '失败',
  stale: '未绑定到本次尝试',
  missing: '缺失',
  not_configured: '未配置',
  unknown: '未知',
};

// Exported for UpstreamEvidence.test.tsx: a pure row renderer, testable with real JSX/SSR without needing
// the on-demand fetch (which never resolves under this project's no-jsdom test setup) to settle first.
export function UpstreamParentRow({ parent }: { parent: UpstreamParent }) {
  return (
    <div className={`upstream-evidence-parent${parent.failing.length ? ' upstream-evidence-parent-failing' : ''}`}>
      <div className="upstream-evidence-parent-head">
        <strong>{parent.id}</strong>
        {parent.gap ? <span className="upstream-evidence-chip upstream-evidence-chip-gap">未经项目验证</span> : null}
      </div>
      <div className="upstream-evidence-kinds">
        {(Object.keys(KIND_LABEL) as UpstreamEvidenceKind[]).map((kind) => (
          <span
            key={kind}
            className={`upstream-evidence-chip upstream-evidence-${parent.states[kind]}${parent.failing.includes(kind) ? ' upstream-evidence-chip-failing' : ''}`}
          >
            {KIND_LABEL[kind]} {STATE_LABEL[parent.states[kind]]}
          </span>
        ))}
      </div>
    </div>
  );
}

interface UpstreamEvidenceProps {
  quest: Quest;
  projectId: string;
  // F3: a signature of the parents' current state (each parent's revision, read from the snapshot the
  // caller already holds), so the effect below refetches when a parent is re-dispatched or redelivered
  // while the drawer stays open — never a poll, since this only changes when the snapshot itself does.
  parentsKey?: string;
  refresh: () => void;
  pushToast: (message: string) => void;
}

type SectionState =
  | { status: 'loading' }
  | { status: 'ready'; review: UpstreamReview | null }
  | { status: 'error'; message: string };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// S3: the review-order warning/refusal (src/core/rules.js reviewUpstreamEvidence), shown on a review quest's
// own drawer regardless of which card (if any) is selected — the drop preview's warnings channel already
// covers the per-card moment, this is the standing record. Fetched on demand alongside EvidenceSection,
// never part of the snapshot fan-out; an older server that sends no `upstreamReview` field renders exactly
// as before this section existed.
export function UpstreamEvidence({ quest, projectId, parentsKey, refresh, pushToast }: UpstreamEvidenceProps) {
  const [state, setState] = useState<SectionState>({ status: 'loading' });
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (quest.kind !== 'review') return undefined;
    let cancelled = false;
    // R2-F2: keep showing the previous ready state while refetching — never drop back to the loading note —
    // so an unmount/remount of the chips and override form on every legitimate refetch doesn't also happen
    // here on the (now much rarer) occasions this effect actually re-runs.
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    api.questDetail(quest.id)
      .then(({ quest: full }) => {
        if (cancelled) return;
        setState({ status: 'ready', review: full.upstreamReview ?? null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: errorText(err) });
      });
    return () => {
      cancelled = true;
    };
    // R2-F2: quest.reviewOverride is a fresh object on every snapshot delivery even when nothing about it
    // actually changed, so depending on it directly refetched on every snapshot forever once an override
    // existed (about every 10s here, with no revision change in between). Depend on the primitive `at`
    // instead — the override's own identity in this project's terms — alongside the parents' own signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, quest.id, quest.kind, quest.reviewOverride?.at, parentsKey]);

  if (quest.kind !== 'review') return null;
  if (state.status === 'ready' && !state.review) return null;

  const recordOverride = async () => {
    const reason = overrideReason.trim();
    if (!reason) {
      pushToast('记录例外要写明原因');
      return;
    }
    setBusy(true);
    try {
      await api.reviewOverride(quest.id, reason);
      setOverrideReason('');
      pushToast(`${quest.id} 已记录审核例外`);
      refresh();
    } catch (err) {
      pushToast(`记录例外没成功：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DrawerSection en="UPSTREAM EVIDENCE" zh="上游证据">
      {state.status === 'loading' ? <p className="receipt-none">上游证据读取中…</p> : null}
      {state.status === 'error' ? <p className="receipt-none">上游证据读取失败：{state.message}</p> : null}
      {state.status === 'ready' && state.review ? (
        <div className="upstream-evidence">
          {state.review.parents.map((parent) => (
            <UpstreamParentRow key={parent.id} parent={parent} />
          ))}
          {state.review.blocked ? (
            <p className="upstream-evidence-refusal">
              这条审核委托要求 {state.review.required.map((k) => KIND_LABEL[k]).join('、')} 都通过，还没满足：
              {state.review.failingParents.join('、')}。除非记录一次例外，否则派不出去。
            </p>
          ) : null}
          {state.review.override ? (
            <p className={state.review.override.valid ? 'upstream-evidence-override' : 'upstream-evidence-override upstream-evidence-override-invalid'}>
              {state.review.override.valid
                ? `已记录例外（${state.review.override.by} · ${formatClock(state.review.override.at)}）：${state.review.override.reason}`
                : `记录过的例外已失效（上游有新的派遣，需要重新确认）：${state.review.override.reason}`}
            </p>
          ) : null}
          {state.review.blocked ? (
            <div className="upstream-evidence-override-form">
              <textarea
                rows={2}
                placeholder="记录例外的原因（必填）"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
              <div className="row end">
                <button className="btn" type="button" disabled={busy} onClick={() => void recordOverride()}>
                  记录例外并继续
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </DrawerSection>
  );
}
