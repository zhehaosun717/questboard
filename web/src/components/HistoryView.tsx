import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { LanesReport } from '../api/types';
import { formatClock } from '../lib/board';
import { laneLabel, recentEvents, splitStale } from '../lib/history';
import { HistoryEvents } from './history/HistoryEvents';
import { HistoryRow } from './history/HistoryRow';

export function HistoryView() {
  const [report, setReport] = useState<LanesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [expandedPkg, setExpandedPkg] = useState<string | null>(null);
  const [showStale, setShowStale] = useState<boolean>(false);

  const fetchLanes = async () => {
    try {
      const data = await api.lanes();
      setReport(data);
      setError(null);
      const stamp = data.generatedAt
        ? new Date(data.generatedAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })
        : new Date().toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
      setLastUpdated(stamp);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    fetchLanes();
    const interval = setInterval(fetchLanes, 5000);
    return () => clearInterval(interval);
  }, []);

  const packages = report?.packages || [];
  const { active, stale } = splitStale(packages);
  const events = recentEvents(packages, 30);

  const openQuestions = report?.board?.openQuestions ?? 0;
  const laneLimitEntries = Object.entries(report?.laneLimits || {});
  const verification = report?.verification;

  const handleToggleRow = (pkgId: string) => {
    setExpandedPkg((curr) => (curr === pkgId ? null : pkgId));
  };

  return (
    <div className="history-tab-view">
      <header className="history-head">
        <div>
          <span className="eyebrow">DISPATCH LOG</span>
          <h2>派出记录</h2>
        </div>
        <div className="history-timestamp">
          {error ? (
            <span className="error-text">请求失败：{error}</span>
          ) : (
            <span>更新于 {lastUpdated || '加载中…'}</span>
          )}
        </div>
      </header>

      <div className="history-chips-strip">
        {openQuestions > 0 && (
          <span className="chip warn">
            <i className="led warn" />
            待答问题 {openQuestions}
          </span>
        )}

        {laneLimitEntries.map(([lane, lim]) => {
          const sinceTime = formatClock(lim.since);
          const untilStr = lim.until ? `，${lim.until} 恢复` : '';
          return (
            <span key={lane} className="chip warn">
              <i className="led warn" />
              {laneLabel(lane)} 限额中（{sinceTime} 起{untilStr}）
            </span>
          );
        })}

        {verification?.steps?.map((step, idx) => {
          if (step.kind === 'done') {
            return (
              <span key={idx} className="chip ok">
                <i className="led ok" />
                DONE
              </span>
            );
          }
          const pass = step.kind === 'exit' && step.value === '0';
          return (
            <span key={idx} className={`chip ${pass ? 'ok' : 'bad'}`}>
              <i className={`led ${pass ? 'ok' : 'bad'}`} />
              {step.name}:{step.value}
            </span>
          );
        })}

        {verification?.editXml && (
          <span className="chip">
            Edit {verification.editXml.passed}/{verification.editXml.total}
          </span>
        )}

        {verification?.playXml && (
          <span className="chip">
            Play {verification.playXml.passed}/{verification.playXml.total}
          </span>
        )}
      </div>

      <div className="history-table-container">
        <table className="history-table">
          <thead>
            <tr>
              <th>委托</th>
              <th>接入方式</th>
              <th>模型</th>
              <th>状态</th>
              <th>运行时长</th>
              <th>编辑次数</th>
              <th>最近一句话</th>
              <th>编号</th>
            </tr>
          </thead>
          <tbody>
            {packages.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty">
                  暂无派出记录
                </td>
              </tr>
            ) : (
              <>
                {active.map((p) => (
                  <HistoryRow
                    key={p.package}
                    pkg={p}
                    isExpanded={expandedPkg === p.package}
                    onToggle={() => handleToggleRow(p.package)}
                  />
                ))}

                {stale.length > 0 && (
                  <tr
                    className="stale-toggle-row"
                    onClick={() => setShowStale((prev) => !prev)}
                  >
                    <td colSpan={8}>
                      {showStale ? '▲' : '▼'} 三天前的记录 ({stale.length})
                    </td>
                  </tr>
                )}

                {showStale &&
                  stale.map((p) => (
                    <HistoryRow
                      key={p.package}
                      pkg={p}
                      isExpanded={expandedPkg === p.package}
                      onToggle={() => handleToggleRow(p.package)}
                    />
                  ))}
              </>
            )}
          </tbody>
        </table>
      </div>

      <HistoryEvents events={events} />
    </div>
  );
}
