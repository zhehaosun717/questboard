import type { EvidenceKind } from '../../api/types';
import type { Rung, RungState } from '../../lib/evidence';

const MARK: Record<RungState, string> = { done: '✓', pending: '…', skipped: '–', bad: '✗' };

// Feedback 15: short kind labels for the accepted rung's named evidence — the full label already lives in
// EvidenceSection.tsx's own KIND_LABEL, but a chip here has no reason to import that section's module.
const REF_KIND_LABEL: Record<EvidenceKind, string> = { report: '工作者报告', 'project-verification': '项目验证记录', hook: '验证钩子' };

// Who has said the work is done, at each level: the worker, a reviewer, whoever accepts it (the owner for
// art, the coordinator for code and tool work). Only the last rung closes it.
export function EvidenceLadder({ rungs }: { rungs: Rung[] }) {
  if (rungs.length === 0) return null;
  return (
    <ol className="evidence" aria-label="证据">
      {rungs.map((rung) => (
        <li key={rung.key} className={`evidence-rung evidence-${rung.state}`}>
          <span className="evidence-mark" aria-hidden="true">
            {MARK[rung.state]}
          </span>
          <div>
            <strong>{rung.label}</strong>
            <span className="evidence-note">{rung.note}</span>
            {rung.refs?.length ? (
              <ul className="evidence-accepted-refs">
                {rung.refs.map((ref, index) => (
                  <li key={`${ref.kind}:${index}`}>
                    {REF_KIND_LABEL[ref.kind]}
                    {ref.digest ? ` · ${ref.digest.slice(0, 8)}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
