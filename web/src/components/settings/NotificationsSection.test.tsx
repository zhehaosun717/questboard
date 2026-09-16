// Server-rendered (renderToStaticMarkup) checks of the settings section: the exact Chinese wording of each
// permission state and which switches are usable. No jsdom in this repo; the live flow is covered by the
// browser check in the runbook.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_NOTIFICATION_PREFERENCE, type NotificationsState } from '../../lib/notifications';
import { NotificationsSection, NotificationsSectionView } from './NotificationsSection';

function state(overrides: Partial<NotificationsState> = {}): NotificationsState {
  return {
    permission: 'default',
    support: 'unknown',
    scope: { loaded: true, projectId: 'p' },
    enabled: false,
    events: { ...DEFAULT_NOTIFICATION_PREFERENCE.events },
    ...overrides,
  };
}

function render(overrides: Partial<NotificationsState> = {}): string {
  return renderToStaticMarkup(
    <NotificationsSectionView
      state={state(overrides)}
      onRequestPermission={() => {}}
      onSetEnabled={() => {}}
      onSetEventEnabled={() => {}}
    />,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('NotificationsSectionView', () => {
  it('offers the explicit button only while permission was never asked', () => {
    const html = render();
    expect(html).toContain('桌面通知');
    expect(html).toContain('未询问');
    expect(html).toContain('开启通知');
    expect(count(html, 'disabled')).toBe(6);
  });

  it('shows 已允许 and lets every switch work once granted', () => {
    const html = render({ permission: 'granted' });
    expect(html).toContain('已允许');
    expect(html).not.toContain('开启通知');
    expect(count(html, 'disabled')).toBe(0);
  });

  it('shows 已拒绝（在浏览器设置里改）with no way to re-ask', () => {
    const html = render({ permission: 'denied' });
    expect(html).toContain('已拒绝（在浏览器设置里改）');
    expect(html).not.toContain('开启通知');
    expect(count(html, 'disabled')).toBe(6);
  });

  it('says 浏览器不支持 when there is no Notification API', () => {
    const html = render({ permission: 'unsupported' });
    expect(html).toContain('浏览器不支持');
    expect(html).not.toContain('开启通知');
    expect(count(html, 'disabled')).toBe(6);
  });

  it('says 此版本的看板不支持 and keeps everything off for an old board', () => {
    const html = render({ permission: 'granted', support: 'unsupported' });
    expect(html).toContain('此版本的看板不支持');
    expect(count(html, 'disabled')).toBe(6);
  });

  it('labels the five event switches with the board words', () => {
    const html = render({ permission: 'granted' });
    for (const label of ['待验收', '失败', '限额退回', '失联', '等裁决']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('启用桌面通知');
  });

  it('reflects the stored choice in the checkboxes', () => {
    const html = render({
      permission: 'granted',
      enabled: true,
      events: { ...DEFAULT_NOTIFICATION_PREFERENCE.events, delivered: true },
    });
    expect(count(html, 'checked')).toBe(2);
  });

  it('states the scope honestly', () => {
    const html = render({ permission: 'granted' });
    expect(html).toContain('只对这台设备的这个浏览器生效');
    expect(html).toContain('通知里只有任务编号、标题和状态，没有交付内容');
  });

  it('waits for the first snapshot: 正在读取项目 and nothing the owner could flip', () => {
    const html = render({ permission: 'granted', scope: { loaded: false } });
    expect(html).toContain('正在读取项目');
    expect(count(html, 'disabled')).toBe(6);
  });

  it('says a board without a project id cannot keep the choice', () => {
    const html = render({ permission: 'granted', scope: { loaded: true, projectId: null } });
    expect(html).toContain('没法按项目记住这台设备的通知设置');
    expect(count(html, 'disabled')).toBe(6);
  });

  it('renders the connected section from the server snapshot', () => {
    const html = renderToStaticMarkup(<NotificationsSection />);
    expect(html).toContain('桌面通知');
    expect(html).toContain('未询问');
    // The server snapshot has no project yet, so the section starts in its waiting state.
    expect(html).toContain('正在读取项目');
    expect(count(html, 'disabled')).toBe(6);
  });
});
