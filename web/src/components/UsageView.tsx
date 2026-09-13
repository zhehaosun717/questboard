import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { UsageReport } from '../api/types';
import { UsageProviderCard } from './usage/UsageProviderCard';

export function UsageView() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchUsage = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else if (!report) setLoading(true);

    try {
      const data = await api.usage(refresh);
      setReport(data);
      setError(null);
      const date = data.generatedAt ? new Date(data.generatedAt) : new Date();
      const h = String(date.getHours()).padStart(2, '0');
      const m = String(date.getMinutes()).padStart(2, '0');
      setLastUpdated(`${h}:${m}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchUsage(false);
    // Poll every 5 minutes (300,000 ms) while the tab stays open
    const interval = setInterval(() => {
      fetchUsage(false);
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleManualRefresh = () => {
    fetchUsage(true);
  };

  return (
    <div className="usage-view-container">
      <header className="usage-view-header">
        <div>
          <span className="eyebrow">QUOTA &amp; BALANCES</span>
          <h2>服务商用量</h2>
        </div>
        <div className="usage-header-actions">
          {lastUpdated ? (
            <span className="usage-timestamp">更新于 {lastUpdated}</span>
          ) : null}
          <button
            className="btn refresh-btn"
            type="button"
            disabled={refreshing}
            onClick={handleManualRefresh}
          >
            {refreshing ? '正在读取…' : '刷新'}
          </button>
        </div>
      </header>

      {error ? (
        <div className="warn-tape usage-global-error">
          读取用量报告失败：{error}
        </div>
      ) : null}

      {loading && !report ? (
        <div className="hint usage-loading-hint">正在读取用量数据…</div>
      ) : report?.providers && report.providers.length > 0 ? (
        <div className="usage-grid">
          {report.providers.map((provider) => (
            <UsageProviderCard key={provider.id} provider={provider} />
          ))}
        </div>
      ) : (
        <div className="empty">暂无服务商用量数据</div>
      )}
    </div>
  );
}
