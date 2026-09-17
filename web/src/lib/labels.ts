// Chinese labels and board structure. Plain, everyday wording. Each table value is read through t() so the
// board's own labels follow the per-browser language switch; the zh strings are exactly the literals they
// replaced, so a board left in Chinese renders byte-identically to before.
import type { CardStatus, QuestEvent, QuestKind, QuestStatus } from '../api/types';
import { t } from './i18n';

export const STATUS: Record<QuestStatus, string> = {
  // delivered is the worker's own claim, so it is not called 已交付 (it read as finished): it waits for sign-off.
  get posted() { return t('status.posted'); },
  get dispatched() { return t('status.dispatched'); },
  get delivered() { return t('status.delivered'); },
  get reviewing() { return t('status.reviewing'); },
  get needs_owner() { return t('status.needs_owner'); },
  get owner_playtest() { return t('status.owner_playtest'); },
  get lane_limited() { return t('status.lane_limited'); },
  get bounced() { return t('status.bounced'); },
  get failed() { return t('status.failed'); },
  get stalled() { return t('status.stalled'); },
  get done() { return t('status.done'); },
  get superseded() { return t('status.superseded'); },
  get cancelled() { return t('status.cancelled'); },
};

export const KIND: Record<QuestKind, string> = {
  get code() { return t('kind.code'); },
  get review() { return t('kind.review'); },
  get art() { return t('kind.art'); },
  get tool() { return t('kind.tool'); },
  get owner() { return t('kind.owner'); },
};

// Whose job it is to verify and accept returned work. Code and tools are judged on whether they run — that
// is the coordinator's review loop, not the owner's acceptance. Art and 你来 quests stay with the owner.
// An open owner question outranks this — it is asked by definition.
export type Verifier = 'owner' | 'coordinator';

export const VERIFIER_LABEL: Record<Verifier, string> = {
  get owner() { return t('verifier.owner'); },
  get coordinator() { return t('verifier.coordinator'); },
};

export function acceptanceBy(kind: QuestKind): Verifier {
  return kind === 'art' || kind === 'owner' ? 'owner' : 'coordinator';
}

export const CARD_STATUS: Record<CardStatus, string> = {
  get available() { return t('cardStatus.available'); },
  get limited() { return t('cardStatus.limited'); },
  get broke() { return t('cardStatus.broke'); },
  get paused() { return t('cardStatus.paused'); },
  get disabled() { return t('cardStatus.disabled'); },
};

export const BILLING: Record<string, string> = {
  get subscription() { return t('billing.subscription'); },
  get plan() { return t('billing.plan'); },
  get payg() { return t('billing.payg'); },
  get free() { return t('billing.free'); },
};

export interface Column {
  key: 'open' | 'run' | 'check' | 'owner' | 'done';
  num: string;
  title: string;
  sub: string;
  statuses: QuestStatus[];
  limit?: number;
}

export const COLUMNS: Column[] = [
  {
    key: 'open', num: '01', statuses: ['posted', 'failed', 'bounced', 'stalled', 'lane_limited'],
    get title() { return t('column.open.title'); },
    get sub() { return t('column.open.sub'); },
  },
  {
    key: 'run', num: '02', statuses: ['dispatched'],
    get title() { return t('column.run.title'); },
    get sub() { return t('column.run.sub'); },
  },
  {
    key: 'check', num: '03', statuses: ['delivered', 'reviewing'],
    get title() { return t('column.check.title'); },
    get sub() { return t('column.check.sub'); },
  },
  {
    key: 'owner', num: '04', statuses: ['needs_owner', 'owner_playtest'],
    get title() { return t('column.owner.title'); },
    get sub() { return t('column.owner.sub'); },
  },
  {
    key: 'done', num: '05', statuses: ['done', 'superseded', 'cancelled'], limit: 12,
    get title() { return t('column.done.title'); },
    get sub() { return t('column.done.sub'); },
  },
];

export const OPEN_STATUSES: QuestStatus[] = COLUMNS[0]!.statuses;

export const NODE_COLORS: Partial<Record<QuestStatus, string>> = {
  dispatched: '#4b86c9', delivered: '#9a7ccf', reviewing: '#9a7ccf', failed: '#d9442e', stalled: '#d9442e',
  bounced: '#e0662f', lane_limited: '#e0662f', needs_owner: '#f2b134', owner_playtest: '#f2b134', done: '#3fae6b',
};

export function describeEvent(event: QuestEvent): string {
  const who = event.model ? `（${event.model}）` : '';
  const texts: Record<string, string> = {
    posted: `新委托 ${event.package}`,
    review_posted: `新复核委托 ${event.package}`,
    assigned: `${event.package} 已派出${who}`,
    dispatched: `${event.package} 脚本已启动${who}`,
    delivered: `${event.package} 交差了，待验收${who}`,
    failed: `${event.package} 失败${who}`,
    bounced: `${event.package} 限额退回${who}`,
    stalled: `${event.package} 失联了${who}`,
    cancelled: `${event.package} 已取消`,
    released: `${event.package} 的冒险者已释放，可以重新派`,
    owner_ruling: `${event.package} 已裁决`,
    delivery_write_failed: `${event.package} 交差文件没写成：${event.detail}`,
  };
  const status = event.event.replace(/^status_/, '') as QuestStatus;
  return texts[event.event] ?? `${event.package} → ${STATUS[status] ?? event.event}`;
}
