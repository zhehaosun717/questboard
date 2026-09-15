import type { Rung, RungState } from '../../lib/evidence';

const MARK: Record<RungState, string> = { done: '✓', pending: '…', skipped: '–', bad: '✗' };

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
          </div>
        </li>
      ))}
    </ol>
  );
}
