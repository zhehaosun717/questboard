/**
 * The board's own interface language, a per-browser choice. Only text this app renders itself is in here:
 * labels, buttons, hints, states. User content — briefs, quest titles, notes, worker output, roster names,
 * every value that comes from the project config or the server — is never translated and never goes
 * through `t`. Chinese is the default and every zh string is byte-identical to the literal it replaced;
 * turning nothing on changes nothing. English is deliberately partial: a key without an English entry
 * falls back to its Chinese string, never to an empty string or the key itself.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type Locale = 'zh-CN' | 'en';

export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** Every locale this build offers, in the order the settings picker shows them. */
export const LOCALES: readonly Locale[] = ['zh-CN', 'en'];

/** The picker's own choices, written so each one reads in its own language. */
export const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
];

const LOCALE_STORAGE_KEY = 'questboard.locale.v1';

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

type Translation = { zh: string; en?: string };

/**
 * One line per visible string. Keys are dotted paths; `{name}` marks a value the caller must provide.
 * A missing `en` entry means "same text in both languages" — those fall back to `zh` on purpose.
 */
export const TRANSLATIONS = {
  // — shared —
  'common.reading': { zh: '正在读取…', en: 'Reading…' },
  'common.saving': { zh: '正在保存…', en: 'Saving…' },
  'common.cooldown': { zh: '冷却中 {seconds}s', en: 'Cooling down {seconds}s' },
  'common.listSeparator': { zh: '、', en: ', ' },
  'common.statementSeparator': { zh: '；', en: '; ' },

  // — quest status, kind, verifier — labels.ts tables —
  'status.posted': { zh: '待接', en: 'Open' },
  'status.dispatched': { zh: '进行中', en: 'Running' },
  'status.delivered': { zh: '待验收', en: 'To verify' },
  'status.reviewing': { zh: '复核中', en: 'Reviewing' },
  'status.needs_owner': { zh: '等裁决', en: 'Needs a ruling' },
  'status.owner_playtest': { zh: '等你试玩', en: 'Your playtest' },
  'status.lane_limited': { zh: '接入方式受限', en: 'Lane limited' },
  'status.bounced': { zh: '限额退回', en: 'Quota returned' },
  'status.failed': { zh: '失败', en: 'Failed' },
  'status.stalled': { zh: '失联', en: 'No signal' },
  'status.done': { zh: '已完成', en: 'Done' },
  'status.superseded': { zh: '已取代', en: 'Superseded' },
  'status.cancelled': { zh: '已取消', en: 'Cancelled' },
  'kind.code': { zh: '代码', en: 'Code' },
  'kind.review': { zh: '复核', en: 'Review' },
  'kind.art': { zh: '美术', en: 'Art' },
  'kind.tool': { zh: '工具', en: 'Tool' },
  'kind.owner': { zh: '你来', en: 'You' },
  'verifier.owner': { zh: '你', en: 'You' },
  'verifier.coordinator': { zh: 'coordinator' },
  'cardStatus.available': { zh: '空闲', en: 'Idle' },
  'cardStatus.limited': { zh: '限额', en: 'Limited' },
  'cardStatus.broke': { zh: '没钱', en: 'No funds' },
  'cardStatus.paused': { zh: '暂停', en: 'Paused' },
  'cardStatus.disabled': { zh: '停用', en: 'Disabled' },
  'billing.subscription': { zh: '订阅', en: 'Subscription' },
  'billing.plan': { zh: '套餐', en: 'Plan' },
  'billing.payg': { zh: '按量付费', en: 'Pay as you go' },
  'billing.free': { zh: '免费', en: 'Free' },

  // — board columns — labels.ts COLUMNS —
  'column.open.title': { zh: '委托板', en: 'Quest board' },
  'column.open.sub': { zh: 'OPEN' },
  'column.run.title': { zh: '出任务中', en: 'On quest' },
  'column.run.sub': { zh: 'ON QUEST' },
  'column.check.title': { zh: '交差核验', en: 'Verify' },
  'column.check.sub': { zh: 'VERIFY' },
  'column.owner.title': { zh: '等会长', en: 'Your call' },
  'column.owner.sub': { zh: 'YOUR CALL' },
  'column.done.title': { zh: '卷宗室', en: 'Archive' },
  'column.done.sub': { zh: 'ARCHIVED' },

  // — header —
  'header.eyebrowPlain': { zh: "QUESTBOARD · ADVENTURERS' GUILD" },
  'header.eyebrowWithProject': { zh: "{project} · ADVENTURERS' GUILD" },
  'header.title': { zh: '委托板', en: 'Quest board' },
  'header.navLabel': { zh: '视图', en: 'Views' },
  'header.tab.board': { zh: '委托墙', en: 'Board' },
  'header.tab.graph': { zh: '冒险地图', en: 'Map' },
  'header.tab.threads': { zh: '留言板', en: 'Threads' },
  'header.tab.threadsWithCount': { zh: '留言板 · {count}', en: 'Threads · {count}' },
  'header.tab.review': { zh: '美术评审', en: 'Art review' },
  'header.tab.history': { zh: '派出记录', en: 'Dispatch log' },
  'header.tab.roster': { zh: '冒险者', en: 'Adventurers' },
  'header.tab.usage': { zh: '用量', en: 'Usage' },
  'header.tab.settings': { zh: '设置', en: 'Settings' },
  'header.defaultCardMissing': { zh: '默认卡「{id}」不在名册里，去「派遣规则」改掉，或先把卡补进名册。', en: 'The default card "{id}" is not in the roster; change it in Dispatch rules, or add the card first.' },

  // — board —
  'board.expand': { zh: '展开', en: 'Expand' },
  'board.expandTitle': { zh: '展开{title}', en: 'Expand {title}' },
  'board.collapse': { zh: '收起', en: 'Collapse' },
  'board.collapseTitle': { zh: '收起{title}', en: 'Collapse {title}' },
  'board.archiveCountTitle': {
    zh: '全部完成、取代和取消的委托，不受当前搜索影响',
    en: 'All done, superseded and cancelled quests; the current search does not affect them',
  },
  'board.searchPlaceholder': { zh: '搜索编号或标题', en: 'Search id or title' },
  'board.matchCount': { zh: '匹配 {matched} / 共 {total}', en: 'Matched {matched} / {total}' },
  'board.noMatch': { zh: '没有匹配的委托', en: 'No matching quests' },
  'board.empty': { zh: '— 空 —', en: '— empty —' },
  'board.archiveLink': { zh: '全部历史在「派出记录」', en: 'Full history in "Dispatch log"' },
  'board.prevPage': { zh: '‹ 上一页', en: '‹ Prev' },
  'board.nextPage': { zh: '下一页 ›', en: 'Next ›' },
  'board.page': { zh: '第 {page}/{total} 页，共 {count} 条', en: 'Page {page}/{total} · {count} entries' },
  'board.noQuests': { zh: '暂无委托', en: 'No quests yet' },

  // — in-tray —
  'inTray.empty': { zh: '没有等你处理的事', en: 'Nothing waiting for you' },
  'inTray.heading': { zh: '待你处理', en: 'Waiting for you' },
  'inTray.eyebrow': { zh: 'IN-TRAY' },
  'inTray.collapse': { zh: '收起', en: 'Collapse' },
  'inTray.more': { zh: '还有 {count} 件', en: '{count} more' },
  'inTray.countLabel': { zh: '共 {count} 件', en: '{count} items' },
  'inTray.kind.sign-off': { zh: '交差', en: 'Verify' },
  'inTray.kind.decide': { zh: '拍板', en: 'Rule' },
  'inTray.kind.release': { zh: '失联', en: 'No signal' },
  'inTray.kind.owner': { zh: '你来', en: 'You' },
  'inTray.stamp.sign-off': { zh: '去验收', en: 'Verify' },
  'inTray.stamp.decide': { zh: '去拍板', en: 'Decide' },
  'inTray.stamp.release': { zh: '去确认', en: 'Confirm' },
  'inTray.stamp.owner': { zh: '去处理', en: 'Handle' },

  // — toasts —
  'toast.guildReceipt': { zh: ' · 公会回执', en: ' · guild receipt' },

  // — roster view —
  'roster.eyebrow': { zh: 'ROSTER (MODELS)' },
  'roster.title': { zh: '冒险者（模型）', en: 'Adventurers (models)' },
  'roster.new': { zh: '＋ 新冒险者', en: '+ New adventurer' },
  'roster.heading': { zh: '公会名册', en: 'Guild roster' },
  'roster.headingFiltered': { zh: '筛出 {visible} / 共 {total}', en: '{visible} of {total}' },
  'roster.hint': {
    zh: '管理当前项目可派工的冒险者。每位冒险者就是一个配置好的模型运行档（模型 + 变体 + 接入方式）。接入方式推断出的冒险者不能直接编辑。',
    en: 'Adventurers this project can dispatch. Each adventurer is one configured model run profile (model + variant + lane). Adventurers inferred from a lane cannot be edited directly.',
  },
  'roster.noProject': {
    zh: '服务器没有提供项目标识：折叠只影响本页，不会被记住，也不会和其他项目串用。',
    en: 'The server did not provide a project id: folding affects this page only, is not remembered, and never mixes with other projects.',
  },
  'roster.toast.statusUpdated': { zh: '已更新「{name}」状态', en: 'Updated the status of “{name}”' },
  'roster.toast.saved': { zh: '已保存冒险者', en: 'Adventurer saved' },
  'roster.toast.added': { zh: '已添加新冒险者', en: 'New adventurer added' },
  'roster.toast.removed': { zh: '已除名「{name}」', en: 'Removed “{name}”' },

  // — roster filters —
  'rosterFilters.groupLabel': { zh: '筛选冒险者', en: 'Filter adventurers' },
  'rosterFilters.search': { zh: '搜索', en: 'Search' },
  'rosterFilters.searchPlaceholder': { zh: '编号 / 名字 / 模型标识', en: 'Id / name / model' },
  'rosterFilters.searchLabel': { zh: '按编号、名字或模型标识搜索冒险者', en: 'Search adventurers by id, name or model' },
  'rosterFilters.provider': { zh: '服务商', en: 'Provider' },
  'rosterFilters.allProviders': { zh: '全部服务商', en: 'All providers' },
  'rosterFilters.lane': { zh: '接入方式', en: 'Lane' },
  'rosterFilters.allLanes': { zh: '全部接入方式', en: 'All lanes' },
  'rosterFilters.status': { zh: '状态', en: 'Status' },
  'rosterFilters.allStatuses': { zh: '全部状态', en: 'All statuses' },
  'rosterFilters.countFiltered': { zh: '显示 {visible} / {total} 位', en: 'Showing {visible} / {total}' },
  'rosterFilters.count': { zh: '共 {total} 位', en: '{total} total' },
  'rosterFilters.clear': { zh: '清除筛选', en: 'Clear filters' },

  // — roster bulk actions —
  'rosterBulk.sectionLabel': { zh: '批量管理冒险者', en: 'Bulk-manage adventurers' },
  'rosterBulk.heading': { zh: '批量管理', en: 'Bulk actions' },
  'rosterBulk.selected': { zh: '已选 {count} 张', en: '{count} selected' },
  'rosterBulk.selectVisible': { zh: '选择可见的（{count}）', en: 'Select visible ({count})' },
  'rosterBulk.selectAllMatching': { zh: '选择全部匹配（{count}）', en: 'Select all matching ({count})' },
  'rosterBulk.clear': { zh: '清空选择', en: 'Clear selection' },
  'rosterBulk.foldedNote': {
    zh: '当前有 {count} 张匹配卡片在折叠组内；“选择可见的”只包含屏幕上打开的行。',
    en: '{count} matching cards are in folded groups; "Select visible" only includes rows open on screen.',
  },
  'rosterBulk.hiddenWarning': {
    zh: '有 {count} 张已选卡片被当前筛选隐藏；批量操作仍会包含它们。',
    en: '{count} selected cards are hidden by the current filter; bulk actions still include them.',
  },
  'rosterBulk.foldedWarning': {
    zh: '有 {count} 张已选卡片在折叠组内；批量操作仍会包含它们。',
    en: '{count} selected cards are inside folded groups; bulk actions still include them.',
  },
  'rosterBulk.pickerLabel': { zh: '选择冒险者', en: 'Select adventurers' },
  'rosterBulk.selectCard': { zh: '选择 {name}', en: 'Select {name}' },
  'rosterBulk.deselectCard': { zh: '取消选择 {id}', en: 'Deselect {id}' },
  'rosterBulk.foldedTag': { zh: '折叠', en: 'Folded' },
  'rosterBulk.hiddenTag': { zh: '已筛选隐藏', en: 'Hidden by filter' },
  'rosterBulk.empty': { zh: '当前筛选没有匹配卡片。', en: 'No cards match the current filter.' },
  'rosterBulk.statusLabel': { zh: '状态', en: 'Status' },
  'rosterBulk.statusFieldLabel': { zh: '批量状态', en: 'Bulk status' },
  'rosterBulk.statusNoChange': { zh: '不修改状态', en: 'Leave status unchanged' },
  'rosterBulk.reasonLabel': { zh: '状态原因', en: 'Status reason' },
  'rosterBulk.reasonFieldLabel': { zh: '批量状态原因', en: 'Bulk status reason' },
  'rosterBulk.reasonPlaceholder': { zh: '选择状态后填写', en: 'Choose a status first' },
  'rosterBulk.variantLabel': { zh: '修改变体', en: 'Change variant' },
  'rosterBulk.variantFieldLabel': { zh: '批量变体', en: 'Bulk variant' },
  'rosterBulk.variantPlaceholder': { zh: '留空＝清除变体', en: 'Blank = clear variant' },
  'rosterBulk.envLabel': { zh: '设置环境变量', en: 'Set env vars' },
  'rosterBulk.envFieldLabel': { zh: '批量设置环境变量', en: 'Bulk set env vars' },
  'rosterBulk.removeEnvLabel': { zh: '移除环境变量', en: 'Remove env vars' },
  'rosterBulk.removeEnvFieldLabel': { zh: '批量移除环境变量', en: 'Bulk remove env vars' },
  'rosterBulk.footerNote': {
    zh: '状态记录与实时通道限额分开显示；暂停是手动决定。',
    en: 'Status records and live-lane limits show separately; pausing is a manual decision.',
  },
  'rosterBulk.previewUpdate': { zh: '预览批量修改', en: 'Preview bulk update' },
  'rosterBulk.deleteSelected': { zh: '删除所选', en: 'Delete selected' },
  'rosterBulk.confirmTitle': { zh: '确认删除 {count} 张卡片？', en: 'Delete {count} selected cards?' },
  'rosterBulk.confirmBody': {
    zh: '这一步只会删除你明确选中的 ID，不会按筛选器临时隐藏的卡片扩大范围。',
    en: 'This deletes only the ids you explicitly selected; it does not widen to cards merely hidden by a filter.',
  },
  'rosterBulk.eyebrowDelete': { zh: 'REMOVE CARDS · 批量删除', en: 'REMOVE CARDS · bulk delete' },
  'rosterBulk.eyebrowPreview': { zh: 'PREFLIGHT · 批量预览', en: 'PREFLIGHT · bulk preview' },
  'rosterBulk.eyebrowResult': { zh: 'RESULT · 批量结果', en: 'RESULT · bulk result' },
  'rosterBulk.previewDelete': { zh: '预览删除', en: 'Preview delete' },
  'rosterBulk.dialogCancel': { zh: '取消', en: 'Cancel' },
  'rosterBulk.neverMind': { zh: '算了', en: 'Never mind' },
  'rosterBulk.continuePreview': { zh: '继续预览删除', en: 'Preview deletion' },
  'rosterBulk.running': { zh: '正在执行…', en: 'Running…' },
  'rosterBulk.confirmDelete': { zh: '确认删除可执行项', en: 'Delete the ready items' },
  'rosterBulk.confirmApply': { zh: '确认批量修改', en: 'Apply bulk update' },
  'rosterBulk.resultTitle': {
    zh: '批量操作结束：{changed} 张改了，{denied} 张被拒绝',
    en: 'Bulk action finished: {changed} changed, {denied} denied',
  },
  'rosterBulk.resultOk': { zh: '知道了', en: 'Got it' },
  'rosterBulk.summaryIds': { zh: '选中 ID', en: 'Selected ids' },
  'rosterBulk.summaryChanged': { zh: '会变化', en: 'Will change' },
  'rosterBulk.summaryPreserved': { zh: '继续保留', en: 'Preserved' },
  'rosterBulk.summaryResult': { zh: '结果', en: 'Result' },
  'rosterBulk.summaryCounts': { zh: '{ready} 张可以改，{denied} 张被拒绝', en: '{ready} can change, {denied} denied' },
  'rosterBulk.deniedTitle': { zh: '正在执行或结果未定，不能改：', en: 'Running or undecided; cannot change:' },
  'rosterBulk.deniedQuotaTitle': { zh: '有限额证据，不能设为空闲：', en: 'Quota evidence stands; cannot set to Idle:' },
  'rosterBulk.itemChange': { zh: '会改：{fields}', en: 'Changes: {fields}' },
  'rosterBulk.toast': {
    zh: '批量操作结束：{changed} 张改了，{unchanged} 张没变，{denied} 张被拒绝，{failed} 张失败，{partial} 张部分完成',
    en: 'Bulk action finished: {changed} changed, {unchanged} unchanged, {denied} denied, {failed} failed, {partial} partial',
  },
  'rosterBulk.resultBreakdown': {
    zh: '{changed} 张改了，{unchanged} 张没变，{denied} 张被拒绝，{failed} 张失败，{partial} 张部分完成',
    en: '{changed} changed, {unchanged} unchanged, {denied} denied, {failed} failed, {partial} partial',
  },
  'rosterBulk.notFinished': { zh: '批量操作未完成：{error}', en: 'Bulk action did not finish: {error}' },
  'rosterBulk.expired': { zh: '这次操作已过期，请重新预览后再试。', en: 'This action expired; preview again before retrying.' },
  'rosterBulk.pickAdventurer': { zh: '先选择至少一位冒险者', en: 'Select at least one adventurer first' },
  'rosterBulk.reasonNeedsStatus': { zh: '状态原因需要先选择状态', en: 'Choose a status before writing a reason' },
  'rosterBulk.pickFields': { zh: '先选择要批量修改的字段', en: 'Choose at least one field to change' },
  'rosterBulk.envFormat': { zh: '环境变量每行写成 NAME=值', en: 'Write one NAME=value per line' },
  'rosterBulk.envBadName': { zh: '变量名 {name} 不是大写下划线格式', en: 'Variable name {name} is not UPPER_SNAKE_CASE' },
  'rosterBulk.envTooMany': { zh: '一次最多设置 10 个环境变量', en: 'At most 10 env vars at a time' },
  'rosterBulk.partial': { zh: '部分写入：已应用 {fields}{reason}', en: 'Partly written: applied {fields}{reason}' },
  'rosterBulk.done': { zh: '已完成：{fields}', en: 'Done: {fields}' },
  'rosterBulk.refused': { zh: '服务器拒绝了这张卡片', en: 'The server refused this card' },
  'rosterBulk.failed': { zh: '操作失败，未报告为成功', en: 'The action failed and was not reported as success' },
  'rosterBulk.fieldNone': { zh: '无', en: 'none' },
  'rosterBulk.statusAvailable': { zh: '空闲', en: 'Idle' },
  'rosterBulk.statusLimited': { zh: '限额', en: 'Limited' },
  'rosterBulk.statusPaused': { zh: '暂停', en: 'Paused' },

  // — OMO section —
  'omo.loading': { zh: '正在读取 OMO 配置…', en: 'Reading OMO config…' },
  'omo.loadFailed': { zh: '读取 OMO 配置失败：{error}', en: 'Could not read OMO config: {error}' },
  'omo.saved': { zh: '已保存（旧文件已备份）', en: 'Saved (old file backed up)' },
  'omo.savedToast': { zh: '已保存 OMO 配置（旧文件已备份）', en: 'OMO config saved (old file backed up)' },
  'omo.colName': { zh: '名称', en: 'Name' },
  'omo.colModel': { zh: '模型 (provider/model)', en: 'Model (provider/model)' },
  'omo.colReasoning': { zh: '思考深度 (reasoning)', en: 'Reasoning depth' },
  'omo.edited': { zh: '已改', en: 'Edited' },
  'omo.modelPlaceholder': { zh: '留空或 provider/model', en: 'Blank or provider/model' },
  'omo.eyebrow': { zh: 'OPENCODE AGENT MODEL CONFIG' },
  'omo.title': { zh: 'OpenCode 代理模型（OMO）', en: 'OpenCode agent models (OMO)' },
  'omo.configFile': { zh: '配置文件：', en: 'Config file:' },
  'omo.readingModels': { zh: '正在读取模型列表…', en: 'Reading the model list…' },
  'omo.refreshing': { zh: '正在刷新…', en: 'Refreshing…' },
  'omo.refreshModels': { zh: '刷新模型列表', en: 'Refresh model list' },
  'omo.saveChanges': { zh: '保存修改 ({count})', en: 'Save changes ({count})' },
  'omo.tableAgents': { zh: '代理 (Agents)', en: 'Agents' },
  'omo.tableCategories': { zh: '分类 (Categories)', en: 'Categories' },

  // — usage view —
  'usage.eyebrow': { zh: 'QUOTA & BALANCES' },
  'usage.title': { zh: '服务商用量', en: 'Provider usage' },
  'usage.loadFailed': { zh: '读取用量报告失败：{error}', en: 'Could not load the usage report: {error}' },
  'usage.unverifiable': {
    zh: '无法核实这份用量数据是否仍属于当前服务器',
    en: 'Cannot verify this usage data still belongs to the current server',
  },
  'usage.autoPaused': { zh: '自动刷新已暂停', en: 'Auto refresh paused' },
  'usage.refreshingData': { zh: '正在刷新用量数据…', en: 'Refreshing usage data…' },
  'usage.scopeWarning': {
    zh: '当前服务器没有提供项目标识，无法保证下面的用量数据只属于这一个项目；切换过服务器后请手动确认。',
    en: 'This server provided no project id, so the usage below cannot be guaranteed to belong to this project alone; confirm by hand after switching servers.',
  },
  'usage.previousResult': { zh: '（下面仍是上一次的结果）', en: '(the numbers below are still the last result)' },
  'usage.readingProject': { zh: '正在读取项目信息…', en: 'Reading project info…' },
  'usage.verifying': {
    zh: '正在核实这份用量数据是否仍属于当前服务器…',
    en: 'Checking whether this usage data still belongs to the current server…',
  },
  'usage.verifyFailed': {
    zh: '无法核实这份用量数据是否仍属于当前服务器，暂不显示；请点击上方“刷新全部”重试。',
    en: 'Cannot verify this usage data still belongs to the current server, so it stays hidden; click "Refresh all" above to retry.',
  },
  'usage.verifyFailedWith': {
    zh: '无法核实这份用量数据是否仍属于当前服务器（{error}），暂不显示；请点击上方“刷新全部”重试。',
    en: 'Cannot verify this usage data still belongs to the current server ({error}), so it stays hidden; click "Refresh all" above to retry.',
  },
  'usage.reading': { zh: '正在读取用量数据…', en: 'Reading usage data…' },
  'usage.empty': { zh: '暂无服务商用量数据', en: 'No provider usage data yet' },

  // — usage controls —
  'usageControls.minutes': { zh: '{count} 分钟', en: '{count} min' },
  'usageControls.seconds': { zh: '{count} 秒', en: '{count} s' },
  'usageControls.refreshAll': { zh: '刷新全部', en: 'Refresh all' },
  'usageControls.paused': { zh: '页面不可见，自动刷新已暂停', en: 'Page hidden; auto refresh paused' },
  'usageControls.interval': { zh: '每 {interval} 自动刷新一次', en: 'Auto refresh every {interval}' },
  'usageControls.manualOnly': { zh: '仅手动刷新', en: 'Manual refresh only' },
  'usageControls.fetchedAt': { zh: '查询于 {time}', en: 'Queried at {time}' },
  'usageControls.updating': { zh: ' · 正在更新…', en: ' · updating…' },
  'usageControls.mode': { zh: '更新方式', en: 'Refresh mode' },
  'usageControls.modeManual': { zh: '手动', en: 'Manual' },
  'usageControls.modeInterval': { zh: '定时', en: 'Interval' },
  'usageControls.intervalLabel': { zh: '间隔', en: 'Interval' },

  // — usage provider card —
  'usageCard.refresh': { zh: '刷新', en: 'Refresh' },
  'usageCard.refreshAria': { zh: '刷新 {name} 的用量', en: 'Refresh usage for {name}' },
  'usageCard.docs': { zh: '打开官方说明', en: 'Open official docs' },
  'usageCard.manualRun': { zh: '手动运行：', en: 'Run manually:' },
  'usageCard.balance': { zh: '余额：', en: 'Balance:' },
  'usageCard.granted': { zh: '赠送 {amount}', en: 'Granted {amount}' },
  'usageCard.toppedUp': { zh: '充值 {amount}', en: 'Topped up {amount}' },
  'usageCard.lastSuccess': { zh: '上次成功 {time}', en: 'Last success {time}' },
  'usageCard.subscribedNoWindows': {
    zh: '已订阅，但当前没有可显示的额度窗口',
    en: 'Subscribed, but there are no quota windows to show right now',
  },

  // — usage provider guidance: the fixed sentences the card shows for a data-layer errorCode (F1) —
  'usageCode.claude_snapshot_unreadable': { zh: '无法读取 Claude 状态栏快照文件，请稍后重试', en: 'Could not read the Claude status-line snapshot file; try again in a moment' },
  'usageCode.claude_snapshot_too_large': { zh: 'Claude 状态栏快照文件超出正常大小，请检查状态栏脚本写出的文件', en: 'The Claude status-line snapshot file is larger than normal; check the file written by the status-line script' },
  'usageCode.claude_snapshot_read_failed': { zh: '读取 Claude 状态栏快照失败，请稍后重试', en: 'Reading the Claude status-line snapshot failed; try again in a moment' },
  'usageCode.claude_snapshot_corrupt': { zh: 'Claude 状态栏快照不是有效的 JSON，请检查状态栏脚本写出的文件', en: 'The Claude status-line snapshot is not valid JSON; check the file written by the status-line script' },
  'usageCode.claude_snapshot_schema': { zh: 'Claude 状态栏快照版本不支持（必须为 schema 1）', en: 'This Claude status-line snapshot version is not supported (must be schema 1)' },
  'usageCode.claude_snapshot_timestamp': { zh: 'Claude 状态栏快照时间戳无效，请检查系统时钟', en: 'The Claude status-line snapshot timestamp is invalid; check the system clock' },
  'usageCode.claude_snapshot_no_rate_limits': { zh: 'Claude 状态栏快照缺少额度数据，请检查状态栏脚本写出的文件', en: 'The Claude status-line snapshot has no quota data; check the file written by the status-line script' },
  'usageCode.claude_snapshot_no_windows': { zh: '快照里没有可用的额度数据，运行一次 Claude Code 后再刷新', en: 'The snapshot has no usable quota data; run Claude Code once and refresh again' },

  // — settings view —
  'settings.localNote': {
    zh: '本机信息与用量密钥只读检查，不会写入项目配置。',
    en: 'Machine info and usage keys are read-only checks; nothing is written to the project config.',
  },
  'settings.saveSuccess': {
    zh: '已保存（旧文件已备份）· 重启看板后生效',
    en: 'Saved (old file backed up) · takes effect after the board restarts',
  },
  'settings.loading': { zh: '正在读取系统配置…', en: 'Reading system configuration…' },
  'settings.loadFailed': { zh: '读取系统设置失败：{error}', en: 'Could not read system settings: {error}' },
  'settings.empty': { zh: '未能获取系统配置', en: 'Could not load system configuration' },
  'settings.eyebrow': { zh: 'SYSTEM CONFIGURATION' },
  'settings.title': { zh: '系统设置', en: 'System settings' },
  'settings.group.project': { zh: '项目与文件', en: 'Project & files' },
  'settings.group.lanes': { zh: '接入方式', en: 'Lanes' },
  'settings.group.policy': { zh: '派遣规则', en: 'Dispatch rules' },
  'settings.group.verification': { zh: '项目验证', en: 'Project verification' },
  'settings.group.local': { zh: '本机与连接', en: 'Local & connections' },
  'settings.saveFailed': { zh: '保存失败：{error}', en: 'Save failed: {error}' },
  'settings.dirty': { zh: '存在未保存的修改', en: 'Unsaved changes' },
  'settings.synced': { zh: '设置已同步', en: 'Settings in sync' },
  'settings.restartHint': { zh: '需重启看板后生效', en: 'Takes effect after the board restarts' },
  'settings.discard': { zh: '放弃未保存修改', en: 'Discard changes' },
  'settings.save': { zh: '保存项目设置', en: 'Save project settings' },

  // — settings · local section —
  'settingsLocal.title': { zh: '本机 (Local Environment)', en: 'Local environment' },
  'settingsLocal.homeDir': { zh: 'Questboard 主目录', en: 'Questboard home' },
  'settingsLocal.roster': { zh: '名册文件', en: 'Roster file' },
  'settingsLocal.rosterMissing': { zh: '（还没有名册）', en: '(no roster yet)' },
  'settingsLocal.rosterPresent': { zh: '（已存在）', en: '(exists)' },
  'settingsLocal.statusLog': { zh: '状态日志', en: 'Status log' },
  'settingsLocal.openCodeAuth': { zh: 'OpenCode 登录文件', en: 'OpenCode auth file' },
  'settingsLocal.fileMissing': { zh: '（不存在）', en: '(missing)' },
  'settingsLocal.omoFile': { zh: 'OMO 配置文件', en: 'OMO config file' },
  'settingsLocal.locale': { zh: '界面语言', en: 'Interface language' },
  'settingsLocal.localeNote': {
    zh: '只改看板自己的界面文字；委托、简报和模型回复保持原样。存在本机浏览器里，不写入项目配置。',
    en: "Changes only the board's own interface text; quests, briefs and model replies stay as written. Stored in this browser, never in the project config.",
  },

  // — roster table (RosterCardTable) —
  'rosterTable.empty': { zh: '名册中暂无冒险者', en: 'The roster has no adventurers yet' },
  'rosterTable.noMatch': {
    zh: '没有符合条件的冒险者（共 {count} 位），换个搜索词或清除筛选试试。',
    en: 'No adventurers match ({count} in total); try another word or clear the filters.',
  },
  'rosterTable.jumpLabel': { zh: '按服务商跳转', en: 'Jump to a provider' },
  'rosterTable.chipTitle': {
    zh: '跳到 {provider}：{count} 张，空闲 {available}',
    en: 'Jump to {provider}: {count} cards, {available} idle',
  },
  'rosterTable.colName': { zh: '冒险者', en: 'Adventurer' },
  'rosterTable.colLane': { zh: '接入方式', en: 'Lane' },
  'rosterTable.colModel': { zh: '模型 / 代理', en: 'Model / agent' },
  'rosterTable.colBilling': { zh: '计费', en: 'Billing' },
  'rosterTable.colParallel': { zh: '并发', en: 'Parallel' },
  'rosterTable.colStrengths': { zh: '专长', en: 'Strengths' },
  'rosterTable.colStatus': { zh: '状态', en: 'Status' },
  'rosterTable.colActions': { zh: '操作', en: 'Actions' },
  'rosterTable.matchedPrefix': { zh: '筛出 ', en: 'matched ' },
  'rosterTable.providerCount': { zh: '{count} 张 · 空闲 {available}', en: '{count} cards · {available} idle' },

  // — roster row (RosterCardRow) —
  'rosterRow.derivedHint': {
    zh: '状态由接入方式证据推断得出，卡片本身仍在名册里',
    en: 'Status inferred from lane evidence; the card itself stays in the roster',
  },
  'rosterRow.nameTitle': {
    zh: '冒险者：{name}（{provider} · {lane}）',
    en: 'Adventurer: {name} ({provider} · {lane})',
  },
  'rosterRow.noProvider': { zh: '未填服务商', en: 'no provider' },
  'rosterRow.idTitle': { zh: '编号：{id}', en: 'Id: {id}' },
  'rosterRow.modelTitle': { zh: '模型标识：{model}', en: 'Model id: {model}' },
  'rosterRow.fullModelTitle': { zh: '完整模型标识：{model}{variant}', en: 'Full model id: {model}{variant}' },
  'rosterRow.variantSuffix': { zh: '（变体 {variant}）', en: ' (variant {variant})' },
  'rosterRow.baseStatus': { zh: '基础状态：{status}', en: 'Base status: {status}' },
  'rosterRow.since': { zh: '{date} 起', en: 'since {date}' },
  'rosterRow.baseReason': { zh: '基础原因：{reason}', en: 'Base reason: {reason}' },
  'rosterRow.resetUnknown': { zh: '（重置时间未知）', en: ' (reset time unknown)' },
  // Round 3: a legacy card whose saved env now breaks the deny policy still shows on the board with this
  // note (src/core/roster.js envPolicyViolation); it is refused for dispatch instead of being stripped.
  'rosterRow.envPolicy': { zh: '名册问题：{reason}', en: 'Roster issue: {reason}' },
  'rosterRow.setStatus': { zh: '改状态', en: 'Set status' },
  'rosterRow.edit': { zh: '编辑', en: 'Edit' },
  'rosterRow.duplicateHint': {
    zh: '照这位冒险者再开一位，只改要改的',
    en: 'Open another adventurer from this one; change only what you need',
  },
  'rosterRow.duplicate': { zh: '复制', en: 'Duplicate' },
  'rosterRow.remove': { zh: '删除', en: 'Delete' },

  // — roster form modal —
  'rosterForm.eyebrowNew': { zh: 'NEW ADVENTURER · 录入档案', en: 'NEW ADVENTURER · new record' },
  'rosterForm.eyebrowDuplicate': {
    zh: 'DUPLICATE ADVENTURER · 照着再开一位',
    en: 'DUPLICATE ADVENTURER · copy one',
  },
  'rosterForm.eyebrowEdit': { zh: 'EDIT ADVENTURER · 修改档案', en: 'EDIT ADVENTURER · edit record' },
  'rosterForm.titleNew': { zh: '新冒险者', en: 'New adventurer' },
  'rosterForm.titleDuplicate': { zh: '复制「{name}」', en: 'Copy “{name}”' },
  'rosterForm.titleEdit': { zh: '编辑「{name}」', en: 'Edit “{name}”' },
  'rosterForm.duplicateIdError': {
    zh: '复制出来的 ID 要和原冒险者不同，否则会覆盖原来那位',
    en: 'The copied id must differ from the original adventurer, or it would overwrite it',
  },
  'rosterForm.idLabel': {
    zh: 'ID（小写字母、数字、连字符{mutable}）',
    en: 'ID (lowercase letters, digits, dashes{mutable})',
  },
  'rosterForm.idNotEditable': { zh: '，不可修改', en: ', not editable' },
  'rosterForm.idPlaceholder': { zh: '例如 my-model-v1', en: 'e.g. my-model-v1' },
  'rosterForm.duplicateHint': {
    zh: '照「{name}」复制，其余字段都填好了；改完 ID 和名称就能入册。',
    en: 'Copied from “{name}”; the other fields are filled in — change the id and name and it is ready.',
  },
  'rosterForm.name': { zh: '名称', en: 'Name' },
  'rosterForm.namePlaceholder': { zh: '例如 我的模型', en: 'e.g. My Model' },
  'rosterForm.provider': { zh: '服务商', en: 'Provider' },
  'rosterForm.providerPlaceholder': { zh: '例如 my-provider', en: 'e.g. my-provider' },
  'rosterForm.lane': { zh: '接入方式', en: 'Lane' },
  'rosterForm.family': { zh: '系列', en: 'Family' },
  'rosterForm.familyPlaceholder': { zh: '例如 my-model', en: 'e.g. my-model' },
  'rosterForm.model': { zh: '模型', en: 'Model' },
  'rosterForm.modelPlaceholder': { zh: '例如 my-model', en: 'e.g. my-model' },
  'rosterForm.variant': { zh: '变体（可选）', en: 'Variant (optional)' },
  'rosterForm.variantPlaceholder': { zh: '例如 reasoning', en: 'e.g. reasoning' },
  'rosterForm.variants': { zh: '支持的变体（可选）', en: 'Supported variants (optional)' },
  'rosterForm.variantsUnknown': { zh: '不填：还没确认', en: 'Blank: not confirmed yet' },
  'rosterForm.variantsNone': { zh: '空列表：不支持任何变体', en: 'Empty list: no variants supported' },
  'rosterForm.variantsList': { zh: '列出支持的变体', en: 'List supported variants' },
  'rosterForm.variantsPlaceholder': { zh: '例如 low, medium, high', en: 'e.g. low, medium, high' },
  'rosterForm.variantsHint': {
    zh: '不填＝还没确认；空列表＝不支持任何变体；列出后只支持这些值。',
    en: 'Blank = not confirmed yet; empty list = no variants supported; once listed, only those values are supported.',
  },
  'rosterForm.variantsConfirmEmpty': {
    zh: '保存后这张卡不支持任何变体',
    en: 'Save this card as supporting no variants',
  },
  'rosterForm.agent': { zh: '代理（可选）', en: 'Agent (optional)' },
  'rosterForm.agentPlaceholder': { zh: '例如 my-agent', en: 'e.g. my-agent' },
  'rosterForm.billing': { zh: '计费模式', en: 'Billing mode' },
  'rosterForm.billingUnset': { zh: '未指定', en: 'Unspecified' },
  'rosterForm.maxParallel': { zh: '最大并发', en: 'Max parallel' },
  'rosterForm.strengths': { zh: '专长（英文逗号分隔）', en: 'Strengths (comma-separated)' },
  'rosterForm.strengthsPlaceholder': { zh: '例如 code, refactor, review', en: 'e.g. code, refactor, review' },
  'rosterForm.notes': { zh: '备注（最多300字）', en: 'Notes (300 chars max)' },
  'rosterForm.notesPlaceholder': { zh: '使用说明或特性记录...', en: 'Usage notes or feature records…' },
  'rosterForm.env': {
    zh: '环境变量（可选，每行 NAME=值；不要放密钥）',
    en: 'Environment variables (optional, one NAME=value per line; never secrets)',
  },
  'rosterForm.envPlaceholder': {
    zh: 'OPENAI_BASE_URL=https://api.example.com/v1\n# 密钥请放系统环境变量，接入方式命令会继承',
    en: 'OPENAI_BASE_URL=https://api.example.com/v1\n# keep secrets in system env vars; lane commands inherit them',
  },
  'rosterForm.submitting': { zh: '正在登记…', en: 'Saving…' },
  'rosterForm.submitNew': { zh: '入册', en: 'Add to roster' },
  'rosterForm.submitSave': { zh: '盖章保存', en: 'Save' },

  // — roster delete modal —
  'rosterDelete.eyebrow': { zh: 'REMOVE CARD · 除名', en: 'REMOVE CARD · remove' },
  'rosterDelete.title': { zh: '确认除名「{name}」？', en: 'Remove “{name}”?' },
  'rosterDelete.bodyPrefix': { zh: '冒险者 ', en: 'Adventurer ' },
  'rosterDelete.bodySuffix': { zh: ' 将从名册中移除。', en: ' will be removed from the roster.' },
  'rosterDelete.submitting': { zh: '正在注销…', en: 'Removing…' },
  'rosterDelete.confirm': { zh: '确认除名', en: 'Remove' },

  // — shared bits —
  'common.neverMind': { zh: '算了', en: 'Never mind' },

  // — history (Dispatch log) —
  'history.eyebrow': { zh: 'DISPATCH LOG' },
  'history.title': { zh: '派出记录', en: 'Dispatch log' },
  'history.lanesTimeout': { zh: '联络接入方式超时', en: 'Contacting lanes timed out' },
  'history.clearedOwner': { zh: '这张卡已不算限额', en: 'this card is no longer counted as limited' },
  'history.clearedStatus': { zh: '该卡片状态已改变', en: 'this card changed status' },
  'history.clearedNoCard': { zh: '名册里已经没有这张卡', en: 'this card is no longer in the roster' },
  'history.evidenceExpired': { zh: '已过期或对不上具体卡的证据', en: 'expired evidence or evidence not matching a specific card' },
  'history.unknownSource': { zh: '未知来源', en: 'unknown source' },
  'history.limitUntil': { zh: '，{until} 恢复', en: ', resets {until}' },
  'history.updatedAt': { zh: '更新于 {time}', en: 'Updated {time}' },
  'history.noSuccessYet': { zh: '尚无成功结果', en: 'no successful read yet' },
  'history.loading': { zh: '加载中…', en: 'loading…' },
  'history.refreshFailed': { zh: ' · 刷新失败：{error}', en: ' · refresh failed: {error}' },
  'history.stillPrevious': { zh: '，仍显示上一次的结果', en: ', still showing the previous result' },
  'history.notReadYet': { zh: '（派出详情和项目测试还没有读到）', en: '(dispatch details and project tests have not been read yet)' },
  'history.openQuestions': { zh: '待答问题 {count}', en: 'Open questions {count}' },
  'history.laneLimited': { zh: '{lane} 限额中（{since} 起{until}）', en: '{lane} limited (since {since}{until})' },
  'history.clearedEvidenceAria': { zh: '已过期或对不上具体卡的限额证据', en: 'expired lane-limit evidence or evidence not matching a specific card' },
  'history.eventsTitle': { zh: '事件时间线', en: 'Event timeline' },
  'history.eventsEyebrow': { zh: 'EVENT TIMELINE' },
  'history.loadMore': { zh: '继续加载', en: 'Load more' },
  'history.refreshNew': { zh: '刷新新事件', en: 'Refresh new events' },
  'history.rereadAll': { zh: '全部重新读取', en: 'Reread all' },
  'history.rereadFromStart': { zh: '从头重新读取', en: 'Reread from the start' },
  'history.rereadExplain': {
    zh: '从头重新读取整个事件日志：已经加载的部分也会重新请求一次，比继续加载或刷新新事件慢',
    en: 'Reads the whole event log again from the start: parts already loaded are fetched again too, slower than Load more or Refresh new events',
  },
  'history.eventsFailed': { zh: '事件读取失败：{error}', en: 'Could not read events: {error}' },
  'history.retry': { zh: '重试', en: 'Retry' },
  'history.eventsEmpty': { zh: '事件文件还没有任何记录。', en: 'The event file has no records yet.' },
  'history.noMatch': { zh: '没有符合条件的记录（在已读取的 {count} 条里）。', en: 'No records match (of the {count} read).' },
  'history.clearFilters': { zh: '清除筛选', en: 'Clear filters' },
  'history.workersAria': { zh: '派出详情', en: 'Dispatch details' },
  'history.workersEyebrow': { zh: 'WORKER SUMMARY' },
  'history.workersTitle': { zh: '派出详情（每个工人的近况）', en: 'Dispatch details (how each worker is doing)' },
  'history.colQuest': { zh: '委托', en: 'Quest' },
  'history.colLane': { zh: '接入方式', en: 'Lane' },
  'history.colModel': { zh: '模型', en: 'Model' },
  'history.colState': { zh: '状态', en: 'State' },
  'history.colElapsed': { zh: '运行时长', en: 'Elapsed' },
  'history.colEdits': { zh: '编辑次数', en: 'Edits' },
  'history.colLastText': { zh: '最近一句话', en: 'Last words' },
  'history.colId': { zh: '编号', en: 'Id' },
  'history.noPackages': { zh: '暂无派出记录', en: 'No dispatches yet' },
  'history.lanesFailed': { zh: '读取失败，暂时无法显示', en: 'Read failed; cannot show it right now' },
  'history.staleRows': { zh: ' 三天前的记录 ({count})', en: ' records older than three days ({count})' },

  // — history row —
  'historyRow.noModel': { zh: '未记录', en: 'not recorded' },
  'historyRow.sourceInferred': { zh: '（推断）', en: '(inferred)' },
  'historyRow.sourceSession': { zh: '（从会话恢复）', en: '(restored from session)' },
  'historyRow.fullOutput': { zh: '完整输出', en: 'Full output' },
  'historyRow.noOutput': { zh: '（无输出）', en: '(no output)' },
  'historyRow.tokens': { zh: 'Tokens: 输入 {input} / 输出 {output}', en: 'Tokens: in {input} / out {output}' },
  'historyRow.tools': { zh: '工具: {list}', en: 'Tools: {list}' },
  'historyRow.dispatchHistory': { zh: '派出历史', en: 'Dispatch history' },

  // — history events timeline —
  'historyEvents.collapse': { zh: '收起', en: 'Collapse' },
  'historyEvents.expand': { zh: '展开全文', en: 'Show full text' },
  'historyEvents.badTimeTitle': { zh: '这条记录自身的时间无法识别', en: 'this record has an unrecognizable time' },
  'historyEvents.badTime': { zh: '⚠ 时间未识别', en: '⚠ time unrecognized' },
  'historyEvents.byAuthor': { zh: '由 {author}', en: 'by {author}' },
  'historyEvents.taskAria': { zh: '任务 {key}', en: 'Task {key}' },
  'historyEvents.recordCount': { zh: '{count} 条记录', en: '{count} records' },
  'historyEvents.span': { zh: '{start} 起 → {end}', en: 'from {start} → {end}' },

  // — history filter bar —
  'historyFilters.groupLabel': { zh: '筛选事件记录', en: 'Filter event records' },
  'historyFilters.quest': { zh: '委托', en: 'Quest' },
  'historyFilters.questPlaceholder': { zh: '委托编号包含的文字', en: 'text in the quest id' },
  'historyFilters.lane': { zh: '接入方式', en: 'Lane' },
  'historyFilters.allLanes': { zh: '全部接入方式', en: 'All lanes' },
  'historyFilters.statusKind': { zh: '委托状态记录（系统）', en: 'Quest status records (system)' },
  'historyFilters.model': { zh: '模型', en: 'Model' },
  'historyFilters.allModels': { zh: '全部模型', en: 'All models' },
  'historyFilters.kind': { zh: '事件类型', en: 'Event kind' },
  'historyFilters.allKinds': { zh: '全部类型', en: 'All kinds' },
  'historyFilters.from': { zh: '开始时间', en: 'From' },
  'historyFilters.to': { zh: '结束时间（含该分钟）', en: 'Until (inclusive)' },
  'historyFilters.matched': { zh: '符合条件 {matched} / 已加载 {loaded} 条', en: 'Matched {matched} / {loaded} loaded' },
  'historyFilters.loaded': { zh: '已加载 {loaded} 条事件', en: '{loaded} events loaded' },
  'historyFilters.onlyInvalidOn': { zh: '只看时间无法识别的记录（共 {count} 条）', en: 'Only records with unrecognizable time ({count})' },
  'historyFilters.invalidNote': {
    zh: '其中 {count} 条时间无法识别，不参与时间筛选判断，仍在下方列表中',
    en: '{count} records have an unrecognizable time: they skip the time filter but stay in the list below',
  },
  'historyFilters.showAll': { zh: '显示全部记录', en: 'Show all records' },
  'historyFilters.showOnlyInvalid': { zh: '只看这些记录', en: 'Show only these' },

  // — project tests —
  'projectTests.overallPass': { zh: '通过', en: 'Pass' },
  'projectTests.overallFail': { zh: '有失败项', en: 'Has failures' },
  'projectTests.overallRunning': { zh: '进行中', en: 'Running' },
  'projectTests.linePass': { zh: '通过', en: 'pass' },
  'projectTests.lineFail': { zh: '失败', en: 'fail' },
  'projectTests.lineDone': { zh: '跑完', en: 'done' },
  'projectTests.readFailed': { zh: '读取失败，暂时无法显示。', en: 'Read failed; cannot show it right now.' },
  'projectTests.notConfigured': {
    zh: '这个项目没有配置验证进度文件，暂无可展示的测试结果。',
    en: 'This project has no verification progress file; there are no test results to show.',
  },
  'projectTests.title': { zh: '项目测试', en: 'Project tests' },
  'projectTests.eyebrow': { zh: 'PROJECT TESTS' },
  'projectTests.titleLatest': { zh: '项目测试 · 最新全量结果', en: 'Project tests · latest full run' },
  'projectTests.asOf': { zh: '截至 {time}', en: 'as of {time}' },
  'projectTests.passedCount': { zh: '{passed}/{total} 通过', en: '{passed}/{total} passed' },
  'projectTests.note': {
    zh: '这是整个项目最近一次验证的结果，只能说明项目当前的状态，不能作为任何一个委托完成的证明。',
    en: 'This is the latest verification of the whole project: it describes the project state, never proof that any single quest is done.',
  },
  // — threads —
  'threads.eyebrow': { zh: 'TOPICS' },
  'threads.newButton': { zh: '+ 新主题', en: '+ New topic' },
  'threads.searchPlaceholder': { zh: '搜索主题...', en: 'Search topics...' },
  'threads.trashAllStatuses': { zh: '回收站显示全部状态', en: 'Bin shows all statuses' },
  'threads.filterOpen': { zh: '开放', en: 'Open' },
  'threads.filterAll': { zh: '全部', en: 'All' },
  'threads.filterClosed': { zh: '已关闭', en: 'Closed' },
  'threads.trashHeading': { zh: '回收站（可还原）', en: 'Recycle bin (restorable)' },
  'threads.listHeading': { zh: '主题列表', en: 'Topic list' },
  'threads.backToList': { zh: '返回主题列表', en: 'Back to topics' },
  'threads.openTrash': { zh: '打开回收站', en: 'Open recycle bin' },
  'threads.loading': { zh: '加载中…', en: 'Loading…' },
  'threads.trashEmpty': { zh: '回收站是空的', en: 'The recycle bin is empty' },
  'threads.listEmpty': { zh: '还没有主题', en: 'No topics yet' },
  'threads.selectAria': { zh: '选择主题：{title}', en: 'Select topic: {title}' },
  'threads.unreadTitle': { zh: '有新消息', en: 'New messages' },
  'threads.messageCount': { zh: '{count} 条', en: '{count} msgs' },
  'threads.bulkCap': { zh: '一次最多选择 {max} 个主题，已达上限，请先取消部分勾选', en: 'At most {max} topics at once; deselect some first' },
  'threads.switchLoading': { zh: '主题切换中，请稍候', en: 'Switching topics, please wait' },
  'threads.pickOne': { zh: '选一个主题，或者开一个新的', en: 'Pick a topic, or start a new one' },
  'threads.paneTrashed': { zh: '在回收站中', en: 'In the recycle bin' },
  'threads.paneClosed': { zh: '已关闭', en: 'Closed' },
  'threads.tagsPrefix': { zh: ' · 标签：', en: ' · Tags: ' },
  'threads.restoreOut': { zh: '还原出回收站', en: 'Restore from recycle bin' },
  'threads.unpin': { zh: '取消置顶', en: 'Unpin' },
  'threads.pin': { zh: '置顶', en: 'Pin' },
  'threads.reopen': { zh: '重新打开', en: 'Reopen' },
  'threads.close': { zh: '关闭', en: 'Close' },
  'threads.trashNote': { zh: '此主题在回收站里（消息都还在，还原后保持原样继续）。', en: 'This topic is in the recycle bin (its messages are kept; restore it to continue as it was).' },
  'threads.restoreThis': { zh: '还原此主题', en: 'Restore this topic' },
  'threads.closedTape': { zh: '此主题已关闭', en: 'This topic is closed' },
  'threads.yourName': { zh: '你的名字：', en: 'Your name: ' },
  'threads.namePlaceholder': { zh: '你的昵称', en: 'Your nickname' },
  'threads.ctrlEnter': { zh: 'Ctrl + Enter 发送', en: 'Ctrl + Enter to send' },
  'threads.replyPlaceholder': { zh: '写下回复...', en: 'Write a reply...' },
  'threads.sending': { zh: '发送中…', en: 'Sending…' },
  'threads.sendReply': { zh: '发送回复', en: 'Send reply' },

  // — threads: new topic form —
  'threadsForm.authorRequired': { zh: '请填写你的名字', en: 'Please fill in your name' },
  'threadsForm.eyebrow': { zh: 'NEW THREAD · 新主题', en: 'NEW THREAD' },
  'threadsForm.title': { zh: '发起新讨论', en: 'Start a new discussion' },
  'threadsForm.authorLabel': { zh: '你的名字', en: 'Your name' },
  'threadsForm.titleLabel': { zh: '标题', en: 'Title' },
  'threadsForm.titlePlaceholder': { zh: '讨论主题标题', en: 'Discussion title' },
  'threadsForm.firstMessage': { zh: '第一条消息', en: 'First message' },
  'threadsForm.bodyPlaceholder': { zh: '输入消息内容...', en: 'Type the message...' },
  'threadsForm.tagsLabel': { zh: '标签', en: 'Tags' },
  'threadsForm.tagsHint': { zh: '（逗号分隔）', en: ' (comma separated)' },
  'threadsForm.tagsPlaceholder': { zh: '如：research, playtest', en: 'e.g. research, playtest' },
  'threadsForm.cancel': { zh: '取消', en: 'Cancel' },
  'threadsForm.publishing': { zh: '发布中…', en: 'Publishing…' },
  'threadsForm.publish': { zh: '发布主题', en: 'Publish topic' },

  // — threads: trash confirm dialog —
  'threadsTrash.eyebrow': { zh: 'CONFIRM · 确认删除', en: 'CONFIRM · DELETE' },
  'threadsTrash.title': { zh: '把这 {count} 个主题放入回收站？', en: 'Move these {count} topics to the recycle bin?' },
  'threadsTrash.listAria': { zh: '将被放入回收站的主题', en: 'Topics to be moved to the recycle bin' },
  'threadsTrash.more': { zh: '…另有 {count} 个', en: '…and {count} more' },
  'threadsTrash.cancel': { zh: '取消', en: 'Cancel' },
  'threadsTrash.confirm': { zh: '确认放入回收站（{count} 个）', en: 'Move to recycle bin ({count})' },

  // — threads: bulk bar —
  'threadsBulk.limit': { zh: '（已达单次上限 {max} 个）', en: ' (single-run cap {max} reached)' },
  'threadsBulk.groupLabel': { zh: '批量操作', en: 'Bulk actions' },
  'threadsBulk.selectVisible': { zh: '选中可见', en: 'Select visible' },
  'threadsBulk.clear': { zh: '清除', en: 'Clear' },
  'threadsBulk.count': { zh: '已选 {selected} / 可见 {visible}', en: 'Selected {selected} / visible {visible}' },
  'threadsBulk.restoreSelected': { zh: '还原所选', en: 'Restore selected' },
  'threadsBulk.close': { zh: '关闭', en: 'Close' },
  'threadsBulk.reopen': { zh: '重新打开', en: 'Reopen' },
  'threadsBulk.pin': { zh: '置顶', en: 'Pin' },
  'threadsBulk.unpin': { zh: '取消置顶', en: 'Unpin' },
  'threadsBulk.delete': { zh: '删除', en: 'Delete' },
  'threadsBulk.busy': { zh: '批量操作处理中…', en: 'Bulk action in progress…' },

  // — threads: write operations —
  'threadsWrite.missingAuthor': { zh: '请先填写你的名字', en: 'Please fill in your name first' },
  'threadsWrite.pickSome': { zh: '请先勾选要操作的主题', en: 'Tick the topics to act on first' },
  'threadsWrite.tooMany': { zh: '一次最多处理 {max} 个主题，请减少选择', en: 'At most {max} topics per run; select fewer' },
  // — settings: shell, nav, small sections —
  'settingsNav.aria': { zh: '设置分组', en: 'Settings groups' },
  'settingsNav.heading': { zh: '设置分组', en: 'Settings groups' },
  'settingsNav.hint.project': { zh: '项目、简报、评审页', en: 'Project, briefs, review pages' },
  'settingsNav.hint.lanes': { zh: '接入方式与运行参数', en: 'Lanes and run arguments' },
  'settingsNav.hint.policy': { zh: '规则与限制', en: 'Rules and limits' },
  'settingsNav.hint.verification': { zh: '交付后验证钩子', en: 'Post-delivery verification hooks' },
  'settingsNav.hint.local': { zh: '检查与用量来源', en: 'Checks and usage sources' },
  'laneServer.pending': { zh: '保存并重启看板后，这里会显示服务是否在运行', en: 'Save and restart the board to see whether the service is running' },
  'laneServer.up': { zh: '服务在运行', en: 'Service is running' },
  'laneServer.down': { zh: '服务没开，派到这种接入方式的委托会失败', en: 'Service is down; quests dispatched to this lane will fail' },
  'laneServer.starting': { zh: '正在启动…', en: 'Starting…' },
  'laneServer.start': { zh: '一键启动服务', en: 'Start the service' },
  'laneServer.noServe': { zh: '下面填上启动命令，保存并重启看板后就能一键启动', en: 'Fill in the serve command below; save and restart the board to start it from here' },
  'settingsReview.title': { zh: '评审页 (Review)', en: 'Review pages' },
  'settingsReview.label': { zh: '评审页面目录 (reviewPages.dir)', en: 'Review pages directory (reviewPages.dir)' },
  'settingsReview.clearHint': { zh: '（留空将移除整项评审页配置）', en: '(leaving it empty removes the review-pages config)' },
  'settingsReview.placeholder': { zh: '例如 docs/review', en: 'e.g. docs/review' },
  'settingsReview.resolvedPrefix': { zh: '解析绝对路径：', en: 'Resolved path: ' },
  'settingsReview.notSet': { zh: '当前未设置', en: 'Not set' },
  'settingsUsageKeys.title': { zh: '用量密钥 (Usage Keys)', en: 'Usage keys' },
  'settingsUsageKeys.note': { zh: 'key 只在服务器内存里用，不会显示也不会保存.', en: 'Keys live in server memory only; they are never shown or saved.' },
  'settingsUsageKeys.envPrefix': { zh: '环境变量 {name}', en: 'Env var {name}' },
  'settingsUsageKeys.authPrefix': { zh: 'OpenCode 登录 {name}', en: 'OpenCode login {name}' },
  'settingsBriefs.title': { zh: '简报 (Briefs)', en: 'Briefs' },
  'settingsBriefs.dispatchDirs': { zh: '派出目录（逗号分隔）', en: 'Dispatch dirs (comma-separated)' },
  'settingsBriefs.ownerDirs': { zh: '负责人目录（逗号分隔）', en: 'Owner dirs (comma-separated)' },
  'settingsBriefs.packagePattern': { zh: '委托包正则模式 (packagePattern)', en: 'Package pattern (packagePattern)' },
  'settingsBriefs.fileListHeading': { zh: '文件列表标题正则 (fileListHeading)', en: 'File-list heading regex (fileListHeading)' },
  'settingsBriefs.recentDays': { zh: '简报窗口天数 (recentDays)', en: 'Brief window days (recentDays)' },
  'settingsProject.title': { zh: '项目 (Project)', en: 'Project' },
  'settingsProject.name': { zh: '项目名称', en: 'Project name' },
  'settingsProject.namePlaceholder': { zh: '例如 My Game', en: 'e.g. My Game' },
  'settingsProject.port': { zh: '服务端口', en: 'Server port' },
  'settingsProject.dataDir': { zh: '数据目录 (dataDir)', en: 'Data directory (dataDir)' },
  'settingsProject.events': { zh: '事件日志 (events)', en: 'Events file (events)' },
  'settingsProject.registry': { zh: '注册表 (registry)', en: 'Registry (registry)' },
  'settingsProject.lockFile': { zh: '文件锁 (lockFile)', en: 'Lock file (lockFile)' },
  'settingsProject.bash': { zh: 'Shell 路径 (bash - 可选)', en: 'Shell path (bash - optional)' },
  'settingsProject.bashPlaceholder': { zh: '例如 C:\\Program Files\\Git\\bin\\bash.exe 或 /bin/bash', en: 'e.g. C:\\Program Files\\Git\\bin\\bash.exe or /bin/bash' },
  'settingsProject.resolved': { zh: '解析绝对路径：', en: 'Resolved path: ' },
  'settingsLanes.title': { zh: '接入方式 (Lanes)', en: 'Lanes' },
  'settingsLanes.loadFailed': { zh: '读不到服务状态：{error}', en: 'Cannot read service status: {error}' },
  'settingsLanes.started': { zh: '已启动，服务在运行', en: 'Started; the service is running' },
  'settingsLanes.alreadyUp': { zh: '服务本来就在运行', en: 'The service was already running' },
  'settingsLanes.startFailed': { zh: '没启动成功：{error}', en: 'Could not start it: {error}' },
  'settingsLanes.add': { zh: '+ 添加接入方式', en: '+ Add lane' },
  'notifications.title': { zh: '桌面通知 (Desktop Notifications)', en: 'Desktop notifications' },
  'notifications.permissionLine': { zh: '通知权限：', en: 'Notification permission: ' },
  'notifications.permission.unsupported': { zh: '浏览器不支持', en: 'Not supported by this browser' },
  'notifications.permission.default': { zh: '未询问', en: 'Not asked yet' },
  'notifications.permission.granted': { zh: '已允许', en: 'Allowed' },
  'notifications.permission.denied': { zh: '已拒绝（在浏览器设置里改）', en: 'Denied (change it in browser settings)' },
  'notifications.notAsked': { zh: '还没申请权限，先点下面的按钮向浏览器申请。', en: 'Permission has not been asked yet; use the button below to ask the browser.' },
  'notifications.deniedHelp': { zh: '浏览器拒绝了通知权限，想开启的话只能去浏览器的设置里改。', en: 'The browser denied notification permission; to turn it on, change it in the browser settings.' },
  'notifications.readingProject': { zh: '正在读取项目', en: 'Reading the project' },
  'notifications.unsupported': { zh: '这个浏览器没有桌面通知功能，看板上的提示还在，只是不会弹系统通知。', en: 'This browser has no desktop notifications; board messages still show, they just will not pop up.' },
  'notifications.boardUnsupported': { zh: '此版本的看板不支持', en: 'This board version does not support it' },
  'notifications.noProjectId': { zh: '这个看板没有提供项目标识，没法按项目记住这台设备的通知设置，因此桌面通知暂时不能开启。', en: 'The board has no project id, so this device\u2019s notification settings cannot be stored per project; desktop notifications stay off.' },
  'notifications.request': { zh: '开启通知', en: 'Turn on notifications' },
  'notifications.enable': { zh: '启用桌面通知', en: 'Enable desktop notifications' },
  'notifications.note': { zh: '只对这台设备的这个浏览器生效；权限由浏览器控制，工程设置不能代替你开启。通知里只有任务编号、标题和状态，没有交付内容。', en: 'Applies to this browser on this device only; the browser controls the permission and project settings cannot grant it. Notifications carry only quest id, title and status — never delivery contents.' },
  // — settings: ban rules & policy —
  'banRule.modeExact': { zh: '名称完全等于', en: 'Name equals' },
  'banRule.modeContains': { zh: '名称包含', en: 'Name contains' },
  'banRule.modeStartsWith': { zh: '名称以……开头', en: 'Name starts with' },
  'banRule.modeRegex': { zh: '高级：正则', en: 'Advanced: regex' },
  'banRule.nameFallback': { zh: '未命名冒险者', en: 'Unnamed adventurer' },
  'banRule.modelFallback': { zh: '未指定模型', en: 'No model set' },
  'banRule.channelFallback': { zh: '未指定接入方式', en: 'No lane set' },
  'banRule.scope': { zh: '仅此项目', en: 'This project only' },
  'banRule.matchAria': { zh: '{label}匹配方式', en: '{label} match type' },
  'banRule.ruleAria': { zh: '{label}规则', en: '{label} rule' },
  'banRule.add': { zh: '添加派出禁令', en: 'Add ban rule' },
  'banRule.regexPlaceholder': { zh: '输入正则表达式', en: 'Enter a regular expression' },
  'banRule.namePlaceholder': { zh: '输入名称，例如 my-model', en: 'Enter a name, e.g. my-model' },
  'banRule.searchLabel': { zh: '搜索名册里的模型', en: 'Search models in the roster' },
  'banRule.searchPlaceholder': { zh: '搜索已入册模型', en: 'Search roster models' },
  'banRule.noMatch': { zh: '没有匹配的已入册模型，可以手动输入。', en: 'No roster model matches; you can type one manually.' },
  'banRule.empty': { zh: '还没有规则。', en: 'No rules yet.' },
  'banRule.ruleMatchAria': { zh: '{label}第{index}条匹配方式', en: '{label} rule {index} match type' },
  'banRule.ruleValueAria': { zh: '{label}第{index}条内容', en: '{label} rule {index} value' },
  'banRule.expand': { zh: '展开', en: 'Expand' },
  'banRule.collapse': { zh: '收起', en: 'Collapse' },
  'banRule.regexAria': { zh: '{label}第{index}条正则', en: '{label} rule {index} regex' },
  'banRule.remove': { zh: '删除', en: 'Delete' },
  'banRule.banCount': { zh: '将禁止派出 {count} 个冒险者', en: 'Would ban {count} adventurers' },
  'banRule.noneAffected': { zh: '当前没有冒险者会被影响', en: 'No adventurer is affected right now' },
  'banRule.invalidRule': { zh: '规则无效', en: 'Invalid rule' },
  'banRule.advancedNote': { zh: '匹配方式：{mode}。保存时仍按原始正则存储。', en: 'Match type: {mode}. The raw regex is still what gets saved.' },
  'banRule.footnoteModel': { zh: '这里禁止派出的是使用该模型的全部冒险者；想暂停单个冒险者，请去公会名册修改它的状态。', en: 'This bans every adventurer using this model; to pause one adventurer, change its status in the roster.' },
  'banRule.footnoteAgent': { zh: '这里禁止派出的是使用该执行角色的全部冒险者；想暂停单个冒险者，请去公会名册修改它的状态。', en: 'This bans every adventurer using this agent role; to pause one adventurer, change its status in the roster.' },
  'settingsPolicy.introTitle': { zh: '派遣规则', en: 'Dispatch rules' },
  'settingsPolicy.intro': { zh: '派遣规则只作用于当前项目，不会全局禁止派出模型或执行角色。', en: 'Dispatch rules apply to this project only; they never block models or agent roles globally.' },
  'settingsPolicy.banModelsLabel': { zh: '禁止派出模型', en: 'Banned models' },
  'settingsPolicy.banModelsHint': { zh: '搜索名册中的模型，也可以手动输入尚未入册的模型名。', en: 'Search the roster, or type a model name that is not in it yet.' },
  'settingsPolicy.banAgentsLabel': { zh: '禁止派出执行角色', en: 'Banned agent roles' },
  'settingsPolicy.banAgentsHint': { zh: '匹配冒险者的 agent 字段，例如 my-agent；这不是冒险者名册。', en: 'Matches the adventurer agent field, e.g. my-agent; this is not the adventurer roster.' },
  'settingsPolicy.stallTitle': { zh: '停摆判定', en: 'Stall detection' },
  'settingsPolicy.stallHint': { zh: '.out 超过这么多分钟没动静、又拿不到有效的 .exit 时，看板把这个 worker 标成停摆。停摆只是提醒，不会取消任务。', en: 'When the .out file has been quiet this long and no valid .exit exists, the board marks the worker stalled. That is only a notice; the quest is not cancelled.' },
  'settingsPolicy.stallUnit': { zh: '单位：分钟', en: 'Unit: minutes' },
  'settingsPolicy.stallLabel': { zh: '停摆阈值（分钟）', en: 'Stall threshold (minutes)' },
  'settingsPolicy.stallPlaceholder': { zh: '默认 20', en: 'Default 20' },
  'settingsPolicy.laneLimitTitle': { zh: '通道并发上限', en: 'Lane concurrency caps' },
  'settingsPolicy.laneLimitHint': { zh: '每条通道最多同时跑几个 worker。改小不会停掉已经在跑的 worker，只会挡住新的派遣；默认不限制。', en: 'How many workers a lane may run at once. Lowering it never stops running workers; it only blocks new dispatches. No cap by default.' },
  'settingsPolicy.scope': { zh: '仅此项目', en: 'This project only' },
  'settingsPolicy.laneLimitEmpty': { zh: '还没有设置上限。', en: 'No cap set yet.' },
  'settingsPolicy.laneAria': { zh: '第{index}条通道', en: 'Lane {index}' },
  'settingsPolicy.selectLane': { zh: '选择通道', en: 'Select a lane' },
  'settingsPolicy.unconfigured': { zh: '{lane}（未配置）', en: '{lane} (not configured)' },
  'settingsPolicy.limitAria': { zh: '第{index}条并发上限', en: 'Concurrency cap {index}' },
  'settingsPolicy.limitPlaceholder': { zh: '比如 2', en: 'e.g. 2' },
  'settingsPolicy.remove': { zh: '删除', en: 'Delete' },
  'settingsPolicy.addLaneLimit': { zh: '添加通道上限', en: 'Add lane cap' },
  'settingsPolicy.defaultsTitle': { zh: '默认通道与默认卡', en: 'Default lane & default card' },
  'settingsPolicy.defaultsHint': { zh: '没指定时用哪条通道、哪张卡。你手动指定的永远优先；这里不会自动替你派活、也不会悄悄换卡。', en: 'Which lane and card to use when none is given. Anything you specify by hand always wins; nothing here dispatches for you or silently swaps cards.' },
  'settingsPolicy.defaultLane': { zh: '默认通道', en: 'Default lane' },
  'settingsPolicy.noDefault': { zh: '不指定', en: 'Not set' },
  'settingsPolicy.defaultCard': { zh: '默认卡 ID', en: 'Default card id' },
  'settingsPolicy.defaultCardAria': { zh: '默认卡 ID', en: 'Default card id' },
  'settingsPolicy.defaultCardPlaceholder': { zh: '例如 my-card', en: 'e.g. my-card' },
  'settingsPolicy.cardMissing': { zh: '首选卡「{id}」不在名册里（设置会保留，不会自动换卡；补上这张卡或改掉 ID 即可）', en: 'The preferred card \u201c{id}\u201d is not in the roster (the setting is kept and never auto-swapped; add the card or change the id)' },
  'settingsPolicy.defaultsNote': { zh: 'questboard assign 不带 --adventurer 时会用它；卡本身在公会名册里维护，这里只记偏好。', en: 'questboard assign uses it when --adventurer is omitted; cards themselves live in the roster \u2014 this is only a preference.' },
  'settingsPolicy.bounceTitle': { zh: '结构化退避', en: 'Structured bounce' },
  'settingsPolicy.bounceHint': { zh: 'worker 的退出行匹配到正则时，退避原因显示成你的标签，并带上 code。只匹配最后一行，不扫描整个日志；内置的用量限额识别先跑。', en: 'When the worker exit line matches a regex, the bounce reason shows your label and carries the code. Only the last line is matched; the whole log is never scanned, and the built-in quota detection runs first.' },
  'settingsPolicy.bounceEmpty': { zh: '还没有规则，先走内置的用量限额识别。', en: 'No rules yet; the built-in quota detection runs.' },
  'settingsPolicy.codeAria': { zh: '第{index}条 code', en: 'Code {index}' },
  'settingsPolicy.codePlaceholder': { zh: 'code，例如 quota_5h', en: 'code, e.g. quota_5h' },
  'settingsPolicy.patternAria': { zh: '第{index}条正则', en: 'Regex {index}' },
  'settingsPolicy.patternPlaceholder': { zh: '正则，例如 resets (at|in)', en: 'regex, e.g. resets (at|in)' },
  'settingsPolicy.labelAria': { zh: '第{index}条标签', en: 'Label {index}' },
  'settingsPolicy.labelPlaceholder': { zh: '标签，例如 额度用尽', en: 'label, e.g. quota exhausted' },
  'settingsPolicy.addBounce': { zh: '添加退避规则', en: 'Add bounce rule' },
  'settingsPolicy.restartNote': { zh: '保存后需要重启看板才会生效。', en: 'Takes effect after the board restarts.' },
  // — settings: usage providers, argv preview, optional args, lane card —
  'settingsUsageProviders.title': { zh: '手动查看的用量来源', en: 'Usage sources you check by hand' },
  'settingsUsageProviders.intro': { zh: '打开后，这几种暂未接入的用量会在用量页显示为“手动查看”卡片；不会发起查询，也不会读取密钥。', en: 'Once on, these not-yet-integrated sources show as \u201cmanual check\u201d cards on the usage page; nothing is queried and no key is read.' },
  'settingsUsageProviders.writeNote': { zh: '这里的开关和阿里云版本、区域会写入项目配置（usage.manualProviders、usage.alibaba）。', en: 'These switches, the Alibaba edition and the region are written into the project config (usage.manualProviders, usage.alibaba).' },
  'settingsUsageProviders.alibabaEdition': { zh: '阿里云版本', en: 'Alibaba edition' },
  'settingsUsageProviders.alibabaRegion': { zh: '阿里云区域', en: 'Alibaba region' },
  'settingsUsageProviders.restartHint': { zh: '保存后需要重启看板才会生效。', en: 'Takes effect after the board restarts.' },
  'settingsUsageProviders.notChosen': { zh: '未选择', en: 'Not chosen' },
  'settingsUsageProviders.editionPersonal': { zh: '个人版', en: 'Personal' },
  'settingsUsageProviders.editionTeam': { zh: '团队版', en: 'Team' },
  'settingsUsageProviders.regionBeijing': { zh: '北京', en: 'Beijing' },
  'settingsUsageProviders.regionSingapore': { zh: '新加坡', en: 'Singapore' },
  'settingsUsageProviders.currentSuffix': { zh: '{value}（当前配置）', en: '{value} (current config)' },
  'settingsUsageProviders.provider.alibabaTokenPlan': { zh: '阿里云百炼 Token Plan', en: 'Alibaba Bailian Token Plan' },
  'settingsUsageProviders.provider.alibabaCodingPlan': { zh: '阿里云百炼 Coding Plan', en: 'Alibaba Bailian Coding Plan' },
  'settingsUsageProviders.provider.nvidia': { zh: 'NVIDIA', en: 'NVIDIA' },
  'settingsUsageProviders.provider.claudeSubscription': { zh: 'Claude 订阅', en: 'Claude subscription' },
  'settingsUsageProviders.provider.openaiSpend': { zh: 'OpenAI API 消耗', en: 'OpenAI API spend' },
  'settingsUsageProviders.note.console': { zh: '当前通过控制台查看', en: 'Check it in its console for now' },
  'settingsUsageProviders.note.nvidia': { zh: '当前通过控制台查看（build.nvidia.com 右上角账户菜单）', en: 'Check it in its console for now (account menu at build.nvidia.com, top right)' },
  'settingsUsageProviders.note.claude': { zh: '在 Claude Code 里运行 /usage 查看', en: 'Run /usage in Claude Code' },
  'argvPreview.title': { zh: '命令预览 (Argv Preview)', en: 'Argv preview' },
  'argvPreview.tag': { zh: '只读实时预览 · 不会保存配置', en: 'Read-only live preview \u00b7 nothing is saved' },
  'argvPreview.desc': { zh: '选择冒险者卡片或自行填写变体/智能体参数，实时观察接入命令在不同卡片条件下的完整展开效果（精确逐行显示参数，不按空格拼接）。', en: 'Pick a roster card or type variant/agent values by hand to watch the lane command expand for those conditions (arguments are shown line by line, never re-joined on spaces).' },
  'argvPreview.rosterLabel': { zh: '从公会花名册选择卡片', en: 'Pick a card from the guild roster' },
  'argvPreview.manualOption': { zh: '-- 手动填写参数 --', en: '-- fill in arguments by hand --' },
  'argvPreview.noModel': { zh: '无模型', en: 'no model' },
  'argvPreview.modelLabel': { zh: '模型 (model)', en: 'Model (model)' },
  'argvPreview.modelPlaceholder': { zh: '例如 my-model', en: 'e.g. my-model' },
  'argvPreview.variantLabel': { zh: '变体 (variant)', en: 'Variant (variant)' },
  'argvPreview.variantPlaceholder': { zh: '例如 high、none、空', en: 'e.g. high, none, empty' },
  'argvPreview.agentLabel': { zh: '智能体 (agent)', en: 'Agent (agent)' },
  'argvPreview.agentPlaceholder': { zh: '例如 coder、oracle', en: 'e.g. coder, oracle' },
  'argvPreview.pkgLabel': { zh: '任务包名 (package)', en: 'Package (package)' },
  'argvPreview.briefLabel': { zh: '简报路径 (brief)', en: 'Brief path (brief)' },
  'argvPreview.unsupported': { zh: '这个版本的看板还不支持命令预览', en: 'This board version does not support the argv preview yet' },
  'argvPreview.previewFailed': { zh: '预览失败：{error}', en: 'Preview failed: {error}' },
  'argvPreview.omittedLabel': { zh: '已根据条件整组省略的参数：', en: 'Argument groups omitted under these conditions:' },
  'argvPreview.omittedAbsent': { zh: '未填写', en: 'not set' },
  'argvPreview.baseTitle': { zh: '基础模板 (Run Arguments)', en: 'Base template (Run Arguments)' },
  'argvPreview.itemCount': { zh: '{count} 项', en: '{count} items' },
  'argvPreview.emptyBase': { zh: '未配置基础参数', en: 'No base arguments configured' },
  'argvPreview.finalTitle': { zh: '最终执行命令 (展开后 Argv)', en: 'Final command (expanded argv)' },
  'argvPreview.computing': { zh: '计算中…', en: 'Computing…' },
  'argvPreview.computingLong': { zh: '正在计算命令参数…', en: 'Computing the command arguments…' },
  'argvPreview.awaitInput': { zh: '等待输入计算…', en: 'Waiting for input…' },
  'optionalArgs.intro': { zh: '配置特定卡片属性（如变体或智能体）存在时才插入的参数组。未填写对应属性或值匹配省略规则时整组自动忽略。', en: 'Argument groups inserted only when a card property (variant or agent) is set. When it is empty or matches an omit value, the whole group is skipped.' },
  'optionalArgs.empty': { zh: '暂未配置可选参数组。点击下方按钮添加。', en: 'No optional argument groups yet. Use the button below to add one.' },
  'optionalArgs.groupBadge': { zh: '组 #{index}', en: 'Group #{index}' },
  'optionalArgs.malformedKept': { zh: '无法解析，已原样保留', en: 'Cannot parse; kept as-is' },
  'optionalArgs.removeGroupMalformed': { zh: '删除此组', en: 'Delete this group' },
  'optionalArgs.removeGroup': { zh: '删除组', en: 'Delete group' },
  'optionalArgs.unknownFields': { zh: '未知字段，已保留：', en: 'Unknown fields, kept as-is: ' },
  'optionalArgs.whenLabel': { zh: '触发条件 (when)', en: 'Trigger (when)' },
  'optionalArgs.whenVariant': { zh: 'variant（卡片填了变体时）', en: 'variant (when the card sets a variant)' },
  'optionalArgs.whenAgent': { zh: 'agent（卡片填了智能体时）', en: 'agent (when the card sets an agent)' },
  'optionalArgs.whenHint': { zh: '仅当所选卡片属性非空且未匹配省略列表时生效', en: 'Applies only when the chosen property is non-empty and not in the omit list' },
  'optionalArgs.insertLabel': { zh: '插入位置 (insertAt)', en: 'Insert position (insertAt)' },
  'optionalArgs.range': { zh: '允许范围：{min} ～ {max}', en: 'Allowed range: {min} to {max}' },
  'optionalArgs.rangeNodeNote': { zh: '（第 0 位是 node，第 1 位是脚本文件）', en: '(position 0 is node, position 1 is the script file)' },
  'optionalArgs.rangeNote': { zh: '（第 0 位是执行程序）', en: '(position 0 is the executable)' },
  'optionalArgs.rangeError': { zh: '插入位置超出范围（必须在 {min} 到 {max} 之间）', en: 'Insert position out of range (must be between {min} and {max})' },
  'optionalArgs.argsLabel': { zh: '插入参数列表 (args - 每格一个参数，保留空格与引号)', en: 'Arguments to insert (args - one per cell, spaces and quotes kept)' },
  'optionalArgs.placeholderWarning': { zh: '参数中建议包含 {placeholder} 占位符，否则无法将对应属性值传给命令', en: 'Include the {placeholder} placeholder in the arguments, or the property value cannot reach the command' },
  'optionalArgs.argPlaceholder': { zh: '例如 --effort 或 {placeholder}', en: 'e.g. --effort or {placeholder}' },
  'optionalArgs.argWhitespace': { zh: '参数不能仅为空白字符', en: 'An argument cannot be only whitespace' },
  'optionalArgs.remove': { zh: '删除', en: 'Delete' },
  'optionalArgs.addArg': { zh: '+ 添加参数', en: '+ Add argument' },
  'optionalArgs.omitLabel': { zh: '省略值列表 (omitWhen - 值为以下内容时整组忽略)', en: 'Omit values (omitWhen - skip the group when the value is one of these)' },
  'optionalArgs.omitHint': { zh: '卡片属性未填、null 或空字符串时已默认省略整组；若填写了以下值（如 none、off），也整组省略。', en: 'An unset, null or empty property already skips the group; the values below (e.g. none, off) skip it too.' },
  'optionalArgs.omitPlaceholder': { zh: '例如 none 或 off', en: 'e.g. none or off' },
  'optionalArgs.omitWhitespace': { zh: '省略值不能仅为空白字符', en: 'An omit value cannot be only whitespace' },
  'optionalArgs.addOmit': { zh: '+ 添加省略值', en: '+ Add omit value' },
  'optionalArgs.malformedList': { zh: '无法解析，已原样保留：可选参数组必须是列表', en: 'Cannot parse; kept as-is: optional argument groups must be a list' },
  'optionalArgs.removeMalformed': { zh: '删除无法解析的配置', en: 'Delete the unparseable config' },
  'optionalArgs.addGroup': { zh: '+ 添加可选参数组', en: '+ Add optional argument group' },
  'optionalArgs.summary': { zh: '当卡片填了 {when} 时，在第 {pos} 个位置插入 {args}；{omit}', en: 'When the card sets {when}, insert {args} at position {pos}; {omit}' },
  'optionalArgs.emptyArgs': { zh: '(未填写参数)', en: '(no arguments)' },
  'optionalArgs.omitDefault': { zh: '未填写时整组省略', en: 'skipped when unset' },
  'optionalArgs.omitList': { zh: '值为 {values} 时整组省略', en: 'skipped when the value is {values}' },
  'laneCard.idLabel': { zh: '接入方式 ID', en: 'Lane id' },
  'laneCard.idPlaceholder': { zh: '例如 my-lane', en: 'e.g. my-lane' },
  'laneCard.removeLane': { zh: '删除这种接入方式', en: 'Delete this lane' },
  'laneCard.runLabel': { zh: '执行命令参数 (Run Arguments)', en: 'Run arguments (Run Arguments)' },
  'laneCard.placeholdersHint': { zh: '可用占位符：', en: 'Available placeholders: ' },
  'laneCard.argPlaceholder': { zh: '参数内容', en: 'argument' },
  'laneCard.remove': { zh: '删除', en: 'Delete' },
  'laneCard.addArg': { zh: '+ 添加参数', en: '+ Add argument' },
  'laneCard.optionalTitle': { zh: '可选参数 (Optional Arguments)', en: 'Optional arguments' },
  'laneCard.optionalCount': { zh: '已配置 {count} 组', en: '{count} groups configured' },
  'laneCard.optionalNone': { zh: '未配置', en: 'Not configured' },
  'laneCard.outputLabel': { zh: '输出目录 (outputDir)', en: 'Output directory (outputDir)' },
  'laneCard.apiLabel': { zh: '接口服务 (api)', en: 'API server (api)' },
  'laneCard.apiPlaceholder': { zh: '例如 http://localhost:8000', en: 'e.g. http://localhost:8000' },
  'laneCard.serveLabel': { zh: '启动服务的命令 (serve - 可选)', en: 'Serve command (serve - optional)' },
  'laneCard.serveHintPrefix': { zh: '例如 ', en: 'e.g. ' },
  'laneCard.serveHintSuffix': { zh: '，每格一个参数；整个接入方式只跑一次，不能用占位符', en: ', one argument per cell; it runs once per lane and takes no placeholders' },
  'laneCard.healthCheck': { zh: '健康检查 (health - 可选，不开启就沿用旧规则：接口有响应即算正常)', en: 'Health check (health - optional; without it the old rule applies: any response counts as healthy)' },
  'laneCard.healthMalformedPrefix': { zh: '从文件读到的健康检查写法不对：', en: 'The health-check config read from the file is malformed: ' },
  'laneCard.healthMalformedSuffix': { zh: '。填一个有效路径可以修复，或者取消勾选来关闭健康检查（关闭前不会丢掉原来的写法）。', en: '. Fill in a valid path to repair it, or untick the box to turn the health check off (the old config is not discarded until then).' },
  'laneCard.healthPathLabel': { zh: '检查路径（相对于上面的 api，例如 /global/health）', en: 'Check path (relative to the api above, e.g. /global/health)' },
  'laneCard.healthPathPlaceholder': { zh: '/global/health', en: '/global/health' },
  'laneCard.healthPreset': { zh: '套用 OpenCode 预设', en: 'Apply the OpenCode preset' },
  'laneCard.healthPathHint': { zh: '路径留空保存 = 不做健康检查', en: 'An empty path on save = no health check' },
  'laneCard.healthJsonLabel': { zh: '期望字段（可选，JSON 对象，例如 {"healthy":true}；不填就只看有没有响应）', en: 'Expected fields (optional JSON object, e.g. {"healthy":true}; without it any response counts)' },
  'laneCard.healthJsonPlaceholder': { zh: '{"healthy":true}', en: '{"healthy":true}' },
  'laneCard.deliveryLabel': { zh: '交差目录 (deliveryDir - 可选)', en: 'Delivery directory (deliveryDir - optional)' },
  'laneCard.deliveryPlaceholder': { zh: '例如 delivery/...', en: 'e.g. delivery/...' },
  'laneCard.modelLabel': { zh: '默认模型 (defaultModel - 可选)', en: 'Default model (defaultModel - optional)' },
  'laneCard.modelPlaceholder': { zh: '例如 my-model', en: 'e.g. my-model' },
  'laneCard.counterLabel': { zh: '编辑计数器 (editCounter)', en: 'Edit counter (editCounter)' },
  'laneCard.counterDefault': { zh: '默认 (patch)', en: 'Default (patch)' },
  'laneCard.spacingLabel': { zh: '间隔时间 (spacingMs - 毫秒)', en: 'Spacing (spacingMs - ms)' },
  'laneCard.serialize': { zh: '并发策略：排队执行', en: 'Concurrency: run queued' },
  'laneCard.envLabel': { zh: '环境变量（可选，每行 NAME=值；不要放密钥）', en: 'Environment variables (optional, one NAME=value per line; never put secrets here)' },
  'laneCard.sessionTitle': { zh: '会话记录步骤 (Session - 可选)', en: 'Session step (Session - optional)' },
  'laneCard.sessionSaveLabel': { zh: '会话保存路径 (saveTo)', en: 'Session save path (saveTo)' },
  'laneCard.sessionSavePlaceholder': { zh: '.questboard-data/sessions/{package}.json', en: '.questboard-data/sessions/{package}.json' },
  'laneCard.sessionRunLabel': { zh: '会话执行参数 (Session Run Arguments)', en: 'Session run arguments' },
  'laneCard.sessionArgPlaceholder': { zh: '会话参数', en: 'session argument' },
  'laneCard.addSessionArg': { zh: '+ 添加会话参数', en: '+ Add session argument' },
  // — Header status chips, the guild panel and live event toasts (residual strings from the first pass) —
  'chips.connected': { zh: '实时连接', en: 'Live' },
  'chips.reconnecting': { zh: '重连中…', en: 'Reconnecting…' },
  'chips.readFailed': { zh: '读取失败：{error}', en: 'Read failed: {error}' },
  'chips.projectTests': { zh: '项目整体测试{result}{counts}', en: 'Project tests {result}{counts}' },
  'chips.projectTestsFailed': { zh: '没过 {names}', en: 'failed: {names}' },
  'chips.projectTestsPassed': { zh: '通过', en: 'passed' },
  'chips.projectTestsTitle': { zh: '整个项目最近一次测试，不是某一个委托的', en: 'The latest run of the whole project, not of a single quest' },
  'chips.treeLocked': { zh: '🔒 coordinator 正在验证，暂停派出', en: '🔒 coordinator is verifying; dispatch is paused' },
  'chips.laneLimited': { zh: '{lane} 限额中', en: '{lane} limited' },
  'chips.laneLimitedUntil': { zh: '，{until} 恢复', en: ', resets {until}' },
  'chips.openQuestions': { zh: '留言板待答 {count}', en: 'Open questions {count}' },
  'chips.updatedAt': { zh: '更新 {time}', en: 'Updated {time}' },
  'guild.title': { zh: '冒险者公会', en: 'Adventurers\' guild' },
  'guild.hint': { zh: '一位冒险者 = 一个已配置好的模型运行档。拖动或悬停：能接的委托会亮起，不能接的会写明原因。点名字改状态，用搜索和筛选找人。', en: 'One adventurer = one configured model run. Drag or hover: quests it can take light up, and refusals say why. Click a name to change status; search and filters find people.' },
  'guild.empty': { zh: '没找到符合条件的冒险者（公会共 {count} 位），换个词或清除筛选试试。', en: 'No adventurers match (the guild has {count}); try another word or clear the filters.' },
  'guild.tempCollapse': { zh: '临时收起：只在这次筛选里，不改动保存的折叠', en: 'Temporarily collapse: this filter only; saved folds are not changed' },
  'guild.tempExpand': { zh: '临时展开：只在这次筛选里，不改动保存的折叠', en: 'Temporarily expand: this filter only; saved folds are not changed' },
  'guild.collapse': { zh: '收起 {provider}', en: 'Collapse {provider}' },
  'guild.expand': { zh: '展开 {provider}', en: 'Expand {provider}' },
  'guild.countFiltered': { zh: '显示 {visible} / 共 {total} 位', en: 'Showing {visible} / {total}' },
  'event.posted': { zh: '新委托 {package}', en: 'New quest {package}' },
  'event.reviewPosted': { zh: '新复核委托 {package}', en: 'New review quest {package}' },
  'event.assigned': { zh: '{package} 已派出{who}', en: '{package} dispatched{who}' },
  'event.dispatched': { zh: '{package} 脚本已启动{who}', en: '{package} script started{who}' },
  'event.delivered': { zh: '{package} 交差了，待验收{who}', en: '{package} delivered, awaiting review{who}' },
  'event.failed': { zh: '{package} 失败{who}', en: '{package} failed{who}' },
  'event.bounced': { zh: '{package} 限额退回{who}', en: '{package} bounced on limit{who}' },
  'event.stalled': { zh: '{package} 失联了{who}', en: '{package} stalled{who}' },
  'event.cancelled': { zh: '{package} 已取消', en: '{package} cancelled' },
  'event.released': { zh: '{package} 的冒险者已释放，可以重新派', en: '{package}\'s worker was released; it can be dispatched again' },
  'event.ownerRuling': { zh: '{package} 已裁决', en: '{package} ruled' },
  'event.deliveryWriteFailed': { zh: '{package} 交差文件没写成：{detail}', en: '{package} delivery write failed: {detail}' },
  'event.modelSuffix': { zh: '（{model}）', en: ' ({model})' },

  // — language switch, third pass (item 38 follow-up): card badge/node/modal, brief shelf, evidence
  // section/upstream evidence/review section/quest receipt/report panel, redo dialog and their label
  // tables (lib/evidence.ts, lib/redoSubmission.ts). Kept in one block so parallel slices merge cleanly. —
  'common.autoJudged': { zh: '自动判断：{reason}', en: 'Auto-detected: {reason}' },
  'common.actionFailed': { zh: '{action}：{error}', en: '{action}: {error}' },
  'common.reportTruncated': {
    zh: '报告没有读完整，只显示了前面一部分',
    en: 'The report was not fully read; only the beginning is shown.',
  },
  // CardBadge.tsx
  'cardBadge.busyTitle': { zh: ' · 正在做 {ids}', en: ' · working on {ids}' },
  'cardBadge.ariaLabel': {
    zh: '冒险者工牌 {id}：{name}，模型 {model}{variant}，服务商 {provider}，接入方式 {lane}，状态 {status}{busy}',
    en: 'Adventurer badge {id}: {name}, model {model}{variant}, provider {provider}, lane {lane}, status {status}{busy}',
  },
  'cardBadge.ariaVariant': { zh: '，变体 {variant}', en: ', variant {variant}' },
  'cardBadge.ariaBusy': { zh: '，正在做 {ids}', en: ', working on {ids}' },
  'cardBadge.resetUnknownAuto': {
    zh: '（重置时间未知，成功一次或你手动确认后恢复）',
    en: ' (reset time unknown; recovers after one success or your manual confirmation)',
  },
  'cardBadge.autoRecovered': {
    zh: '（自动判断：到点后不再算限额，但额度没有核实过）',
    en: ' (auto-detected: no longer counted as limited past that time, but the quota has not been verified)',
  },
  'cardBadge.modelLabel': { zh: '模型', en: 'Model' },
  'cardBadge.laneLabel': { zh: '接入方式', en: 'Lane' },
  'cardBadge.sinceSuffix': { zh: ' · {date} 起', en: ' · since {date}' },
  'cardBadge.recentFailure': { zh: '最近一次执行失败 · {questId}', en: 'Most recent failed run · {questId}' },
  // CardNode.tsx
  'cardNode.liveEdits': { zh: ' · {edits} 处改动', en: ' · {edits} edits' },
  'cardNode.detailAria': { zh: '{name} 详情', en: '{name} details' },
  'cardNode.baseStatusNote': { zh: '（名册里记的是：{status}）', en: ' (roster status: {status})' },
  'cardNode.resetUnknown': { zh: '（重置时间未知）', en: ' (reset time unknown)' },
  'cardNode.current': { zh: '正在做', en: 'Current' },
  'cardNode.history': { zh: '做过', en: 'History' },
  'cardNode.heldByOther': { zh: '·现在换了别的冒险者', en: '· now held by another adventurer' },
  'cardNode.activityParenOpen': { zh: '（', en: ' (' },
  'cardNode.activityParenClose': { zh: '）', en: ')' },
  'cardNode.empty': { zh: '还没有委托记录', en: 'No quest history yet' },
  // CardModal.tsx (CONFIRM_RESTORED_REASON stays Chinese-only: it is written to the server as the card's
  // stored status reason, not merely displayed — translating it would leak the browser's locale into
  // persisted project data, which the preference must never do)
  'cardModal.timeUnknown': { zh: '时间未知', en: 'Time unknown' },
  'cardModal.judgedAt': { zh: '{date} {time} 判断', en: 'Judged {date} {time}' },
  'cardModal.expectedReset': { zh: '预计 {date} {time} 恢复', en: 'Expected to reset {date} {time}' },
  'cardModal.resetUnknown': { zh: '重置时间未知', en: 'Reset time unknown' },
  'cardModal.saveFailed': { zh: '保存失败：{error}', en: 'Save failed: {error}' },
  'cardModal.eyebrow': { zh: 'ID CARD · 冒险者档案', en: 'ID CARD · adventurer record' },
  'cardModal.model': { zh: '模型', en: 'Model' },
  'cardModal.lane': { zh: '接入方式', en: 'Lane' },
  'cardModal.recentFailure': { zh: '最近一次执行失败', en: 'Most recent failed run' },
  'cardModal.questLabel': { zh: '任务', en: 'Quest' },
  'cardModal.timeLabel': { zh: '时间', en: 'Time' },
  'cardModal.viewQuest': { zh: '查看任务', en: 'View quest' },
  'cardModal.confirmRestored': { zh: '确认额度已恢复', en: 'Confirm quota restored' },
  'cardModal.confirmNote': {
    zh: '只是登记，不会向服务商核实额度是否真的恢复。',
    en: 'This only records it; it does not verify with the provider that the quota actually recovered.',
  },
  'cardModal.statusLabel': { zh: 'STATUS 状态', en: 'STATUS' },
  'cardModal.reasonLabel': {
    zh: 'REASON 原因（会显示在冒险者上，写明为什么、到什么时候）',
    en: 'REASON (shown on the adventurer; say why and until when)',
  },
  // BriefShelf.tsx
  'briefShelf.eyebrow': { zh: 'DRAFTS' },
  'briefShelf.title': { zh: '还没上板的 brief', en: 'Briefs not on the board yet' },
  'briefShelf.windowDays': { zh: '最近 {days} 天', en: 'Last {days} days' },
  'briefShelf.windowDefault': { zh: '最近几天', en: 'Recent days' },
  'briefShelf.hint': {
    zh: '写好、还没发布、也没派遣过的简报。coordinator 发布后才能派遣。',
    en: 'Briefs written, not yet posted, and never dispatched. The coordinator must post one before it can be dispatched.',
  },
  'briefShelf.lastScan': { zh: '上次扫描：{time}，看了 {folders}。', en: 'Last scanned {time}; checked {folders}.' },
  'briefShelf.rescan': { zh: '立即重新扫描', en: 'Rescan now' },
  'briefShelf.errorItem': { zh: '{folder}（{reason}）', en: '{folder} ({reason})' },
  'briefShelf.showOld': { zh: '也显示超出时间窗口的 {count} 份', en: 'Also show {count} outside the time window' },
  'briefShelf.showDispatched': {
    zh: '也显示已在别处派遣过的 {count} 份',
    en: 'Also show {count} already dispatched elsewhere',
  },
  'briefShelf.empty': { zh: '没有待发布的 brief', en: 'No briefs waiting to be posted' },
  'briefShelf.collapse': { zh: '收起', en: 'Collapse' },
  'briefShelf.expandAll': { zh: '展开全部 {count} 份', en: 'Expand all {count}' },
  'briefShelf.whyMissing': { zh: '为什么还有 {count} 个文件没出现', en: 'Why are {count} files still missing?' },
  'briefShelf.diagSeparator': { zh: '：', en: ': ' },
  'briefShelf.unlistedOther': {
    zh: '还有 {count} 项未列出（本次扫描共排除 {total} 项）',
    en: '{count} more not listed (this scan excluded {total} in total)',
  },
  // lib/evidence.ts — label tables rendered by QuestReceipt.tsx / ReviewSection.tsx
  'evidence.verdict.pass': { zh: '通过', en: 'Pass' },
  'evidence.verdict.findings': { zh: '通过但有问题', en: 'Passed with findings' },
  'evidence.verdict.fail': { zh: '不通过', en: 'Failed' },
  'evidence.verdict.unknown': { zh: '没写结论', en: 'No verdict written' },
  'evidence.verdict.unknownVerified': { zh: '结论未识别', en: 'Verdict not recognised' },
  'evidence.verdict.unverifiedSuffix': { zh: '（未经核验）', en: ' (unverified)' },
  'evidence.source.delivery': { zh: '交付文件', en: 'Delivery file' },
  'evidence.source.exitFile': { zh: '退出文件', en: 'Exit file' },
  'evidence.source.summary': { zh: '运行记录（.out）', en: 'Run log (.out)' },
  'evidence.rawTailLabel': { zh: '最近记录（末尾片段）', en: 'Most recent record (tail fragment)' },
  // lib/redoSubmission.ts — rendered entirely by RedoArtDialog.tsx; match conditions against the server's
  // own text (e.g. `text.includes('有 worker 占着')`) stay Chinese literals on purpose, unconverted
  'redo.field.package': { zh: '委托编号', en: 'Quest id' },
  'redo.field.brief': { zh: '简报路径', en: 'Brief path' },
  'redo.field.kind': { zh: '类型', en: 'Kind' },
  'redo.field.reviewPage': { zh: '评审页', en: 'Review page' },
  'redo.field.parents': { zh: '前置委托', en: 'Prerequisite quests' },
  'redo.field.conflicts': { zh: '不能同时做', en: 'Cannot run together with' },
  'redo.field.allowedLanes': { zh: '限定通道', en: 'Allowed lanes' },
  'redo.field.priority': { zh: '优先级', en: 'Priority' },
  'redo.genericFieldError': {
    zh: '这里填写的内容有误，请检查后重试。',
    en: 'Something here is invalid; check it and try again.',
  },
  'redo.workerHeld': {
    zh: '这个委托还有 worker 占着，先确认它已停止并释放，再重新提交。',
    en: 'This quest still has a worker holding it; confirm it has stopped and released before resubmitting.',
  },
  'redo.packagePatternError': {
    zh: '委托编号不符合这个项目的编号规则，请照简报文件名开头的编号来写（例如 ART-REDO-1）。',
    en: 'The quest id does not match this project’s id pattern; use the id at the start of the brief filename (e.g. ART-REDO-1).',
  },
  'redo.packageRunning': {
    zh: '这个委托还有 worker 在跑，先取消它再重新提交。',
    en: 'This quest still has a worker running; cancel it before resubmitting.',
  },
  'redo.briefRequired': { zh: '请填写简报路径。', en: 'Enter a brief path.' },
  'redo.briefDirs': {
    zh: '简报要放在这些目录里，文件名以 .md 结尾：{dirs}',
    en: 'The brief must be in one of these directories with a .md filename: {dirs}',
  },
  'redo.briefNotAllowed': {
    zh: '简报路径不在这个项目允许的简报目录里。',
    en: 'The brief path is not in a directory this project allows.',
  },
  'redo.kindArtOnly': { zh: '类型只能是美术。', en: 'Kind can only be art.' },
  'redo.parentsInvalid': {
    zh: '前置委托里出现了不是委托编号的内容。',
    en: 'Prerequisite quests contains something that is not a quest id.',
  },
  'redo.conflictsInvalid': {
    zh: '「不能同时做」里出现了不是委托编号的内容。',
    en: '"Cannot run together with" contains something that is not a quest id.',
  },
  'redo.laneUnknown': { zh: '这个通道不在项目设置里。', en: 'This lane is not in the project settings.' },
  'redo.priorityInvalid': { zh: '优先级只能是 1、2 或 3。', en: 'Priority can only be 1, 2 or 3.' },
  'redo.notFound': {
    zh: '看板服务没有这个接口（可能是旧版本），无法发起重做。',
    en: 'The board service has no such endpoint (possibly an old version); cannot start a redo.',
  },
  'redo.validationFailed': {
    zh: '填写内容有误，请检查后再试。',
    en: 'Something entered is invalid; check it and try again.',
  },
  'redo.httpError': { zh: '看板服务返回了错误：{message}。', en: 'The board service returned an error: {message}.' },
  'redo.crossSiteRefused': {
    zh: '跨站请求被拒绝：只有本机打开的看板页面能写入。',
    en: 'Cross-site request refused: only a board page opened on this machine can write.',
  },
  'redo.originRefused': {
    zh: '该来源被拒绝：只有本机打开的看板页面能写入。',
    en: 'This origin was refused: only a board page opened on this machine can write.',
  },
  'redo.submitRefused': {
    zh: '服务器拒绝了这次提交，请检查后再试。',
    en: 'The server refused this submission; check it and try again.',
  },
  'redo.unknownStatus': { zh: '未知状态', en: 'Unknown status' },
  'redo.existingPackage': {
    zh: '这个编号已经在看板上（状态：{status}），继续提交会覆盖它原来的内容。请换一个新编号再提交。',
    en: 'This id is already on the board (status: {status}); submitting would overwrite its existing content. Use a new id.',
  },
  // review/RedoArtDialog.tsx
  'redoDialog.kicker': { zh: '评审目录', en: 'Review directory' },
  'redoDialog.title': { zh: '发起重做委托', en: 'Start a redo quest' },
  'redoDialog.pageId': { zh: '页面编号', en: 'Page id' },
  'redoDialog.pageTitle': { zh: '页面标题', en: 'Page title' },
  'redoDialog.pageUrl': { zh: '页面地址', en: 'Page URL' },
  'redoDialog.annotationStats': { zh: '批注统计', en: 'Annotation stats' },
  'redoDialog.annotationCount': { zh: '共 {total} 处，已批注 {answered} 处', en: '{total} total, {answered} annotated' },
  'redoDialog.pageFile': { zh: '页面文件', en: 'Page file' },
  'redoDialog.pageFileValue': { zh: '评审目录/{path}', en: 'review directory/{path}' },
  'redoDialog.pickBrief': { zh: '选择重做简报', en: 'Pick the redo brief' },
  'redoDialog.noBriefsListed': { zh: '未发布的简报', en: 'Unposted briefs' },
  'redoDialog.noBriefsWithList': {
    zh: '当前没有未发布的简报，请直接输入简报路径。',
    en: 'No unposted briefs right now; enter the brief path directly.',
  },
  'redoDialog.noBriefsNoList': {
    zh: '当前看板没有提供未发布简报列表（可能是旧版本），请直接输入简报路径。',
    en: 'This board does not provide an unposted-brief list (possibly an old version); enter the brief path directly.',
  },
  'redoDialog.customBriefLabel': { zh: '或输入简报路径', en: 'Or enter a brief path' },
  'redoDialog.customBriefPlaceholder': { zh: '例如 <简报目录>/ART-REDO-1.md', en: 'e.g. <brief dir>/ART-REDO-1.md' },
  'redoDialog.packageLabel': { zh: '委托编号', en: 'Quest id' },
  'redoDialog.packagePlaceholder': { zh: '例如 ART-REDO-1', en: 'e.g. ART-REDO-1' },
  'redoDialog.previewTitle': { zh: '将要提交的内容', en: 'What will be submitted' },
  'redoDialog.notFilled': { zh: '未填写', en: 'Not filled in' },
  'redoDialog.notSelected': { zh: '未选择', en: 'Not selected' },
  'redoDialog.kindValue': { zh: '美术', en: 'Art' },
  'redoDialog.correspondingPage': { zh: '对应的评审页', en: 'Corresponding review page' },
  'redoDialog.otherErrorItem': { zh: '{label}：{value}', en: '{label}: {value}' },
  'redoDialog.connectFailed': {
    zh: '无法连接看板服务，请确认服务仍在运行后再试。',
    en: 'Cannot connect to the board service; confirm it is still running and try again.',
  },
  'redoDialog.submitFailed': { zh: '提交失败，请稍后再试。', en: 'Submit failed; try again in a moment.' },
  'redoDialog.missingQuestId': {
    zh: '服务器返回的数据不完整（缺少委托编号）。',
    en: 'The server response is incomplete (missing the quest id).',
  },
  'redoDialog.cancel': { zh: '取消', en: 'Cancel' },
  'redoDialog.submitting': { zh: '正在提交…', en: 'Submitting…' },
  'redoDialog.confirm': { zh: '确认发起重做', en: 'Confirm the redo' },
  // quest/EvidenceSection.tsx
  'evidenceSection.kind.report': { zh: '模型自报', en: 'Model self-report' },
  'evidenceSection.kind.projectVerification': { zh: '项目验证记录', en: 'Project verification record' },
  'evidenceSection.kind.hook': { zh: '验证钩子', en: 'Verification hook' },
  'evidenceSection.state.passed': { zh: '通过', en: 'Passed' },
  'evidenceSection.state.findings': { zh: '通过但有问题', en: 'Passed with findings' },
  'evidenceSection.state.failed': { zh: '失败', en: 'Failed' },
  'evidenceSection.state.unknown': { zh: '未知', en: 'Unknown' },
  'evidenceSection.state.missing': { zh: '缺失', en: 'Missing' },
  'evidenceSection.state.notConfigured': { zh: '未配置', en: 'Not configured' },
  'evidenceSection.state.queued': { zh: '排队中', en: 'Queued' },
  'evidenceSection.state.running': { zh: '运行中', en: 'Running' },
  'evidenceSection.state.timedout': { zh: '超时', en: 'Timed out' },
  'evidenceSection.source.delivery': { zh: '交差文件', en: 'Delivery file' },
  'evidenceSection.source.exitFile': { zh: '退出文件', en: 'Exit file' },
  'evidenceSection.source.summary': { zh: '运行记录（.out）', en: 'Run log (.out)' },
  'evidenceSection.source.progressStrip': {
    zh: '项目验证目录（progress.txt）',
    en: 'Project verification dir (progress.txt)',
  },
  'evidenceSection.notThisAttempt': { zh: '不是这次派遣的', en: 'Not from this dispatch' },
  'evidenceSection.sourceLabel': { zh: '来源', en: 'source' },
  'evidenceSection.commandLabel': { zh: '命令', en: 'command' },
  'evidenceSection.pathLabel': { zh: '· 路径', en: '· path' },
  'evidenceSection.digestLabel': { zh: '· 摘要', en: '· digest' },
  'evidenceSection.copied': { zh: '已复制', en: 'Copied' },
  'evidenceSection.copy': { zh: '复制', en: 'Copy' },
  'evidenceSection.recordedAt': { zh: '记录时间：{time}', en: 'Recorded {time}' },
  'evidenceSection.loading': { zh: '证据读取中…', en: 'Reading evidence…' },
  'evidenceSection.loadFailed': { zh: '证据读取失败：{error}', en: 'Could not read evidence: {error}' },
  'evidenceSection.thisAttempt': { zh: '这次派遣：{name}', en: 'This dispatch: {name}' },
  'evidenceSection.noDispatch': { zh: '还没有派遣', en: 'Not dispatched yet' },
  'evidenceSection.title': { zh: '这次派遣的证据', en: 'Evidence for this dispatch' },
  // quest/UpstreamEvidence.tsx
  'upstreamEvidence.kind.report': { zh: '模型自报', en: 'Model self-report' },
  'upstreamEvidence.kind.projectVerification': { zh: '项目验证记录', en: 'Project verification record' },
  'upstreamEvidence.kind.hook': { zh: '验证钩子', en: 'Verification hook' },
  'upstreamEvidence.state.passed': { zh: '通过', en: 'Passed' },
  'upstreamEvidence.state.failed': { zh: '失败', en: 'Failed' },
  'upstreamEvidence.state.stale': { zh: '不是这次派遣的', en: 'Not from this dispatch' },
  'upstreamEvidence.state.missing': { zh: '缺失', en: 'Missing' },
  'upstreamEvidence.state.notConfigured': { zh: '未配置', en: 'Not configured' },
  'upstreamEvidence.state.unknown': { zh: '未知', en: 'Unknown' },
  'upstreamEvidence.gap': { zh: '未经项目验证', en: 'Not project-verified' },
  'upstreamEvidence.title': { zh: '上游证据', en: 'Upstream evidence' },
  'upstreamEvidence.loading': { zh: '上游证据读取中…', en: 'Reading upstream evidence…' },
  'upstreamEvidence.loadFailed': { zh: '上游证据读取失败：{error}', en: 'Could not read upstream evidence: {error}' },
  'upstreamEvidence.refusalPrefix': {
    zh: '这条复核委托要求上游的 {kinds} 都通过，还没满足的：',
    en: 'This review quest requires the upstream {kinds} to all pass; not yet satisfied:',
  },
  'upstreamEvidence.refusalSuffix': {
    zh: '。记录一次例外之前，派不出去。',
    en: '. It cannot be dispatched until an exception is recorded.',
  },
  'upstreamEvidence.overrideValid': {
    zh: '已记录例外（{by} · {time}）：{reason}',
    en: 'Exception recorded ({by} · {time}): {reason}',
  },
  'upstreamEvidence.overrideInvalid': {
    zh: '记录过的例外已失效（上游有新的派遣，需要重新确认）：{reason}',
    en: 'The recorded exception has expired (upstream has a new dispatch; re-confirm): {reason}',
  },
  'upstreamEvidence.overrideByOwner': { zh: '你', en: 'You' },
  'upstreamEvidence.overridePlaceholder': { zh: '记录例外的原因（必填）', en: 'Reason for the exception (required)' },
  'upstreamEvidence.recordOverride': { zh: '记录例外', en: 'Record exception' },
  'upstreamEvidence.reasonRequired': { zh: '记录例外要写明原因', en: 'Recording an exception requires a reason' },
  'upstreamEvidence.overrideSuccess': {
    zh: '{questId} 已记录复核例外：上游检查不再挡它，拖卡过来即可派遣',
    en: '{questId} exception recorded: the upstream check no longer blocks it; drag a card onto it to dispatch',
  },
  'upstreamEvidence.overrideFailed': { zh: '记录例外没成功：{error}', en: 'Could not record the exception: {error}' },
  // quest/ReviewSection.tsx (the 验收：/退回重做： text sent via api.rule/setQuestStatus stays Chinese-only:
  // it is written to the server as quest history that other logic pattern-matches, e.g. recordedAcceptor())
  'reviewSection.verdictPrefix': { zh: '复核结论（模型自报）：', en: 'Review verdict (model self-report): ' },
  'reviewSection.verdictReason': { zh: '（{reason}）', en: ' ({reason})' },
  'reviewSection.recordedAt': { zh: '{source} · {time} 记录', en: '{source} · recorded {time}' },
  'reviewSection.fallbackVerdict': { zh: '复核{verdict}', en: 'Review: {verdict}' },
  'reviewSection.fallbackNote': {
    zh: '没有最终报告，这是从最后几行输出里猜的',
    en: 'No final report; this is guessed from the last lines of output',
  },
  'reviewSection.technicalTitle': { zh: 'coordinator 核验', en: 'Coordinator review' },
  'reviewSection.signOffTitle': { zh: '验收', en: 'Sign-off' },
  'reviewSection.technicalHint': {
    zh: '这是技术活的交回档案：核验交回的东西、跑没跑过，归 coordinator，不用你在处理堆里等。下面的验收与退回本是 coordinator 的动作，由在管看板的人代按——按下去记录写的是 owner（点按钮的你），不是 coordinator。想先看一遍，把名册里的冒险者拖到这张委托上，或在下面挑一个——那只是请模型复核，不等于验收；能复核的亮绿，写过这份活的亮红。',
    en: 'This is the returned work for a technical task: verifying what came back and whether it runs belongs to the coordinator, so you do not need to wait in the queue for it. The sign-off and send-back controls below are really the coordinator’s actions, clicked here by whoever is minding the board — the record they write says owner (whoever clicked), never coordinator. To look it over first, drag an adventurer from the roster onto this quest, or pick one below — that only asks a model to review, it is not a sign-off; one able to review lights up green, one who already worked on it lights up red.',
  },
  'reviewSection.signOffHint': {
    zh: '先看下面的「证据」和「交回的东西」：没问题就验收；要改就写明哪里不对再退回。想先让模型复核，把名册里的冒险者拖到这张委托上——能复核的亮绿，写过这份活的亮红。',
    en: 'Look at the “Evidence” and “What was returned” below first: sign off if it is fine, or say what is wrong and send it back if it needs changes. To have a model review it first, drag an adventurer from the roster onto this quest — one able to review lights up green, one who already worked on it lights up red.',
  },
  'reviewSection.noReport': { zh: '没有记录复核报告', en: 'No review report recorded' },
  'reviewSection.noVerdict': { zh: '还没有复核结论', en: 'No review verdict yet' },
  'reviewSection.open': { zh: '打开', en: 'Open' },
  'reviewSection.pickReviewer': {
    zh: '也可以在这里挑冒险者复核（{count} 个冒险者能复核）',
    en: 'You can also pick an adventurer to review here ({count} available)',
  },
  'reviewSection.noReviewer': { zh: '现在没有能复核它的冒险者', en: 'No adventurer can review it right now' },
  'reviewSection.modelLabel': { zh: '模型 {model} · 接入方式 {lane}', en: 'Model {model} · lane {lane}' },
  'reviewSection.sendToReview': { zh: '派去复核', en: 'Send to review' },
  'reviewSection.draftPlaceholder': {
    zh: '验收备注（可不写）；退回时必须写原因',
    en: 'Sign-off note (optional); a reason is required when sending back',
  },
  'reviewSection.sendBack': { zh: '退回重做', en: 'Send back for redo' },
  'reviewSection.accept': { zh: '验收', en: 'Sign off' },
  'reviewSection.confirmAccept': { zh: '{id} 验收，标成已完成？', en: 'Sign off {id} and mark it done?' },
  'reviewSection.acceptFailed': { zh: '验收没成功', en: 'Sign-off failed' },
  'reviewSection.acceptedTechnical': {
    zh: '{id} 已验收：点的是你，记录写 owner；这类活的核验责任仍在 coordinator。',
    en: '{id} signed off: you clicked, recorded as owner; verification responsibility for this kind of work still belongs to the coordinator.',
  },
  'reviewSection.acceptedOwner': { zh: '{id} 已验收（owner）', en: '{id} signed off (owner)' },
  'reviewSection.sendBackReasonRequired': {
    zh: '退回要写明哪里不对，下一个接手的冒险者要看',
    en: 'Sending back requires saying what is wrong, for the next adventurer to see',
  },
  'reviewSection.confirmSendBack': { zh: '把 {id} 退回委托板重做？', en: 'Send {id} back to the board for redo?' },
  'reviewSection.sendBackFailed': { zh: '退回没成功', en: 'Send-back failed' },
  'reviewSection.sentBack': { zh: '{id} 已退回，回到委托板', en: '{id} sent back to the board' },
  // quest/QuestReceipt.tsx
  'questReceipt.copy': { zh: '复制', en: 'Copy' },
  'questReceipt.copied': { zh: '已复制', en: 'Copied' },
  'questReceipt.copyFailed': { zh: '复制失败，请手动复制', en: 'Copy failed; copy it by hand' },
  'questReceipt.finalReportTitle': { zh: '最终报告', en: 'Final report' },
  'questReceipt.summaryLoading': { zh: '摘要读取中…', en: 'Reading the summary…' },
  'questReceipt.summaryLoadFailed': { zh: '摘要读取失败：{error}', en: 'Could not read the summary: {error}' },
  'questReceipt.noParagraph': { zh: '没有可读的摘要段落', en: 'No readable summary paragraph' },
  'questReceipt.noSummary': { zh: '没有可读的摘要', en: 'No readable summary' },
  'questReceipt.collapseReport': { zh: '收起完整报告', en: 'Collapse the full report' },
  'questReceipt.viewReport': { zh: '查看完整报告', en: 'View the full report' },
  'questReceipt.noRecord': { zh: '没有记录', en: 'No record' },
  'questReceipt.stepLine': { zh: '{name}：{value}', en: '{name}: {value}' },
  'questReceipt.editTests': {
    zh: '编辑测试：{passed}/{total} 通过，失败 {failed}',
    en: 'Edit tests: {passed}/{total} passed, {failed} failed',
  },
  'questReceipt.runTests': {
    zh: '运行测试：{passed}/{total} 通过，失败 {failed}',
    en: 'Run tests: {passed}/{total} passed, {failed} failed',
  },
  'questReceipt.overallStatus': { zh: '总状态：{status}', en: 'Overall: {status}' },
  'questReceipt.notDone': { zh: '还没完成', en: 'Not done yet' },
  'questReceipt.ariaLabel': { zh: '交回的东西', en: 'What was returned' },
  'questReceipt.deliveredTitle': { zh: '冒险者交回的东西', en: 'What the adventurer returned' },
  'questReceipt.ownSummary': { zh: '它自己的总结', en: 'Its own summary' },
  'questReceipt.recentRecord': { zh: '最近记录', en: 'Most recent record' },
  'questReceipt.detailSeparator': { zh: '：', en: ': ' },
  'questReceipt.allowedFiles': { zh: '委托书允许改的文件：{files}', en: 'Files the brief allows changing: {files}' },
  'questReceipt.lastDispatch': {
    zh: '最近一次派出：{model} · 接入方式 {lane} · 编号 {name} · {time}',
    en: 'Last dispatched: {model} · lane {lane} · id {name} · {time}',
  },
  'questReceipt.live': { zh: '现场：{state} · {ago} · {edits} 处改动', en: 'Live: {state} · {ago} · {edits} edits' },
  'questReceipt.noDelivery': { zh: '还没有交回任何东西', en: 'Nothing returned yet' },
  'questReceipt.projectTestsTitle': {
    zh: '项目整体测试（整个项目最近一次，不是这个委托专属的）',
    en: 'Project-wide tests (latest run of the whole project, not specific to this quest)',
  },
  // quest/ReportPanel.tsx
  'reportPanel.unavailablePrefix': { zh: '报告不可用：', en: 'Report unavailable: ' },
  'reportPanel.changed': {
    zh: '报告在记录之后变过，不再当作同一份显示',
    en: 'The report changed after it was recorded; it is no longer treated as the same one.',
  },
  'reportPanel.serverError': { zh: '服务器读取报告出错：{message}', en: 'The server failed to read the report: {message}' },
  'reportPanel.networkError': {
    zh: '没读到报告（网络请求失败）：{message}',
    en: 'Could not read the report (network request failed): {message}',
  },
  'reportPanel.ariaLabel': { zh: '完整报告', en: 'Full report' },
  'reportPanel.title': { zh: '完整报告', en: 'Full report' },
  'reportPanel.collapse': { zh: '收起', en: 'Collapse' },
  'reportPanel.loading': { zh: '读取中…', en: 'Reading…' },
  // ReviewView.tsx (lib/reviewList.ts's own generated text — summaries, progress labels, empty messages —
  // stays Chinese-only: it is a different file, out of this slice's scope)
  'reviewView.filterAll': { zh: '全部', en: 'All' },
  'reviewView.filterAvailable': { zh: '有统计', en: 'Has stats' },
  'reviewView.filterUnavailable': { zh: '统计不可用', en: 'Stats unavailable' },
  'reviewView.annotationProgressAria': { zh: '{title} 批注进度', en: '{title} annotation progress' },
  'reviewView.redoAction': { zh: '发起重做委托', en: 'Start a redo quest' },
  'reviewView.redoActionAria': { zh: '为 {id} 发起重做委托', en: 'Start a redo quest for {id}' },
  'reviewView.noRedoNote': {
    zh: '这是手写的页面，没有页面编号，没法从这里发起重做',
    en: 'This is a hand-written page with no page id; a redo cannot be started from here',
  },
  'reviewView.sidebarAria': { zh: '评审页列表', en: 'Review page list' },
  'reviewView.listEyebrow': { zh: '评审列表', en: 'Review list' },
  'reviewView.listTitle': { zh: '评审顺序', en: 'Review order' },
  'reviewView.searchPlaceholder': { zh: '搜索标题或页面 ID', en: 'Search title or page id' },
  'reviewView.searchAria': { zh: '搜索评审页', en: 'Search review pages' },
  'reviewView.statsFilterAria': { zh: '按统计可用性筛选', en: 'Filter by stats availability' },
  'reviewView.onlyUnanswered': { zh: '只看未处理', en: 'Only unanswered' },
  'reviewView.noPagesShort': { zh: '暂无评审页', en: 'No review pages yet' },
  'reviewView.selectedHiddenNote': {
    zh: '当前选中的页面不在筛选结果中，右侧仍可继续查看；调整筛选或搜索可以重新看到它。',
    en: 'The selected page is not in the filtered results; you can keep viewing it on the right. Adjust the filter or search to see it again.',
  },
  'reviewView.pageListAria': { zh: '评审页顺序', en: 'Review page order' },
  'reviewView.noPagesLong': {
    zh: '暂无评审页，页面加载后会显示在这里。',
    en: 'No review pages yet; they will show here once loaded.',
  },
  'reviewView.readerAria': { zh: '评审阅读区', en: 'Review reading area' },
  'reviewView.currentReview': { zh: '当前评审', en: 'Current review' },
  'reviewView.noPageSelected': { zh: '还没有选择评审页', en: 'No review page selected yet' },
  'reviewView.reload': { zh: '重新载入', en: 'Reload' },
  'reviewView.openNewWindow': { zh: '新窗口打开 ↗', en: 'Open in a new window ↗' },
  'reviewView.continuousAria': { zh: '连续评审', en: 'Continuous review' },
  'reviewView.prevPage': { zh: '← 上一份', en: '← Previous' },
  'reviewView.nextUnanswered': { zh: '下一份未处理', en: 'Next unanswered' },
  'reviewView.clearFilters': { zh: '清空筛选', en: 'Clear filters' },
  'reviewView.nextPage': { zh: '下一份 →', en: 'Next →' },
  'reviewView.collapseList': { zh: '收起列表', en: 'Collapse list' },
  'reviewView.expandList': { zh: '展开列表', en: 'Expand list' },
  'reviewView.artReviewPage': { zh: '美术评审页', en: 'Art review page' },
  'reviewView.pickFromLeft': { zh: '先从左侧选择一份评审页。', en: 'Pick a review page from the left first.' },
  'reviewView.readerHint': {
    zh: '打开后，按页面内容写批注或给出判断；完成一份再继续下一份。',
    en: 'Once open, write annotations or a verdict on the page content; finish one before moving to the next.',
  },
} satisfies Record<string, Translation>;

export type I18nKey = keyof typeof TRANSLATIONS;

export type I18nVars = Record<string, string | number>;

export type Translate = (key: I18nKey, vars?: I18nVars) => string;

function fillTemplate(template: string, vars?: I18nVars): string {
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

function translate(locale: Locale, key: I18nKey, vars?: I18nVars): string {
  const entry: Translation = TRANSLATIONS[key];
  const template = locale === 'en' && entry.en !== undefined ? entry.en : entry.zh;
  return fillTemplate(template, vars);
}

/** Translate for code outside a component render (label tables, exported helpers). Components should use
 * `useT()` so they re-render when the language changes. */
export function t(key: I18nKey, vars?: I18nVars): string {
  return translate(getLocale(), key, vars);
}

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
}

function browserStorage(): LocaleStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** A malformed or hand-edited value, or a browser that refuses site data, degrades to the default — this
 * preference is a convenience, so a bad read must never break the page. */
export function loadLocale(storage: LocaleStorage | null = browserStorage()): Locale {
  try {
    const raw = storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
    return isLocale(raw) ? raw : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function saveLocale(next: Locale, storage: LocaleStorage | null = browserStorage()): void {
  try {
    storage?.setItem?.(LOCALE_STORAGE_KEY, next);
  } catch {
    // Blocked storage just means the choice will not survive a reload; the page itself is unaffected.
  }
}

let currentLocale: Locale = DEFAULT_LOCALE;
let initialized = false;
const listeners = new Set<() => void>();

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  currentLocale = loadLocale();
}

export function getLocale(): Locale {
  ensureInitialized();
  return currentLocale;
}

export function setLocale(next: Locale, storage?: LocaleStorage | null): void {
  ensureInitialized();
  if (next === currentLocale) return;
  currentLocale = next;
  saveLocale(next, storage);
  for (const listener of [...listeners]) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getLocaleServerSnapshot(): Locale {
  return getLocale();
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocaleServerSnapshot);
}

export function useT(): Translate {
  const locale = useLocale();
  return useCallback<Translate>((key, vars) => translate(locale, key, vars), [locale]);
}
