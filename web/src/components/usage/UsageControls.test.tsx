import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsageControls } from './UsageControls';

function render(overrides: Partial<Parameters<typeof UsageControls>[0]> = {}) {
  return renderToStaticMarkup(
    <UsageControls
      fetchedAt={null}
      refreshingAll={false}
      cooldownMs={0}
      onRefreshAll={() => {}}
      mode="manual"
      intervalMs={60000}
      onModeChange={() => {}}
      onIntervalChange={() => {}}
      paused={false}
      {...overrides}
    />,
  );
}

describe('UsageControls', () => {
  it('announces manual mode when not on an interval', () => {
    expect(render({ mode: 'manual' })).toContain('仅手动刷新');
  });

  it('announces the chosen interval and offers the interval picker only in interval mode', () => {
    const html = render({ mode: 'interval', intervalMs: 5 * 60 * 1000 });
    expect(html).toContain('每 5 分钟 自动刷新一次');
    expect(html).toContain('usage-mode-select');
  });

  it('announces the auto-refresh pause when the page is hidden', () => {
    expect(render({ mode: 'interval', paused: true })).toContain('自动刷新已暂停');
  });

  it('disables refresh-all during cooldown and shows the countdown', () => {
    // aria-disabled, not the native `disabled` attribute — a truly-disabled button loses keyboard focus to
    // <body> the moment it is activated, which would drop focus mid-cooldown right after the owner pressed
    // Enter on it.
    const html = render({ cooldownMs: 4200 });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('冷却中 5s');
  });

  it('shows the query timestamp only once one exists', () => {
    expect(render({ fetchedAt: null })).not.toContain('usage-timestamp');
    const at = new Date(2026, 8, 15, 8, 30).getTime();
    expect(render({ fetchedAt: at })).toContain('08:30');
  });
});
