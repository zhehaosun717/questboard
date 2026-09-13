import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { UsageReport } from '../api/types';
import { getCachedUsage, isFresh, setCachedUsage } from '../lib/usageCache';
import { UsageProviderCard } from './usage/UsageProviderCard';

function clockLabel(at: number): string {
  const date = new Date(at);
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export function UsageView() {
  // Start from whatever the last visit left behind, so coming back shows numbers instead of a spinner.
  const initial = getCachedUsage();
  const [report, setReport] = useState<UsageReport | null>(initial?.report ?? null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(initial?.at ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The old result stays on screen while this runs: a refresh must never blank the page.
  const load = useCallback(async (refresh: boolean) => {
    setRefreshing(true);
    try {
      const data = await api.usage(refresh);
      if (!mountedRef.current) return;
      const at = Date.now();
      setCachedUsage(data, at);
      setReport(data);
      setFetchedAt(at);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, []);

  const loadIfStale = useCallback(() => {
    const entry = getCachedUsage();
    if (!entry || !isFresh(entry.at, Date.now())) void load(false);
  }, [load]);

  useEffect(() => {
    loadIfStale();
  }, [loadIfStale]);

  useEffect(() => {
    // A hidden page does not need fresh quota; checking on wake covers the time it was away.
    const tick = () => {
      if (document.hidden) return;
      loadIfStale();
    };
    const interval = setInterval(tick, 60 * 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [loadIfStale]);

  const providers = report?.providers ?? [];

  return (
    <div className="usage-view-container">
      <header className="usage-view-header">
        <div>
          <span className="eyebrow">QUOTA &amp; BALANCES</span>
          <h2>服务商用量</h2>
        </div>
        <div className="usage-header-actions">
          {fetchedAt !== null ? (
            <span className="usage-timestamp">
              查询于 {clockLabel(fetchedAt)}
              {refreshing ? ' · 正在更新…' : ''}
            </span>
          ) : null}
          <button
            className="btn refresh-btn"
            type="button"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            {refreshing ? '正在读取…' : '刷新'}
          </button>
        </div>
      </header>

      {error ? (
        <div className="warn-tape usage-global-error">
          读取用量报告失败：{error}
          {report ? '（下面仍是上一次的结果）' : ''}
        </div>
      ) : null}

      {providers.length > 0 ? (
        <div className="usage-grid">
          {providers.map((provider) => (
            <UsageProviderCard key={provider.id} provider={provider} />
          ))}
        </div>
      ) : refreshing ? (
        <div className="hint usage-loading-hint">正在读取用量数据…</div>
      ) : (
        <div className="empty">暂无服务商用量数据</div>
      )}
    </div>
  );
}
