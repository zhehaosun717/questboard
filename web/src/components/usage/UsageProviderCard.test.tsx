import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UsageProvider } from '../../api/types';
import { UsageProviderCard } from './UsageProviderCard';

// Renders the real UsageProviderCard.tsx (not a stand-in) so a wrong branch on the state machine — the kind
// of bug that would silently flash "not configured" during a pending read, or blank real numbers on a
// stale/refreshing card — is caught the same way a human looking at the page would catch it.

function provider(overrides: Partial<UsageProvider> = {}): UsageProvider {
  return {
    id: 'codex',
    name: 'OpenAI Codex',
    source: 'cli',
    ok: true,
    configured: true,
    windows: [],
    balances: [],
    plan: '',
    note: '',
    asOf: null,
    fetchedAt: '2026-09-15T00:00:00Z',
    ...overrides,
  };
}

function render(p: UsageProvider, extra: { refreshing?: boolean; cooldownMs?: number } = {}) {
  return renderToStaticMarkup(
    <UsageProviderCard
      provider={p}
      refreshing={extra.refreshing ?? false}
      cooldownMs={extra.cooldownMs ?? 0}
      onRefresh={() => {}}
    />,
  );
}

describe('UsageProviderCard', () => {
  it('shows real numbers for a fresh provider, including a true 0% distinct from unknown', () => {
    const html = render(
      provider({
        state: 'fresh',
        windows: [
          { label: '5h window', usedPercent: 0, resetsAt: null },
          { label: 'weekly', usedPercent: null, resetsAt: null },
        ],
      }),
    );
    expect(html).toContain('0%');
    expect(html).toContain('未知');
    expect(html).not.toContain('未接入');
  });

  it('does not call a pending provider "not configured", even though configured is false while pending', () => {
    // `error` is deliberately never rendered (see the next test) — this card must show only its own fixed
    // pending copy, never whatever free text a backend happened to attach.
    const html = render(provider({ state: 'pending', configured: false, error: '正在读取用量，稍后刷新可见' }));
    expect(html).toContain('正在读取用量数据，请稍候');
    expect(html).not.toContain('usage-error-tape');
    expect(html).not.toContain('未接入');
  });

  it('renders unconfigured neutrally, not as a warning tape, and never echoes the raw error field', () => {
    // `error` can carry whatever an old/misbehaving backend put there (sentinels, a stray Referer), so this
    // card must show only its own fixed text and must never include it.
    const html = render(provider({ state: 'unconfigured', configured: false, error: '没有找到 key：CODEX_API_KEY' }));
    expect(html).toContain('未接入 / 未配置');
    expect(html).not.toContain('没有找到 key');
    expect(html).not.toContain('usage-error-tape');
    expect(html).toContain('unconfigured');
  });

  it('renders an unavailable provider without a refresh button', () => {
    const html = render(provider({ state: 'unavailable', configured: false, error: '还没有可自动读取的来源' }));
    expect(html).not.toContain('usage-refresh-btn');
  });

  it('keeps stale numbers visible with a stale note, instead of blanking them', () => {
    const html = render(
      provider({
        state: 'stale',
        error: '缓存已过期，正在后台重新读取',
        lastSuccessAt: '2026-09-15T01:00:00Z',
        windows: [{ label: '5h window', usedPercent: 42, resetsAt: null }],
      }),
    );
    expect(html).toContain('42%');
    expect(html).toContain('数据可能已过期，正在尝试更新');
    expect(html).not.toContain('缓存已过期，正在后台重新读取');
    expect(html).toContain('上次成功');
  });

  it('shows a warning tape for a hard failure with no numbers, not a neutral block', () => {
    const html = render(provider({ state: 'failed', configured: true, ok: false, error: '读取失败（TimeoutError）' }));
    expect(html).toContain('usage-error-tape');
    expect(html).toContain('读取失败，请稍后重试');
    expect(html).not.toContain('TimeoutError');
  });

  it('shows only a recognized errorCode\'s own fixed text, never an unrecognized code or the raw error field', () => {
    const known = render(provider({ state: 'failed', ok: false, errorCode: 'rate_limited', error: 'raw upstream text' }));
    expect(known).toContain('请求过于频繁，请稍后再试');
    expect(known).not.toContain('raw upstream text');

    const unknown = render(provider({ state: 'failed', ok: false, errorCode: 'some_new_backend_code', error: 'raw upstream text' }));
    expect(unknown).not.toContain('some_new_backend_code');
    expect(unknown).not.toContain('raw upstream text');
    expect(unknown).toContain('读取失败，请稍后重试');
  });

  it('disables the refresh button while a cooldown remains', () => {
    const html = render(provider({ state: 'fresh' }), { cooldownMs: 8000 });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('冷却中 8s');
  });
});
