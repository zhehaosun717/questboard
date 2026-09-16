// The notification center is tested in node with injected fakes: a Map-backed storage, a scripted
// Notification API, a scripted /api/events reader and a recording "show" function.
import { describe, expect, it } from 'vitest';
import type { QuestEvent } from '../api/types';
import {
  createNotificationCenter,
  DEFAULT_NOTIFICATION_PREFERENCE,
  loadNotificationPreference,
  notificationStorageKey,
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENT_LABELS,
  saveNotificationPreference,
  type NotificationCenter,
  type NotificationHandle,
  type NotificationPermissionState,
  type ReadableWritableStorage,
} from './notifications';

const DETAIL_THAT_MUST_NOT_LEAK = '报告全文不应该出现在通知里';

function boardEvent(overrides: { event: string; seq?: number; package?: string }): QuestEvent {
  return {
    at: '2026-09-16T00:00:00.000Z',
    package: 'Q-1',
    lane: null,
    model: null,
    variant: null,
    name: null,
    by: 'test',
    detail: DETAIL_THAT_MUST_NOT_LEAK,
    ...overrides,
  };
}

interface ScanPage {
  events: Array<{ seq: number }>;
  nextAfter: number;
  atEnd: boolean;
}

interface ShownNotification {
  title: string;
  body: string;
  closed: boolean;
  click: () => void;
}

interface HarnessOptions {
  // null means this browser has no Notification API at all.
  permission?: NotificationPermission | null;
  requestPermission?: () => Promise<NotificationPermission>;
  fetchError?: Error;
  pages?: ScanPage[];
  storage?: ReadableWritableStorage | null;
}

interface MutableNotificationApi {
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
}

interface Harness {
  center: NotificationCenter;
  shown: ShownNotification[];
  focused: boolean[];
  fetches: Array<{ after: number; limit: number }>;
  api: MutableNotificationApi | null;
  store: Map<string, string>;
}

function harness(options: HarnessOptions = {}): Harness {
  const store = new Map<string, string>();
  const storage =
    options.storage === undefined
      ? {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => {
            store.set(key, value);
          },
        }
      : options.storage;
  const pages: ScanPage[] = [...(options.pages ?? [{ events: [], nextAfter: 0, atEnd: true }])];
  const shown: ShownNotification[] = [];
  const focused: boolean[] = [];
  const fetches: Array<{ after: number; limit: number }> = [];
  const api =
    options.permission === null
      ? null
      : {
          permission: options.permission ?? ('default' as NotificationPermission),
          requestPermission: options.requestPermission ?? (async () => 'default' as NotificationPermission),
        };
  const center = createNotificationCenter({
    storage,
    notificationApi: api,
    fetchEventsPage: async (after, opts) => {
      fetches.push({ after, limit: opts.limit });
      if (options.fetchError) throw options.fetchError;
      const page = pages.shift();
      if (!page) throw new Error(`没有更多页了（after=${after}）`);
      return page;
    },
    showNotification: (title, opts) => {
      const record: ShownNotification = { title, body: opts.body, closed: false, click: () => {} };
      const handle: NotificationHandle = {
        close: () => {
          record.closed = true;
        },
        onClick: (handler) => {
          record.click = handler;
        },
      };
      shown.push(record);
      return handle;
    },
    focus: () => {
      focused.push(true);
    },
  });
  return { center, shown, focused, fetches, api, store };
}

function enableEverything(center: NotificationCenter): void {
  center.setEnabled(true);
  for (const key of NOTIFICATION_EVENT_KEYS) center.setEventEnabled(key, true);
}

describe('notification preference storage', () => {
  it('loads all-off defaults from nothing, from junk, and from a missing store', () => {
    const store = new Map<string, string>();
    const storage: ReadableWritableStorage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
    };
    expect(loadNotificationPreference(storage, 'k')).toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
    store.set('k', 'not json');
    expect(loadNotificationPreference(storage, 'k')).toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
    store.set('k', JSON.stringify({ enabled: true, events: { delivered: true, junk: true } }));
    expect(loadNotificationPreference(storage, 'k')).toEqual({
      enabled: true,
      events: { delivered: true, failed: false, bounced: false, stalled: false, needs_owner: false },
    });
    expect(loadNotificationPreference(null, 'k')).toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
  });

  it('survives a store that throws on read and on write', () => {
    const throwing: ReadableWritableStorage = {
      getItem: () => {
        throw new Error('存储被浏览器挡住');
      },
      setItem: () => {
        throw new Error('存储被浏览器挡住');
      },
    };
    expect(loadNotificationPreference(throwing, 'k')).toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
    expect(() => saveNotificationPreference(throwing, 'k', DEFAULT_NOTIFICATION_PREFERENCE)).not.toThrow();
  });

  it('keys the preference by project id and has no unscoped form', () => {
    expect(notificationStorageKey('proj-a')).toBe('questboard.notifications.v1.proj-a');
    // The signature only accepts a real project id, so no call can produce the bare base key.
    expect(notificationStorageKey('proj-b')).not.toBe('questboard.notifications.v1');
  });

  it('reads and writes the choice under the project-scoped key', () => {
    const store = new Map<string, string>();
    store.set(
      'questboard.notifications.v1.p',
      JSON.stringify({ enabled: true, events: { failed: true } }),
    );
    const h = harness({
      permission: 'granted',
      storage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => {
          store.set(key, value);
        },
      },
    });
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [] });
    expect(h.center.state().enabled).toBe(true);
    expect(h.center.state().events.failed).toBe(true);
    expect(h.center.state().events.delivered).toBe(false);
    h.center.setEnabled(false);
    expect(store.get('questboard.notifications.v1.p')).toContain('"enabled":false');
  });
});

describe('nothing runs while off or not allowed', () => {
  it('shows nothing and reads no history while the preference is off', () => {
    const h = harness({ permission: 'granted' });
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [{ id: 'Q-1', title: '修按钮' }] });
    h.center.ingest(boardEvent({ event: 'delivered', seq: 7 }));
    expect(h.shown).toHaveLength(0);
    expect(h.fetches).toHaveLength(0);
  });

  it('shows nothing until the browser grants permission, then notifies', async () => {
    const h = harness({
      permission: 'default',
      requestPermission: async () => 'granted',
      pages: [{ events: [], nextAfter: 0, atEnd: true }],
    });
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [{ id: 'Q-1', title: '修按钮' }] });
    enableEverything(h.center);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 10 }));
    expect(h.shown).toHaveLength(0);
    expect(await h.center.requestPermission()).toBe('granted');
    expect(h.center.state().permission).toBe('granted');
    h.center.ingest(boardEvent({ event: 'delivered', seq: 11 }));
    expect(h.shown).toHaveLength(1);
  });

  it('keeps the honest state when asking for permission fails', async () => {
    const h = harness({
      permission: 'default',
      requestPermission: async () => {
        throw new Error('需要用户手势');
      },
    });
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [] });
    expect(await h.center.requestPermission()).toBe('default');
    expect(h.center.state().permission).toBe('default');
  });

  it('reports unsupported when the browser has no Notification API', async () => {
    const h = harness({ permission: null });
    expect(h.center.state().permission).toBe('unsupported');
    expect(await h.center.requestPermission()).toBe('unsupported');
  });

  it('picks up a permission that was changed in the browser settings', () => {
    const h = harness({ permission: 'denied' });
    const api = h.api;
    if (!api) throw new Error('这个用例需要 Notification API');
    h.center.refreshPermission();
    expect(h.center.state().permission).toBe('denied');
    api.permission = 'granted';
    h.center.refreshPermission();
    expect(h.center.state().permission).toBe('granted');
  });
});

describe('an older board without ordered event ids', () => {
  it('turns notifications off when a live event carries no seq', () => {
    const h = harness({ permission: 'granted' });
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [{ id: 'Q-1', title: '修按钮' }] });
    enableEverything(h.center);
    h.center.ingest(boardEvent({ event: 'delivered' }));
    expect(h.center.state().support).toBe('unsupported');
    expect(h.shown).toHaveLength(0);
    // A later event that does carry a seq proves the board after all — live truth wins.
    h.center.ingest(boardEvent({ event: 'delivered', seq: 3 }));
    expect(h.center.state().support).toBe('supported');
    expect(h.shown).toHaveLength(1);
  });

  it('reports an old board when the history itself has no ordered ids', async () => {
    const h = harness({
      permission: 'granted',
      fetchError: new Error('事件记录缺少整数 seq（收到类型 string），已停止读取'),
    });
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [] });
    h.center.setEnabled(true);
    expect(await h.center.baseline()).toBeNull();
    expect(h.center.state().support).toBe('unsupported');
  });
});

describe('the seq floor and dedup', () => {
  it('does not notify for events at or below the seq seen when the page loaded', async () => {
    const h = harness({
      permission: 'granted',
      pages: [{ events: [{ seq: 40 }, { seq: 41 }], nextAfter: 41, atEnd: true }],
    });
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [{ id: 'Q-1', title: '修按钮' }] });
    enableEverything(h.center);
    expect(await h.center.baseline()).toBe(41);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 40 }));
    h.center.ingest(boardEvent({ event: 'delivered', seq: 41 }));
    expect(h.shown).toHaveLength(0);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 42 }));
    expect(h.shown).toHaveLength(1);
  });

  it('shows an event once and drops a reconnect replay of it', () => {
    const h = harness({ permission: 'granted', pages: [{ events: [], nextAfter: 0, atEnd: true }] });
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [{ id: 'Q-1', title: '修按钮' }] });
    enableEverything(h.center);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 20 }));
    h.center.ingest(boardEvent({ event: 'delivered', seq: 20 }));
    h.center.ingest(boardEvent({ event: 'delivered', seq: 19 }));
    expect(h.shown).toHaveLength(1);
  });

  it('carries the floor across a project switch and keeps the choices apart', async () => {
    const h = harness({
      permission: 'granted',
      pages: [
        { events: [{ seq: 100 }], nextAfter: 100, atEnd: true },
        { events: [{ seq: 5 }], nextAfter: 5, atEnd: true },
      ],
    });
    h.center.setContext({ scope: { loaded: true, projectId: 'a' }, quests: [{ id: 'Q-1', title: '甲' }] });
    enableEverything(h.center);
    expect(await h.center.baseline()).toBe(100);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 101 }));
    expect(h.shown).toHaveLength(1);
    expect(h.store.get('questboard.notifications.v1.a')).toContain('"enabled":true');

    // The other project starts from its own stored choice (all off), is re-baselined, and after being
    // switched on only hears what comes next.
    h.center.setContext({ scope: { loaded: true, projectId: 'b' }, quests: [{ id: 'Q-9', title: '乙' }] });
    expect(h.center.state().enabled).toBe(false);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 6 }));
    expect(h.shown).toHaveLength(1);
    h.center.setEnabled(true);
    h.center.setEventEnabled('delivered', true);
    expect(await h.center.baseline()).toBe(5);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 6 }));
    expect(h.shown).toHaveLength(1);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 7, package: 'Q-9' }));
    expect(h.shown).toHaveLength(2);
    expect(h.shown[1]?.title).toBe('Q-9 乙');
    expect(h.store.has('questboard.notifications.v1.b')).toBe(true);
  });
});

describe('what a notification says and does', () => {
  it('carries the quest id, title and status word only, and opens the quest on click', () => {
    const h = harness({ permission: 'granted', pages: [{ events: [], nextAfter: 0, atEnd: true }] });
    const opened: string[] = [];
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [{ id: 'Q-1', title: '修按钮' }] });
    h.center.setOpenQuest((questId) => opened.push(questId));
    enableEverything(h.center);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 7 }));
    expect(h.shown).toHaveLength(1);
    const shown = h.shown[0];
    expect(shown?.title).toBe('Q-1 修按钮');
    expect(shown?.body).toBe(NOTIFICATION_EVENT_LABELS.delivered);
    expect(`${shown?.title}${shown?.body}`).not.toContain(DETAIL_THAT_MUST_NOT_LEAK);
    shown?.click();
    expect(h.focused).toHaveLength(1);
    expect(opened).toEqual(['Q-1']);
    expect(shown?.closed).toBe(true);
  });

  it('ignores events the switches do not cover and words needs_owner like the board does', () => {
    const h = harness({ permission: 'granted', pages: [{ events: [], nextAfter: 0, atEnd: true }] });
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [{ id: 'Q-1', title: '修按钮' }] });
    enableEverything(h.center);
    h.center.ingest(boardEvent({ event: 'assigned', seq: 30 }));
    expect(h.shown).toHaveLength(0);
    h.center.ingest(boardEvent({ event: 'status_needs_owner', seq: 31 }));
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]?.body).toBe(NOTIFICATION_EVENT_LABELS.needs_owner);
  });

  it('focuses but opens nothing when the quest is no longer on the board', () => {
    const h = harness({ permission: 'granted', pages: [{ events: [], nextAfter: 0, atEnd: true }] });
    const opened: string[] = [];
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [] });
    h.center.setOpenQuest((questId) => opened.push(questId));
    enableEverything(h.center);
    h.center.ingest(boardEvent({ event: 'failed', seq: 8 }));
    expect(h.shown[0]?.title).toBe('Q-1');
    h.shown[0]?.click();
    expect(h.focused).toHaveLength(1);
    expect(opened).toEqual([]);
  });
});

describe('state for the settings screen', () => {
  it('starts honest about a permission it was never told about', () => {
    const h = harness({ permission: 'default' });
    expect(h.center.state()).toEqual({
      permission: 'default',
      support: 'unknown',
      scope: { loaded: false },
      enabled: false,
      events: { delivered: false, failed: false, bounced: false, stalled: false, needs_owner: false },
    });
  });

  it('notifies subscribers only when something visible changes', () => {
    const h = harness({ permission: 'granted' });
    let calls = 0;
    const unsubscribe = h.center.subscribe(() => {
      calls += 1;
    });
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [] });
    const afterContext = calls;
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [{ id: 'Q-1', title: '修按钮' }] });
    expect(calls).toBe(afterContext);
    h.center.setEnabled(true);
    expect(calls).toBeGreaterThan(afterContext);
    const afterEnable = calls;
    h.center.setEnabled(true);
    expect(calls).toBe(afterEnable);
    unsubscribe();
    h.center.setEnabled(false);
    expect(calls).toBe(afterEnable);
  });

  it('keeps the permission state visible as a typed union', () => {
    const h = harness({ permission: 'denied' });
    const permission: NotificationPermissionState = h.center.state().permission;
    expect(permission).toBe('denied');
  });
});

describe('the window before the first snapshot', () => {
  it('touches no storage, scans no history and shows nothing until the board names its project', async () => {
    const accessed: string[] = [];
    const store = new Map<string, string>();
    // A value under the bare key — the shape an earlier candidate could have left behind — is not a
    // project preference and must never be read.
    store.set('questboard.notifications.v1', JSON.stringify({ enabled: true, events: { delivered: true } }));
    const h = harness({
      permission: 'granted',
      requestPermission: async () => 'granted' as NotificationPermission,
      storage: {
        getItem: (key) => {
          accessed.push(`get:${key}`);
          return store.get(key) ?? null;
        },
        setItem: (key, value) => {
          accessed.push(`set:${key}`);
          store.set(key, value);
        },
      },
      pages: [{ events: [{ seq: 40 }], nextAfter: 40, atEnd: true }],
    });

    // The settings section keeps its switches disabled while the scope is unknown, so even a programmatic
    // attempt is discarded rather than persisted: nothing has a project to belong to yet.
    h.center.setEnabled(true);
    h.center.setEventEnabled('delivered', true);
    expect(await h.center.requestPermission()).toBe('granted');
    h.center.ingest(boardEvent({ event: 'delivered', seq: 11 }));
    expect(h.center.state().enabled).toBe(false);
    expect(h.center.state().scope).toEqual({ loaded: false });
    expect(h.shown).toHaveLength(0);
    expect(h.fetches).toHaveLength(0);
    expect(accessed).toEqual([]);

    // The first snapshot names the project: only now does a preference get read, and only this project's.
    h.center.setContext({ scope: { loaded: true, projectId: 'p' }, quests: [{ id: 'Q-1', title: '修按钮' }] });
    expect(h.center.state().scope).toEqual({ loaded: true, projectId: 'p' });
    expect(h.center.state().enabled).toBe(false);
    expect(accessed).toEqual(['get:questboard.notifications.v1.p']);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 12 }));
    expect(h.shown).toHaveLength(0);

    // Turning it on for this project then behaves exactly as it does after a normal load.
    h.center.setEnabled(true);
    h.center.setEventEnabled('delivered', true);
    expect(await h.center.baseline()).toBe(40);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 41 }));
    expect(h.shown).toHaveLength(1);
    expect(accessed.some((entry) => entry === 'get:questboard.notifications.v1')).toBe(false);
    expect(accessed.some((entry) => entry === 'set:questboard.notifications.v1')).toBe(false);
  });
});

describe('one browser, several projects', () => {
  it('never reads a preference stored outside the current project and never fires another project choice', async () => {
    const bareKey = 'questboard.notifications.v1';
    const store = new Map<string, string>();
    store.set(bareKey, JSON.stringify({ enabled: true, events: { delivered: true } }));
    store.set('questboard.notifications.v1.a', JSON.stringify({ enabled: true, events: { delivered: true } }));
    const accessed: string[] = [];
    const h = harness({
      permission: 'granted',
      storage: {
        getItem: (key) => {
          accessed.push(`get:${key}`);
          return store.get(key) ?? null;
        },
        setItem: (key, value) => {
          accessed.push(`set:${key}`);
          store.set(key, value);
        },
      },
      pages: [{ events: [{ seq: 20 }], nextAfter: 20, atEnd: true }],
    });

    // Project b is on screen: project a's stored choice, and the bare key, must not reach it.
    h.center.setContext({ scope: { loaded: true, projectId: 'b' }, quests: [{ id: 'Q-1', title: '修按钮' }] });
    expect(h.center.state().enabled).toBe(false);
    expect(accessed).toEqual(['get:questboard.notifications.v1.b']);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 21 }));
    expect(h.shown).toHaveLength(0);
    expect(h.fetches).toHaveLength(0);

    // Switching to project a loads a's own choice — nothing carried over from b, nothing from the bare key.
    h.center.setContext({ scope: { loaded: true, projectId: 'a' }, quests: [{ id: 'Q-1', title: '修按钮' }] });
    expect(h.center.state().enabled).toBe(true);
    expect(h.center.state().events.delivered).toBe(true);
    expect(await h.center.baseline()).toBe(20);
    h.center.ingest(boardEvent({ event: 'delivered', seq: 21 }));
    expect(h.shown).toHaveLength(1);
    expect(accessed).toEqual(['get:questboard.notifications.v1.b', 'get:questboard.notifications.v1.a']);
  });
});
