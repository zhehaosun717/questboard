// Settings › 本机 › 桌面通知: the per-browser switch for desktop notifications. Everything is driven by the
// notification center's state; this file only renders it and forwards clicks, so it can be server-rendered
// in tests (the connected wrapper is a thin useSyncExternalStore shell).
import { useEffect, useSyncExternalStore } from 'react';
import {
  getNotificationsServerSnapshot,
  getNotificationsState,
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENT_LABELS,
  refreshNotificationPermission,
  requestNotificationsPermission,
  setNotificationEventEnabled,
  setNotificationsEnabled,
  subscribeNotifications,
  type NotificationEventKey,
  type NotificationPermissionState,
  type NotificationsState,
} from '../../lib/notifications';
import '../../styles/notifications.css';

const PERMISSION_TEXT: Record<NotificationPermissionState, string> = {
  unsupported: '浏览器不支持',
  default: '未询问',
  granted: '已允许',
  denied: '已拒绝（在浏览器设置里改）',
};

export interface NotificationsSectionViewProps {
  state: NotificationsState;
  onRequestPermission: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onSetEventEnabled: (key: NotificationEventKey, enabled: boolean) => void;
}

export function NotificationsSectionView({
  state,
  onRequestPermission,
  onSetEnabled,
  onSetEventEnabled,
}: NotificationsSectionViewProps) {
  // The master switch and every event switch need the board to have named its project first — a preference
  // is stored per project, and without an id there is nowhere safe to keep the choice — and then a granted
  // browser permission. Until both hold they stay off and disabled, so nothing here can be mistaken for a
  // working setting.
  const waiting = !state.scope.loaded;
  const noProjectId = state.scope.loaded && state.scope.projectId === null;
  const allowed =
    state.permission === 'granted' && state.support !== 'unsupported' && !waiting && !noProjectId;
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">桌面通知 (Desktop Notifications)</h3>
      <div className="settings-card notifications-card">
        <p className="notifications-line">
          通知权限：
          <span className="notifications-permission">
            {PERMISSION_TEXT[state.permission]}
          </span>
        </p>
        {waiting ? <p className="muted">正在读取项目</p> : null}
        {state.permission === 'unsupported' ? (
          <p className="muted">这个浏览器没有桌面通知功能，看板上的提示还在，只是不会弹系统通知。</p>
        ) : null}
        {state.support === 'unsupported' ? (
          <p className="muted">此版本的看板不支持</p>
        ) : null}
        {noProjectId ? (
          <p className="muted">
            这个看板没有提供项目标识，没法按项目记住这台设备的通知设置，因此桌面通知暂时不能开启。
          </p>
        ) : null}
        {state.permission === 'default' ? (
          <div className="notifications-actions">
            <button type="button" className="btn" onClick={onRequestPermission}>
              开启通知
            </button>
          </div>
        ) : null}
        <label className="notifications-toggle">
          <input
            type="checkbox"
            checked={state.enabled}
            disabled={!allowed}
            onChange={(event) => onSetEnabled(event.target.checked)}
          />
          启用桌面通知
        </label>
        <div className="notifications-events">
          {NOTIFICATION_EVENT_KEYS.map((key) => (
            <label key={key} className="notifications-toggle">
              <input
                type="checkbox"
                checked={state.events[key]}
                disabled={!allowed}
                onChange={(event) => onSetEventEnabled(key, event.target.checked)}
              />
              {NOTIFICATION_EVENT_LABELS[key]}
            </label>
          ))}
        </div>
        <p className="muted">
          只对这台设备的这个浏览器生效；权限由浏览器控制，工程设置不能代替你开启。通知里只有任务编号、标题和状态，没有交付内容。
        </p>
      </div>
    </section>
  );
}

export function NotificationsSection() {
  const state = useSyncExternalStore(
    subscribeNotifications,
    getNotificationsState,
    getNotificationsServerSnapshot,
  );
  // The owner may allow or refuse notifications in the browser's own settings while this page is open; a
  // mount-time read keeps the section honest about that.
  useEffect(() => {
    refreshNotificationPermission();
  }, []);
  return (
    <NotificationsSectionView
      state={state}
      onRequestPermission={() => {
        void requestNotificationsPermission();
      }}
      onSetEnabled={setNotificationsEnabled}
      onSetEventEnabled={setNotificationEventEnabled}
    />
  );
}
