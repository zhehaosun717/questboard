import type { LanePackage } from '../../api/types';
import { formatClock } from '../../lib/board';
import { formatElapsed, formatHistoryEvent, laneLabel } from '../../lib/history';
import { useT } from '../../lib/i18n';

interface HistoryRowProps {
  pkg: LanePackage;
  isExpanded: boolean;
  onToggle: () => void;
}

export function HistoryRow({ pkg, isExpanded, onToggle }: HistoryRowProps) {
  const t = useT();
  const modelText =
    pkg.model === 'unknown' ? (
      <span className="muted">{t('historyRow.noModel')}</span>
    ) : (
      <span>
        {pkg.model}
        {pkg.variant ? `/${pkg.variant}` : ''}
      </span>
    );

  const modelSourceText = pkg.modelSource
    ? pkg.modelSource === 'inferred'
      ? t('historyRow.sourceInferred')
      : t('historyRow.sourceSession')
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
              <strong>{t('historyRow.fullOutput')}</strong>
              <pre>{pkg.lastText || t('historyRow.noOutput')}</pre>

              {pkg.tokens && (
                <div className="hist-meta-line">
                  {t('historyRow.tokens', { input: pkg.tokens.input, output: pkg.tokens.output })}
                </div>
              )}

              {pkg.toolCounts && Object.keys(pkg.toolCounts).length > 0 && (
                <div className="hist-meta-line">
                  {t('historyRow.tools', {
                    list: Object.entries(pkg.toolCounts)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(', '),
                  })}
                </div>
              )}

              {pkg.history && pkg.history.length > 0 && (
                <div className="hist-sub-history">
                  <strong>{t('historyRow.dispatchHistory')}</strong>
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
