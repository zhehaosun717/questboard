import type { LanePackage } from '../../api/types';
import { formatClock } from '../../lib/board';
import { formatElapsed, formatHistoryEvent, laneLabel } from '../../lib/history';

interface HistoryRowProps {
  pkg: LanePackage;
  isExpanded: boolean;
  onToggle: () => void;
}

export function HistoryRow({ pkg, isExpanded, onToggle }: HistoryRowProps) {
  const modelText =
    pkg.model === 'unknown' ? (
      <span className="muted">未记录</span>
    ) : (
      <span>
        {pkg.model}
        {pkg.variant ? `/${pkg.variant}` : ''}
      </span>
    );

  const modelSourceText = pkg.modelSource
    ? pkg.modelSource === 'inferred'
      ? '（推断）'
      : '（从会话恢复）'
    : '';

  const stateClass =
    pkg.state === 'superseded' ? 'stale' : pkg.state.toLowerCase();

  return (
    <>
      <tr className="history-row" onClick={onToggle}>
        <td>
          <span className="pkg-id">{pkg.package}</span>
        </td>
        <td>{laneLabel(pkg.lane)}</td>
        <td>
          {modelText}
          {modelSourceText && (
            <span className="muted" style={{ fontSize: '10px' }}>
              {modelSourceText}
            </span>
          )}
        </td>
        <td>
          <span className={`state-badge ${stateClass}`}>{pkg.state}</span>
          {pkg.reason && (
            <span className="muted" style={{ fontSize: '11px', marginLeft: '5px' }}>
              {pkg.reason}
            </span>
          )}
        </td>
        <td className="mono">{formatElapsed(pkg.elapsed)}</td>
        <td className="mono">
          {pkg.edits}
          {pkg.editLabel && (
            <span className="muted" style={{ fontSize: '10px', marginLeft: '4px' }}>
              ({pkg.editLabel})
            </span>
          )}
        </td>
        <td className="last-text-cell" title={pkg.lastText}>
          {pkg.lastText ? pkg.lastText.slice(-80) : ''}
        </td>
        <td className="mono">{pkg.name || ''}</td>
      </tr>

      {isExpanded && (
        <tr className="history-detail-row">
          <td colSpan={8}>
            <div className="history-detail-pane">
              <strong>完整输出</strong>
              <pre>{pkg.lastText || '（无输出）'}</pre>

              {pkg.tokens && (
                <div className="hist-meta-line">
                  Tokens: 输入 {pkg.tokens.input} / 输出 {pkg.tokens.output}
                </div>
              )}

              {pkg.toolCounts && Object.keys(pkg.toolCounts).length > 0 && (
                <div className="hist-meta-line">
                  工具:{' '}
                  {Object.entries(pkg.toolCounts)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ')}
                </div>
              )}

              {pkg.history && pkg.history.length > 0 && (
                <div className="hist-sub-history">
                  <strong>派遣历史</strong>
                  <div className="hist-events-list">
                    {pkg.history.map((ev, i) => (
                      <div key={i} className="hist-event-item">
                        <span className="hist-ev-time">{formatClock(ev.at)}</span>
                        <span>{formatHistoryEvent(ev)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
