import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { AcceptanceEvidenceRef, EvidenceItem, EvidenceKind, Quest } from '../../api/types';
import '../../styles/report-evidence.css';

const KIND_LABEL: Record<EvidenceKind, string> = { report: '工作者报告', 'project-verification': '项目验证记录', hook: '验证钩子' };

type ItemsState = { status: 'loading' } | { status: 'ready'; items: EvidenceItem[] } | { status: 'error'; message: string };

interface AcceptancePanelProps {
  quest: Quest;
  // Called with the currently checked items' refs (never the raw checkbox state) whenever the selection or
  // the quest changes — ReviewSection reads this into the acceptance it sends on accept.
  onChange: (refs: AcceptanceEvidenceRef[]) => void;
}

// Feedback 15: the checkboxes an acceptance's evidenceRefs come from — this quest's current-attempt evidence
// (src/core/evidence.js), fetched on demand like EvidenceSection above it in the drawer (a second, independent
// fetch of the same detail route; the two sections do not share a cache). Unbound or missing items are shown
// but their checkbox is disabled and labelled with why: the server would refuse them anyway
// (src/core/acceptance.js), and a disabled control that explains itself beats one that silently ignores clicks.
export function AcceptancePanel({ quest, onChange }: AcceptancePanelProps) {
  const [state, setState] = useState<ItemsState>({ status: 'loading' });
  const [selected, setSelected] = useState<Set<EvidenceKind>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    setSelected(new Set());
    api.questDetail(quest.id)
      .then(({ quest: full }) => {
        if (cancelled) return;
        setState({ status: 'ready', items: full.evidence?.items ?? [] });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quest.id]);

  useEffect(() => {
    const items = state.status === 'ready' ? state.items : [];
    onChange(items.filter((item) => selected.has(item.kind)).map((item) => ({ kind: item.kind, ref: item.ref, digest: item.digest, attemptId: item.attemptId })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, selected]);

  const toggle = (item: EvidenceItem) => {
    if (!item.bound) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.kind)) next.delete(item.kind); else next.add(item.kind);
      return next;
    });
  };

  return (
    <div className="acceptance-panel">
      <p className="hint owner-task-hint">选择这次验收依据的证据（未绑定或缺失的不能选）：</p>
      {state.status === 'loading' ? <p className="receipt-none">证据读取中…</p> : null}
      {state.status === 'error' ? <p className="receipt-none">证据读取失败：{state.message}</p> : null}
      {state.status === 'ready' ? (
        <div className="acceptance-panel-items">
          {state.items.map((item) => (
            <label key={item.kind} className={`acceptance-panel-item${item.bound ? '' : ' acceptance-panel-item-disabled'}`}>
              <input type="checkbox" disabled={!item.bound} checked={selected.has(item.kind)} onChange={() => toggle(item)} />
              {KIND_LABEL[item.kind]}
              {!item.bound ? <span className="acceptance-panel-reason">（{item.reason ?? '还没绑定到本次尝试'}）</span> : null}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
