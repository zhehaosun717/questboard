// Settings › 本机 › 桌面通知: the per-browser switch for desktop notifications. Everything is driven by the
// notification center's state; this file only renders it and forwards clicks, so it can be server-rendered
// in tests (the connected wrapper is a thin useSyncExternalStore shell).
import { useEffect, useSyncExternalStore } from 'react';
import {
  getNotificationsServerSnapshot,
  getNotificationsState,
  NOTIFICATION_EVENT_KEYS,
  refreshNotificationPermission,
  requestNotificationsPermission,
  setNotificationEventEnabled,
  setNotificationsEnabled,
  subscribeNotifications,
  type NotificationEventKey,
  type NotificationPermissionState,
  type NotificationsState,
} from '../../lib/notifications';
import { STATUS } from '../../lib/labels';
import { useT, type I18nKey } from '../../lib/i18n';
import '../../styles/notifications.css';

const PERMISSION_KEYS: Record<NotificationPermissionState, I18nKey> = {
  unsupported: 'notifications.permission.unsupported',
  default: 'notifications.permission.default',
  granted: 'notifications.permission.granted',
  denied: 'notifications.permission.denied',
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
  const t = useT();
  // The master switch and every event switch need the board to have named its project first — a preference
  // is stored per project, and without an id there is nowhere safe to keep the choice — and then a granted
  // browser permission. Until both hold they stay off and disabled, so nothing here can be mistaken for a
  // working setting. A disabled box must also not read as "on": the stored choice shows only while the
  // switch could actually run, and rendering never writes it back.
  const waiting = !state.scope.loaded;
  const noProjectId = state.scope.loaded && state.scope.projectId === null;
  const allowed =
    state.permission === 'granted' && state.support !== 'unsupported' && !waiting && !noProjectId;
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">{t('notifications.title')}</h3>
      <div className="settings-card notifications-card">
        <p className="notifications-line">
          {t('notifications.permissionLine')}
          <span className="notifications-permission">
            {t(PERMISSION_KEYS[state.permission])}
          </span>
        </p>
        {waiting ? <p className="muted">{t('notifications.readingProject')}</p> : null}
        {state.permission === 'unsupported' ? (
          <p className="muted">{t('notifications.unsupported')}</p>
        ) : null}
        {state.permission === 'denied' ? (
          <p className="muted">{t('notifications.deniedHelp')}</p>
        ) : null}
        {state.support === 'unsupported' ? (
          <p className="muted">{t('notifications.boardUnsupported')}</p>
        ) : null}
        {noProjectId ? (
          <p className="muted">{t('notifications.noProjectId')}</p>
        ) : null}
        {state.permission === 'default' ? (
          <>
            <p className="muted">{t('notifications.notAsked')}</p>
            <div className="notifications-actions">
              <button type="button" className="btn" onClick={onRequestPermission}>
                {t('notifications.request')}
              </button>
            </div>
          </>
        ) : null}
        <label className="notifications-toggle">
          <input
            type="checkbox"
            checked={allowed && state.enabled}
            disabled={!allowed}
            onChange={(event) => onSetEnabled(event.target.checked)}
          />
          {t('notifications.enable')}
        </label>
        <div className="notifications-events">
          {NOTIFICATION_EVENT_KEYS.map((key) => (
            <label key={key} className="notifications-toggle">
              <input
                type="checkbox"
                checked={allowed && state.events[key]}
                disabled={!allowed}
                onChange={(event) => onSetEventEnabled(key, event.target.checked)}
              />
              {STATUS[key]}
            </label>
          ))}
        </div>
        <p className="muted">{t('notifications.note')}</p>
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
