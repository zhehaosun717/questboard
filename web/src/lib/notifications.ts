// Opt-in desktop notifications for board events: one small center, no framework and no browser globals at
// import time, so it can be unit-tested in node with injected fakes.
//
// In the app it is fed by useBoard's single subscription rather than opening an EventSource of its own — two
// streams would deliver every frame twice and race the board's own reconnect handling.
//
// Rules, in the order ingest applies them:
//   1. An event without a positive integer seq comes from an older board; notifications stay off and the
//      settings section says so (此版本的看板不支持).
//   2. Until the board's first snapshot names the project, the scope is unknown and nothing runs: no
//      preference is read or written (a choice has no project to belong to without an id), no floor is
//      scanned, no notification fires. The settings section shows 正在读取项目 with disabled switches.
//   3. Everything at or below the seq floor the page established on load is history, not news, so opening
//      the board never floods the desktop. The floor is found by reading /api/events to its end once the page
//      is switched on and allowed — the same cursor the history page uses.
//   4. A frame at or below the highest seq already handled is a repeat (a reconnect can resend frames) and
//      is dropped. The floor above and this dedup are the same comparison, because seq only ever goes up.
//   5. While the preference is off or the browser has not granted permission, nothing is shown — and no
//      history request is made either.
// A notification carries the quest id, its title and the status word only — never detail or report text.
import type { Quest, QuestEvent, Snapshot } from '../api/types';
import { fetchEventsPage } from '../api/historyEvents';
import { STATUS } from './labels';

export type NotificationEventKey = 'delivered' | 'failed' | 'bounced' | 'stalled' | 'needs_owner';

export const NOTIFICATION_EVENT_KEYS: readonly NotificationEventKey[] = [
  'delivered',
  'failed',
  'bounced',
  'stalled',
  'needs_owner',
];

// The status words the board already uses, so a notification reads like the rest of the page.
export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventKey, string> = {
  delivered: STATUS.delivered,
  failed: STATUS.failed,
  bounced: STATUS.bounced,
  stalled: STATUS.stalled,
  needs_owner: STATUS.needs_owner,
};

// Which board events map to which switch. delivered/failed/bounced are exit files, stalled is the silence
// alarm, and needs_owner only ever arrives as a status change.
export function notificationEventKey(event: string): NotificationEventKey | null {
  if (event === 'status_needs_owner') return 'needs_owner';
  if (event === 'delivered' || event === 'failed' || event === 'bounced' || event === 'stalled') return event;
  return null;
}

export interface NotificationPreference {
  enabled: boolean;
  events: Record<NotificationEventKey, boolean>;
}

// Off until the owner asks for it, per browser and per event kind.
export const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = {
  enabled: false,
  events: { delivered: false, failed: false, bounced: false, stalled: false, needs_owner: false },
};

export const NOTIFICATION_STORAGE_BASE_KEY = 'questboard.notifications.v1';

// Same namespacing idea as projectScopedKey (lib/board): two projects sharing one browser must not inherit
// each other's choice. There is deliberately no unscoped form — a caller must already hold the project id,
// so no code path can read or write a choice that does not belong to a named project.
export function notificationStorageKey(projectId: string): string {
  return `${NOTIFICATION_STORAGE_BASE_KEY}.${projectId}`;
}

export type ReadableWritableStorage = Pick<Storage, 'getItem' | 'setItem'>;

function clonePreference(source: NotificationPreference): NotificationPreference {
  return { enabled: source.enabled, events: { ...source.events } };
}

// A damaged or unreadable store must never break the board: any failure falls back to all-off.
export function loadNotificationPreference(
  storage: ReadableWritableStorage | null,
  key: string,
): NotificationPreference {
  if (!storage) return clonePreference(DEFAULT_NOTIFICATION_PREFERENCE);
  try {
    const raw = storage.getItem(key);
    if (!raw) return clonePreference(DEFAULT_NOTIFICATION_PREFERENCE);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return clonePreference(DEFAULT_NOTIFICATION_PREFERENCE);
    const record = parsed as { enabled?: unknown; events?: unknown };
    const events =
      record.events && typeof record.events === 'object'
        ? (record.events as Record<string, unknown>)
        : {};
    return {
      enabled: record.enabled === true,
      events: {
        delivered: events.delivered === true,
        failed: events.failed === true,
        bounced: events.bounced === true,
        stalled: events.stalled === true,
        needs_owner: events.needs_owner === true,
      },
    };
  } catch {
    return clonePreference(DEFAULT_NOTIFICATION_PREFERENCE);
  }
}

// A full or blocked store (private mode, quota) just means the choice does not survive a reload.
export function saveNotificationPreference(
  storage: ReadableWritableStorage | null,
  key: string,
  preference: NotificationPreference,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(preference));
  } catch {
    // Ignored on purpose: persisting is a convenience, not part of showing a notification.
  }
}

export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

// 'unknown' until a live event says whether the server sends ordered ids; then 'supported' or 'unsupported'.
export type NotificationSupport = 'unknown' | 'supported' | 'unsupported';

// The board names its project only when the first snapshot arrives. This is the same shape App hands the
// usage page (UsageProjectScope): it keeps "not loaded yet" apart from "loaded, and this server sent no
// project id", because only the first of those may still resolve to an id, and only with an id may a
// preference be stored or notifications run.
export type NotificationScope = { loaded: false } | { loaded: true; projectId: string | null };

export interface NotificationApiLike {
  readonly permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
}

export interface NotificationHandle {
  close: () => void;
  onClick: (handler: () => void) => void;
}

export interface NotificationsState {
  permission: NotificationPermissionState;
  support: NotificationSupport;
  scope: NotificationScope;
  enabled: boolean;
  events: Record<NotificationEventKey, boolean>;
}

// useSyncExternalStore's server snapshot. This app renders in the browser only, so it is never displayed; it
// exists because the hook asks for a stable value for that argument.
export const NOTIFICATIONS_SERVER_SNAPSHOT: NotificationsState = {
  permission: 'default',
  support: 'unknown',
  scope: { loaded: false },
  enabled: false,
  events: { delivered: false, failed: false, bounced: false, stalled: false, needs_owner: false },
};

// Only the id and the title are ever put into a notification; the center has no business reading more.
export type NotificationQuest = Pick<Quest, 'id' | 'title'>;

export interface NotificationCenterContext {
  scope: NotificationScope;
  quests: ReadonlyArray<NotificationQuest>;
}

export interface NotificationCenterDeps {
  storage: ReadableWritableStorage | null;
  // null when this browser has no Notification API at all.
  notificationApi: NotificationApiLike | null;
  fetchEventsPage: (
    after: number,
    options: { limit: number },
  ) => Promise<{ events: ReadonlyArray<{ seq: number }>; nextAfter: number; atEnd: boolean }>;
  showNotification: (title: string, options: { body: string }) => NotificationHandle;
  focus: () => void;
}

export interface NotificationCenter {
  state: () => NotificationsState;
  subscribe: (listener: () => void) => () => void;
  setOpenQuest: (openQuest: ((questId: string) => void) | null) => void;
  setContext: (context: NotificationCenterContext) => void;
  ingest: (event: QuestEvent) => void;
  baseline: () => Promise<number | null>;
  requestPermission: () => Promise<NotificationPermissionState>;
  setEnabled: (enabled: boolean) => void;
  setEventEnabled: (key: NotificationEventKey, enabled: boolean) => void;
  refreshPermission: () => void;
}

const SCAN_PAGE_SIZE = 500;
// A board whose events file is longer than this is not walked further; the floor ends up as the furthest
// seq read, which still suppresses everything up to that point.
const SCAN_MAX_PAGES = 20;
// How an old board's history endpoint says its records carry no ordered ids (api/historyEvents).
const MISSING_SEQ_MARKER = '缺少整数 seq';

export function createNotificationCenter(deps: NotificationCenterDeps): NotificationCenter {
  let preference: NotificationPreference = clonePreference(DEFAULT_NOTIFICATION_PREFERENCE);
  // The project scope stays unknown until the first snapshot. Only a loaded scope with a real id lets the
  // center read or write a preference, scan a floor or show a notification.
  let scopeLoaded = false;
  let scopedProjectId: string | null = null;
  let permission: NotificationPermissionState = deps.notificationApi
    ? deps.notificationApi.permission
    : 'unsupported';
  let support: NotificationSupport = 'unknown';
  let context: NotificationCenterContext = { scope: { loaded: false }, quests: [] };
  let openQuest: ((questId: string) => void) | null = null;
  // The highest seq this page has accounted for: seeded by the floor scan, then carried by live events.
  // Everything at or below it is history or a repeat.
  let lastSeq = 0;
  let scanned = false;
  let scanPromise: Promise<number | null> | null = null;
  // Bumped on every scope change so a scan from the previous project cannot seed the new one's floor.
  let scanToken = 0;
  let snapshot: NotificationsState = buildState();
  const listeners = new Set<() => void>();

  function buildState(): NotificationsState {
    return {
      permission,
      support,
      scope: scopeLoaded ? { loaded: true, projectId: scopedProjectId } : { loaded: false },
      enabled: preference.enabled,
      events: { ...preference.events },
    };
  }

  function commit(): void {
    snapshot = buildState();
    for (const listener of listeners) listener();
  }

  function setPermission(next: NotificationPermissionState): void {
    if (permission === next) return;
    permission = next;
    commit();
  }

  function setSupport(next: NotificationSupport): void {
    if (support === next) return;
    support = next;
    commit();
  }

  async function scanFloor(): Promise<number | null> {
    const token = ++scanToken;
    let cursor = 0;
    try {
      for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
        const previous = cursor;
        const result = await deps.fetchEventsPage(cursor, { limit: SCAN_PAGE_SIZE });
        if (token !== scanToken) return null;
        if (result.nextAfter > cursor) cursor = result.nextAfter;
        const last = result.events[result.events.length - 1];
        if (last && last.seq > cursor) cursor = last.seq;
        if (result.atEnd || cursor === previous) break;
      }
      if (token !== scanToken) return null;
      if (cursor > lastSeq) lastSeq = cursor;
      return cursor;
    } catch (error) {
      if (token !== scanToken) return null;
      // History without ordered ids means an old board: nothing can be gated or deduplicated, so say so.
      // Any other read failure just leaves the floor unknown; live events still carry the page forward.
      if (error instanceof Error && error.message.includes(MISSING_SEQ_MARKER)) setSupport('unsupported');
      return null;
    }
  }

  function maybeScan(): void {
    // A floor belongs to one project; without a project id there is nothing to anchor it to, so no scan.
    if (!scopeLoaded || !scopedProjectId) return;
    if (!preference.enabled || permission !== 'granted' || scanned) return;
    scanned = true;
    scanPromise = scanFloor();
  }

  function setContext(next: NotificationCenterContext): void {
    const nextLoaded = next.scope.loaded;
    const nextProjectId = nextLoaded && next.scope.projectId ? next.scope.projectId : null;
    context = { scope: { loaded: nextLoaded, projectId: nextProjectId }, quests: next.quests };
    if (nextLoaded === scopeLoaded && nextProjectId === scopedProjectId) return;
    scopeLoaded = nextLoaded;
    scopedProjectId = nextProjectId;
    // A project switch — and equally the step out of "unknown" or "no id" — is a new preference and a new
    // floor: the previous project's choice and seq must not leak in. While no project id is known the
    // preference stays at its defaults and no storage key is touched at all.
    preference =
      scopeLoaded && scopedProjectId
        ? loadNotificationPreference(deps.storage, notificationStorageKey(scopedProjectId))
        : clonePreference(DEFAULT_NOTIFICATION_PREFERENCE);
    lastSeq = 0;
    scanned = false;
    scanPromise = null;
    scanToken += 1;
    commit();
    maybeScan();
  }

  function ingest(event: QuestEvent): void {
    const seq = event.seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) {
      setSupport('unsupported');
      return;
    }
    setSupport('supported');
    // Scope gate: until a snapshot names the project there is no preference to consult and nothing may be
    // stored or shown. The scope change that follows re-baselines the seq from zero anyway, so dropping the
    // frame here loses nothing.
    if (!scopeLoaded || !scopedProjectId) return;
    if (seq <= lastSeq) return;
    lastSeq = seq;
    const key = notificationEventKey(event.event);
    if (!key) return;
    if (!preference.enabled || permission !== 'granted') return;
    if (!preference.events[key]) return;
    const quest = context.quests.find((item) => item.id === event.package) ?? null;
    const headline = quest ? `${event.package} ${quest.title}` : event.package;
    const handle = deps.showNotification(headline, { body: NOTIFICATION_EVENT_LABELS[key] });
    handle.onClick(() => {
      deps.focus();
      if (quest && openQuest) openQuest(quest.id);
      handle.close();
    });
  }

  async function requestPermission(): Promise<NotificationPermissionState> {
    const api = deps.notificationApi;
    if (!api) {
      setPermission('unsupported');
      return 'unsupported';
    }
    try {
      const next = await api.requestPermission();
      setPermission(next);
      if (next === 'granted') maybeScan();
      return next;
    } catch {
      // requestPermission can reject (for example when it is not called from a user gesture); report the
      // state the browser does tell us instead of pretending anything changed.
      refreshPermission();
      return permission;
    }
  }

  function refreshPermission(): void {
    setPermission(deps.notificationApi ? deps.notificationApi.permission : 'unsupported');
    maybeScan();
  }

  function setEnabled(enabled: boolean): void {
    // No project, no choice: a preference without a project id has nowhere safe to live. The settings
    // section keeps its switches disabled until the board names the project, so this is unreachable there.
    if (!scopeLoaded || !scopedProjectId) return;
    if (preference.enabled === enabled) return;
    preference = { ...preference, enabled };
    saveNotificationPreference(deps.storage, notificationStorageKey(scopedProjectId), preference);
    commit();
    if (enabled) maybeScan();
  }

  function setEventEnabled(key: NotificationEventKey, enabled: boolean): void {
    if (!scopeLoaded || !scopedProjectId) return;
    if (preference.events[key] === enabled) return;
    preference = { ...preference, events: { ...preference.events, [key]: enabled } };
    saveNotificationPreference(deps.storage, notificationStorageKey(scopedProjectId), preference);
    commit();
  }

  function state(): NotificationsState {
    return snapshot;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function baseline(): Promise<number | null> {
    return scanPromise ?? Promise.resolve(lastSeq > 0 ? lastSeq : null);
  }

  return {
    state,
    subscribe,
    setOpenQuest: (next) => {
      openQuest = next;
    },
    setContext,
    ingest,
    baseline,
    requestPermission,
    setEnabled,
    setEventEnabled,
    refreshPermission,
  };
}

// ---- The browser singleton the app uses ------------------------------------------------------------------

function browserStorage(): ReadableWritableStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    // A browser that blocks storage (cookies off) still gets to use notifications for this page view.
    return null;
  }
}

function browserNotificationApi(): NotificationApiLike | null {
  if (typeof window === 'undefined') return null;
  const api = window.Notification as NotificationApiLike | undefined;
  return api && typeof api.requestPermission === 'function' ? api : null;
}

function defaultShowNotification(title: string, options: { body: string }): NotificationHandle {
  try {
    const instance = new Notification(title, options);
    return {
      close: () => instance.close(),
      onClick: (handler) => {
        instance.onclick = handler;
      },
    };
  } catch {
    // Constructing can fail (for example an insecure context); the board must keep running either way.
    return { close: () => {}, onClick: () => {} };
  }
}

let singleton: NotificationCenter | null = null;

function center(): NotificationCenter {
  if (!singleton) {
    singleton = createNotificationCenter({
      storage: browserStorage(),
      notificationApi: browserNotificationApi(),
      fetchEventsPage: (after, options) => fetchEventsPage(after, options),
      showNotification: defaultShowNotification,
      focus: () => {
        window.focus();
      },
    });
  }
  return singleton;
}

// Called by useBoard whenever a fresh snapshot arrives: sets the project scope (which reloads that project's
// preference and re-baselines the seq) and the quest list used to title a notification. A null snapshot
// means the board has not loaded yet — the scope stays unknown and, until a snapshot names the project,
// nothing is read, written, scanned or shown.
export function observeBoard(snap: Snapshot | null): void {
  center().setContext({
    scope: snap ? { loaded: true, projectId: snap.project.id ?? null } : { loaded: false },
    quests: snap?.quests ?? [],
  });
}

// Called by useBoard for every frame of the board's event stream.
export function observeBoardEvent(event: QuestEvent): void {
  center().ingest(event);
}

// The drawer lives in App; this is how a notification click opens a quest there.
export function setNotificationQuestOpener(openQuest: ((questId: string) => void) | null): void {
  center().setOpenQuest(openQuest);
}

export function getNotificationsState(): NotificationsState {
  return center().state();
}

export function subscribeNotifications(listener: () => void): () => void {
  return center().subscribe(listener);
}

export function getNotificationsServerSnapshot(): NotificationsState {
  return NOTIFICATIONS_SERVER_SNAPSHOT;
}

export function requestNotificationsPermission(): Promise<NotificationPermissionState> {
  return center().requestPermission();
}

export function setNotificationsEnabled(enabled: boolean): void {
  center().setEnabled(enabled);
}

export function setNotificationEventEnabled(key: NotificationEventKey, enabled: boolean): void {
  center().setEventEnabled(key, enabled);
}

export function refreshNotificationPermission(): void {
  center().refreshPermission();
}
