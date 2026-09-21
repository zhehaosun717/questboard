// FB2-04 items 3/5: what the coordinator must hear about without watching the board — a review quest's
// delivery (which card, where the verdict came from, how long it took) and the moment a batch's
// waitingOn quest lands (time to accept the batch). One store 'event' subscription covers every
// delivery path (file lanes, server lanes, manual status moves) because they all end in setStatus.
const REPORT_SOURCE_ZH = { delivery: '交差文件', 'exit-file': '退出文件', summary: '运行记录 .out' };

function waitText(from, to) {
  const start = Date.parse(from || '');
  const end = Date.parse(to || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '等多久算不出来';
  const minutes = Math.round((end - start) / 60000);
  if (minutes < 60) return `等了 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `等了 ${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`;
}

export function attachDeliveryNotifications({ store, boardStore }) {
  if (!boardStore) return () => {};
  const onEvent = (record) => {
    if (!record || record.event !== 'delivered') return;
    const quest = store.get(record.package);
    if (!quest) return;
    if (quest.kind === 'review') {
      // Item 3: 卡号 + 结论来源 + 等多久, and the work it reviewed so the message stands alone.
      const source = REPORT_SOURCE_ZH[record.report?.source] || '没有留下报告引用';
      const waited = waitText(quest.assignee?.at, record.at);
      const target = (quest.parents || [])[0] || '（没有父任务）';
      boardStore.createThread({
        title: `${quest.id} 复核交付`,
        body: `${quest.id}（复核 ${target}）交付了：结论来源 ${source}${record.report?.ref ? `（${record.report.ref}）` : ''}，派出后${waited}。该看它下的结论了。`,
        author: 'board',
        tags: ['note', quest.id],
      });
    }
    // Item 5: every quest that declared waitingOn this one moves the batch to "该验收这批".
    const waiters = store.list().filter((other) => other.waitingOn === quest.id);
    if (waiters.length) {
      const lines = waiters.map((other) => {
        // Mates exclude the quest itself and the one they were waiting on (named in the title already).
        const mates = (other.batch || []).filter((id) => id !== other.id && id !== quest.id);
        return `- ${other.id}${mates.length ? `（和 ${mates.join('、')} 一批）` : ''}`;
      });
      boardStore.createThread({
        title: `${quest.id} 交付：这批该验收了`,
        body: [`${quest.id} 交付了，下面 ${waiters.length} 张卡就在等它：`, ...lines, '', '验收这批之后它们才能继续。'].join('\n'),
        author: 'board',
        tags: ['note', quest.id],
      });
    }
  };
  store.on('event', onEvent);
  return () => store.off('event', onEvent);
}
