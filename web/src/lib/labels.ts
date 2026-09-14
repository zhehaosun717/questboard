// Chinese labels and board structure. Plain, everyday wording.
import type { CardStatus, QuestEvent, QuestKind, QuestStatus } from '../api/types';

export const STATUS: Record<QuestStatus, string> = {
  // delivered is the worker's own claim, so it is not called 已交付 (it read as finished): it waits for sign-off.
  posted: '待接', dispatched: '进行中', delivered: '待验收', reviewing: '审核中', needs_owner: '等裁决',
  owner_playtest: '等你试玩', lane_limited: '通道受限', bounced: '限额退回', failed: '失败', stalled: '卡住',
  done: '已完成', superseded: '已取代', cancelled: '已取消',
};

export const KIND: Record<QuestKind, string> = { code: '代码', review: '审核', art: '美术', tool: '工具', owner: '你来' };

export const CARD_STATUS: Record<CardStatus, string> = { available: '空闲', limited: '限额', broke: '没钱', paused: '暂停', disabled: '停用' };

export const BILLING: Record<string, string> = { subscription: '订阅', plan: '套餐', payg: '按量付费', free: '免费' };

export interface Column {
  key: 'open' | 'run' | 'check' | 'owner' | 'done';
  num: string;
  title: string;
  sub: string;
  statuses: QuestStatus[];
  limit?: number;
}

export const COLUMNS: Column[] = [
  { key: 'open', num: '01', title: '悬赏中', sub: 'OPEN', statuses: ['posted', 'failed', 'bounced', 'stalled', 'lane_limited'] },
  { key: 'run', num: '02', title: '进行中', sub: 'IN THE PIT', statuses: ['dispatched'] },
  { key: 'check', num: '03', title: '待验收', sub: 'HAULED UP', statuses: ['delivered', 'reviewing'] },
  { key: 'owner', num: '04', title: '等你', sub: 'YOUR CALL', statuses: ['needs_owner', 'owner_playtest'] },
  { key: 'done', num: '05', title: '已完成', sub: 'ARCHIVED', statuses: ['done', 'superseded', 'cancelled'], limit: 12 },
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
    review_posted: `新审核委托 ${event.package}`,
    assigned: `${event.package} 已指派${who}`,
    dispatched: `${event.package} 脚本已启动${who}`,
    delivered: `${event.package} 交回了，待验收${who}`,
    failed: `${event.package} 失败${who}`,
    bounced: `${event.package} 限额退回${who}`,
    stalled: `${event.package} 卡住了${who}`,
    cancelled: `${event.package} 已取消`,
    released: `${event.package} 的 worker 已释放，可以重新派`,
    owner_ruling: `${event.package} 已裁决`,
    delivery_write_failed: `${event.package} 交付文件没写成：${event.detail}`,
  };
  const status = event.event.replace(/^status_/, '') as QuestStatus;
  return texts[event.event] ?? `${event.package} → ${STATUS[status] ?? event.event}`;
}
