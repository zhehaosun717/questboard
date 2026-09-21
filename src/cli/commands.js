// CLI commands. Writes go through the running server (one writer per project); `watch`, `roster import`
// and `card status` work on local files so they keep working while the server restarts.
import fs from 'node:fs';
import path from 'node:path';
import { option, optionAll, projectConfig, serverUrl, request } from './client.js';
import { validateAcceptanceShape } from '../core/acceptance.js';
import { startServer } from '../server/server.js';
import { validateBoardPort, DEFAULT_PORT, CONFIG_FILE, readRawConfig, saveProjectConfig, findProjectRoot } from '../core/config.js';
import { homePaths } from '../core/home.js';
import { splitLegacyRoster } from '../core/legacy.js';
import { loadRosterOrEmpty, saveRoster, upsertAdventurer } from '../core/roster.js';
import { execFileSync } from 'node:child_process';
import { planRosterImport, importPlanText, importDetailLines, parseOpencodeModelsVerbose, planOpencodeImport } from '../core/rosterImport.js';
import { StatusLog, foldStatuses } from '../core/status.js';
import { appendJsonLine, readJsonLines } from '../core/jsonl.js';
import { projectId } from '../core/snapshot.js';
import { QUEST_ORIGINS, QUEST_STATUSES } from '../core/store.js';
import { watchEvents } from './watch.js';

const out = (text) => process.stdout.write(`${text}\n`);

// The first bare word, skipping flags and the values they take.
function positional(args, flagsWithValues = []) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) return arg;
    if (flagsWithValues.includes(arg)) index += 1;
  }
  return undefined;
}

function positionals(args, flagsWithValues = []) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flagsWithValues.includes(arg)) { index += 1; continue; }
    if (!arg.startsWith('--')) values.push(arg);
  }
  return values;
}

// A `--port` override, validated the same way the config file's own port is (range, finiteness, browser-
// unsafe list — see validateBoardPort in core/config.js), before the server starts. An omitted flag keeps
// the project's configured port as the default; an *invalid* one (0, NaN, out of range, a blocked port,
// a fraction) is refused here rather than silently replaced the way `options.port || options.config.port`
// would replace a falsy 0 or NaN.
export function parsePortOption(raw) {
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw.trim())) throw new Error(`questboard: --port 必须是 1 到 65535 之间的整数，收到 "${raw}"`);
  return validateBoardPort(Number(raw), '--port');
}

// Feedback 15: `--evidence-ref kind=report,digest=<sha>,attemptId=<id>` (repeatable). Parsed here only into
// the small ref shape the server matches against real evidence (src/core/acceptance.js) — this file never
// decides whether a ref is real, it only reads the flag the coordinator typed.
function parseEvidenceRef(raw) {
  const ref = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (['kind', 'ref', 'digest', 'attemptId'].includes(key)) ref[key] = value;
  }
  if (!ref.kind) throw new Error(`--evidence-ref 格式不对，至少要有 kind：${raw}（例：kind=report,digest=<sha256>,attemptId=<id>）`);
  return ref;
}

function questLine(quest) {
  const who = quest.assignee ? ` <- ${quest.assignee.model} (${quest.assignee.name})` : '';
  const owner = quest.needsOwner ? ` [等裁决: ${quest.needsOwner}]` : '';
  return `${quest.id.padEnd(16)} ${quest.status.padEnd(14)} ${quest.kind.padEnd(6)} ${quest.title}${who}${owner}`;
}

function heartbeatLine(live) {
  const ageMs = live?.heartbeat?.ageMs;
  return Number.isFinite(ageMs) ? `  最近心跳：${Math.max(0, Math.floor(ageMs / 1000))} 秒前` : null;
}

// FB2-06 item 6: repeatable --env KEY=VALUE for card add/edit. The shape is parsed here; whether the name
// and value are allowed on a card is roster.js's call (validateCardEnv), exactly like a board-side write.
function parseEnvFlags(args) {
  if (!args.includes('--env')) return null;
  const env = {};
  for (const raw of optionAll(args, '--env')) {
    const eq = raw.indexOf('=');
    if (eq < 0 || !raw.slice(0, eq).trim()) throw new Error(`--env 后面要跟 KEY=VALUE，收到「${raw}」（例：--env OC_BASE_URL=http://provider.example/base）`);
    env[raw.slice(0, eq).trim()] = raw.slice(eq + 1);
  }
  return env;
}

function context(args) {
  const config = projectConfig(args);
  return { config, base: serverUrl(args, config) };
}

// One quest in readable lines. Labels follow the board's everyday wording; --json is the agent-facing form.
// Exported so the CLI tests can pin the exact detail rendering (the report lines especially).
// FB2-06 item 1: a long card list (可接手, each refusal's cards) shows the first five plus 「等 N 张」in
// readable mode; --json or --all prints the full list. `truncate` is the readable default.
const CARD_LIST_CAP = 5;

function cardListText(list, truncate, separator = '、') {
  const cards = Array.isArray(list) ? list : [];
  if (!truncate || cards.length <= CARD_LIST_CAP) return cards.join(separator);
  return `${cards.slice(0, CARD_LIST_CAP).join(separator)} 等 ${cards.length - CARD_LIST_CAP} 张`;
}

export function questDetailText(quest, { truncate = true } = {}) {
  const REPORT_SOURCE_ZH = { delivery: '交差文件', 'exit-file': '退出文件', summary: '运行记录 .out' };
  const VERDICT_ZH = { PASS: '通过', FAIL: '不通过', findings: '通过但有问题' };
  const lines = [questLine(quest)];
  lines.push(`  第 ${quest.revision || 0} 版 · priority ${quest.priority} · brief ${quest.brief || '无'}`);
  // FB2-04 item 5: the batch roster and the delivery it waits for.
  if ((quest.batch || []).length > 1) lines.push(`  一批: 和 ${quest.batch.filter((id) => id !== quest.id && id !== quest.waitingOn).join('、')}${quest.waitingOn ? ` · 等 ${quest.waitingOn}` : ''}`);
  if (quest.lastDetail) lines.push(`  最近: ${quest.lastDetail}`);
  // The attempt's own report reference, verdict and first paragraph (items 7/12/34), as the detail route
  // exposes them. Null on legacy rows and stale attempts; a capture that found nothing still says why.
  const report = quest.report || null;
  if (report && report.source !== 'none') {
    const source = REPORT_SOURCE_ZH[report.source] ?? report.source;
    lines.push(`  报告: ${report.ref}（${source}，sha256 ${String(report.digest || '').slice(0, 12)}…${report.truncated ? '，已截断' : ''}）`);
    const verdict = report.verdict || {};
    if (VERDICT_ZH[verdict.verdict]) lines.push(`  结论: ${VERDICT_ZH[verdict.verdict]}${verdict.line ? `（原文：${verdict.line}）` : ''}`);
    else if (verdict.reason) lines.push(`  结论: 不确定（${verdict.reason}）`);
    else lines.push('  结论: 不确定（报告里没有找到明确的 VERDICT 行）');
    const summary = report.summary || {};
    if (summary.paragraph) lines.push(`  摘要: ${summary.heading ? `${summary.heading} — ` : ''}${summary.paragraph}${summary.hasMore ? ' …' : ''}`);
  } else if (report && report.source === 'none') {
    lines.push(`  报告: 不可用（${report.reason}）`);
  } else if (['delivered', 'failed', 'bounced'].includes(quest.status)) {
    lines.push('  报告: 不可用（这次派遣没有留下报告引用）');
  }
  // FB2-02 item 6: the review page's annotation summary — count, verdict split, first notes.
  const annotations = quest.annotationSummary || null;
  if (annotations && annotations.error) lines.push(`  批注: 读取失败（${annotations.error}）`);
  else if (annotations) {
    const counts = `通过 ${annotations.pass} / 不行 ${annotations.fail} / 需要修改 ${annotations.fix}${annotations.other ? ` / 未表态 ${annotations.other}` : ''}`;
    lines.push(`  批注 ${annotations.total} 条（${annotations.page}）: ${counts}`);
    for (const item of annotations.first || []) lines.push(`    - [${item.verdict || '未表态'}] ${item.note}`);
  }
  // FB2-03: the pre-dispatch gates a reader cares about — what replaces or replaced this quest, any hold
  // and its reason, and the capabilities a card must declare.
  if (quest.supersededBy) lines.push(`  取代: 被 ${quest.supersededBy} 取代`);
  else if ((quest.supersedes || []).length) lines.push(`  取代: 取代了 ${quest.supersedes.join('、')}`);
  if (quest.hold) lines.push(`  挂起: ${quest.hold}`);
  if ((quest.needs || []).length) lines.push(`  需要能力: ${quest.needs.join(', ')}`);
  if (quest.origin) lines.push(`  快速通道: coordinator 快速通道：${quest.check || quest.origin}`);
  lines.push(`  可改文件: ${(quest.files || []).join(', ') || '无'}`);
  // FB2-12 item 2: a dispatch the coordinator made under the fast track is marked as such in the history,
  // with the check that produced the card.
  const fastTrack = quest.origin ? `（快速通道：${quest.check || quest.origin}）` : '';
  for (const d of quest.dispatches || []) lines.push(`  派单: ${d.at} ${d.model} (${d.name}) 由 ${d.by}${d.by === 'coordinator' && quest.origin ? fastTrack : ''}${d.adopted ? '（接管已在跑的 worker）' : ''}${d.requestKey ? ` key=${d.requestKey}` : ''}`);
  for (const r of quest.rulings || []) lines.push(`  裁决: ${r.at} ${r.by}: ${r.text}`);
  if ((quest.threads || []).length) lines.push(`  相关消息: ${quest.threads.map((t) => `${t.id} ${t.title}${t.closed ? '（已关）' : ''}`).join('；')}`);
  const eligibility = quest.eligibility || {};
  lines.push(`  可接手: ${cardListText(eligibility.canTake || [], truncate, ', ') || '没有'}`);
  for (const [message, cards] of Object.entries(eligibility.refused || {})) lines.push(`  不可（${cardListText(cards || [], truncate)}）: ${message}`);
  return lines.join('\n');
}

// A card's own status history existing at all disqualifies an import from touching it (see rosterImport.js);
// this only decides what date an accepted *first* record carries. `statusChangedAt` on the legacy card
// itself is a genuine, owner-authored date and is preserved as-is. Its absence means the fallback the
// caller passed (the import file's own mtime) is standing in for a real date it does not have — that is
// documented on the record's reason, never presented as though the file's timestamp were an owner decision.
const UNDATED_PROVENANCE_NOTE = '（导入：以上时间是估算值——按导入文件的修改时间记录，不代表 owner 在那一刻做了决定）';

function markProvenance(statusRecords, genuineDates) {
  return statusRecords.map((record) => {
    if (genuineDates.get(record.adventurerId)) return record;
    const reason = record.reason ? `${record.reason} ${UNDATED_PROVENANCE_NOTE}` : UNDATED_PROVENANCE_NOTE;
    return { ...record, reason };
  });
}

// roster.js's own JSON-parse failure path can, on some Node versions, fold a slice of the offending file
// into `error.message`. That file might be the shared machine roster, so its message is never surfaced
// verbatim here — only the fact that it could not be read.
function readExistingRoster(rosterFile) {
  try {
    return loadRosterOrEmpty(rosterFile);
  } catch (error) {
    if (/^roster: cannot read /.test(error.message)) throw new Error(`roster: ${rosterFile} contains malformed JSON and could not be read`);
    throw error; // a shape-validation failure (bad field, duplicate id, ...) never echoes file content
  }
}

// Exclusive creation with a deterministic, collision-proof suffix: two changing imports in the same second
// each keep their own backup instead of the second silently overwriting the first. `tag` names the write
// that made the backup (merge/replace imports, a card edit), so the file shelf stays readable.
function backupRosterFile(rosterFile, replace, tag = null) {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const suffix = tag ? `-${tag}` : (replace ? '-replace' : '-merge');
  for (let attempt = 1; ; attempt += 1) {
    const backup = `${rosterFile}.bak-${timestamp}-${attempt}${suffix}`;
    try {
      fs.copyFileSync(rosterFile, backup, fs.constants.COPYFILE_EXCL);
      return backup;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

export const commands = {
  // Makes a folder ready to use, so a new machine needs one command instead of six.
  async init(args) {
    const { runInit, parseLaneFlag } = await import('./init.js');
    const result = runInit({
      dir: positional(args, ['--name', '--port', '--lane']),
      name: option(args, '--name'),
      port: option(args, '--port') ? Number(option(args, '--port')) : undefined,
      force: args.includes('--force'),
      extraLanes: optionAll(args, '--lane').map(parseLaneFlag),
      home: homePaths(),
    });
    out(`项目已就绪：${result.root}`);
    for (const file of result.created) out(`  + ${file}`);
    if (result.rosterCreated) out(`  + ${result.rosterFile}（空名册）`);
    if (result.custom.length) out(`按你指定的写了通道：${result.custom.join('、')}`);
    if (result.detected.length) out(`检测到已安装：${result.detected.join('、')}，已写好对应通道`);
    if (result.manual.length) out(`另外检测到 ${result.manual.join('、')}：它们不是从 stdin 读提示词，要用 --lane ${result.manual[0]}="<你的命令>" 自己指定（见 README 的 Project config 一节）`);
    out('\n接下来：');
    out(`  questboard card add --id my-card --name "我的卡" --provider my-provider --lane ${result.lanes[0]} --model <模型 id>`);
    out(`  questboard serve --project ${result.root}`);
    out('  然后打开 http://127.0.0.1:' + (option(args, '--port') || DEFAULT_PORT) + '/ ，把卡拖到任务上');
  },

  async serve(args) {
    const config = projectConfig(args);
    const port = parsePortOption(option(args, '--port'));
    startServer({ config, port });
  },

  // The port lives in the project config — the very file you cannot reach when that port is taken, because
  // the page that edits it is the page that will not open. Only `port` changes: the rest of the file is
  // written back byte-for-value as it was, and saveProjectConfig keeps the same timestamped backup the
  // settings page keeps. Read raw (not loadProjectConfig) on purpose, so a config whose port is *already*
  // refused — blocked by the browser, out of range, missing — can still be repaired from here.
  async port(args) {
    const wanted = positional(args, ['--project']);
    if (wanted === undefined) {
      throw new Error('usage: questboard port <n> [--project <dir>]　（把项目配置里的端口改成 n，比如 6098；旧配置留一份带时间的备份，改完重启看板服务器才生效）');
    }
    const port = parsePortOption(wanted);
    const dir = option(args, '--project') || process.env.QUESTBOARD_PROJECT || findProjectRoot();
    if (!dir) throw new Error('no questboard.config.json here or in any parent folder; run inside a project or pass --project <dir>');
    const raw = readRawConfig(dir);
    if (!raw) throw new Error(`读不到 ${path.join(dir, CONFIG_FILE)}，或者它不是 JSON 对象`);
    const previous = raw.port === undefined ? DEFAULT_PORT : raw.port;
    saveProjectConfig(dir, { ...raw, port });
    out(`端口 ${previous} → ${port}（${path.join(dir, CONFIG_FILE)}）`);
    out('重启看板服务器后生效。');
  },

  async post(args) {
    const { base } = context(args);
    // FB2-05 item 3: how the delivery gets reviewed. Validated locally first so a wrong flag is refused
    // with the exact rule before the round trip; the server validates the same fields again.
    const review = option(args, '--review');
    if (review !== undefined && !['none', 'mechanical', 'model'].includes(review)) {
      throw new Error('--review 只能是 none、mechanical 或 model（默认 model）');
    }
    const mechanicalCheck = option(args, '--mechanical-check');
    if (review === 'mechanical' && !mechanicalCheck) throw new Error('--review mechanical 需要 --mechanical-check "命令"（交付后自动跑一次的命令）');
    if (review !== 'mechanical' && mechanicalCheck) throw new Error('--mechanical-check 只在 --review mechanical 时有效');
    // FB2-12 item 2: where this quest came from. Validated here with the same rule the server applies, so a
    // typo is refused before the round trip instead of coming back as a refusal at assign time.
    const origin = option(args, '--origin');
    const check = option(args, '--check');
    if (origin !== undefined && !QUEST_ORIGINS.includes(origin)) {
      throw new Error(`--origin 只能是 machine-check 或 post-delivery-check（例：--origin machine-check --check "unity recompile"）`);
    }
    if (origin !== undefined && check === undefined) throw new Error('--origin 需要 --check "哪条检查失败"：卡面要显示是哪个检查触发的');
    if (check !== undefined && origin === undefined) throw new Error('--check 只在给了 --origin 时才有意义（例：--origin machine-check --check "unity recompile"）');
    const { quest } = await request(base, '/api/quests', 'POST', {
      package: option(args, '--package'), brief: option(args, '--brief'), kind: option(args, '--kind'),
      parents: option(args, '--parents'), conflicts: option(args, '--conflicts'), allowedLanes: option(args, '--lanes'),
      priority: option(args, '--priority'), needsOwner: option(args, '--needs-owner'), reviewPage: option(args, '--review-page'),
      title: option(args, '--title'), supersedes: option(args, '--supersedes'), hold: option(args, '--hold'),
      needs: option(args, '--needs'), files: option(args, '--files'), by: option(args, '--by') || 'coordinator',
      review, mechanicalCheck, origin, check,
    });
    out(questLine(quest));
    if (quest.review === 'mechanical') out('  复核方式：交付后自动跑机械自检并记录结论');
    if (quest.review === 'none') out('  复核方式：交付后等 coordinator 验证');
    // FB2-12 item 2: the poster sees that this card is on the fast track, exactly as the card face shows it.
    if (quest.origin) out(`  快速通道: coordinator 快速通道：${quest.check || quest.origin}`);
    // FB2-03 item 30: the poster sees the file set they signed up for, right here.
    if (quest.files !== undefined) out('  可改文件（' + (quest.filesSource === 'override' ? '显式指定' : 'brief 抽取') + '）: ' + (quest.files.join(', ') || '无'));
  },

  // Revision-guarded correction of a posted quest's own descriptive fields (title/brief/parents/conflicts/
  // allowedLanes/needsOwner) — never status or assignee, and refused outright while the quest holds a
  // worker's slot. Only flags actually passed are sent, so a field left out is never touched or re-saved.
  async update(args) {
    const { base } = context(args);
    const id = positional(args, ['--title', '--brief', '--parents', '--conflicts', '--lanes', '--needs-owner', '--hold', '--needs', '--files', '--review-page', '--if-revision', '--by', '--project', '--url']);
    if (!id) {
      throw new Error('usage: questboard update <id> [--title "..."] [--brief docs/briefs/x.md] [--parents A-1,B-2] '
        + '[--conflicts C-3] [--lanes codex,agy] [--needs-owner "question"] [--hold "原因，空串解除"] [--needs runs-node,web] [--files a,b] [--review-page robot8] [--if-revision 3] [--by who]　'
        + '只改传了的字段，其余不动；worker 占着这个任务时会被拒绝，先 release 再改');
    }
    const payload = { by: option(args, '--by') || 'owner' };
    if (option(args, '--if-revision') !== undefined) payload.ifRevision = option(args, '--if-revision');
    for (const [flag, field] of [
      ['--title', 'title'], ['--brief', 'brief'], ['--parents', 'parents'],
      ['--conflicts', 'conflicts'], ['--lanes', 'allowedLanes'], ['--needs-owner', 'needsOwner'], ['--hold', 'hold'], ['--needs', 'needs'], ['--files', 'files'], ['--review-page', 'reviewPage'],
    ]) {
      const value = option(args, flag);
      if (value !== undefined) payload[field] = value;
    }
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(id)}/metadata`, 'POST', payload);
    out(questLine(quest));
  },

  // FB2-04 item 5: questboard batch FIX-44,FIX-45 --waiting-on FIX-48 marks every listed quest with the
  // batch roster and the one delivery they wait for; the card face reads 「和 X、Y 一批 · 等 Z」 and the
  // waitingOn quest's delivery reminds the coordinator the batch is ready for acceptance.
  async batch(args) {
    const { base } = context(args);
    const id = positional(args, ['--waiting-on', '--by', '--project', '--url']);
    const ids = (id || '').split(',').map((part) => part.trim()).filter(Boolean);
    if (ids.length < 2) {
      throw new Error('usage: questboard batch <FIX-44,FIX-45,...> [--waiting-on FIX-48] [--by who]　一批至少两张卡；卡面会显示「和 … 一批 · 等 …」');
    }
    const waitingOn = option(args, '--waiting-on');
    for (const questId of ids) {
      const payload = { batch: ids.join(','), by: option(args, '--by') || 'owner' };
      if (waitingOn !== undefined) payload.waitingOn = waitingOn;
      const { quest } = await request(base, `/api/quests/${encodeURIComponent(questId)}/metadata`, 'POST', payload);
      const mates = ids.filter((other) => other !== questId);
      out(questLine(quest) + '　一批: 和 ' + mates.join('、') + (waitingOn ? ' · 等 ' + waitingOn : ''));
    }
  },

  async list(args) {
    const { base } = context(args);
    const { quests } = await request(base, '/api/quests');
    const status = option(args, '--status');
    const shown = quests.filter((q) => !status || q.status === status);
    out(shown.length ? shown.map(questLine).join('\n') : 'No quests');
  },

  async status(args) {
    const { base } = context(args);
    // FB2-06 item 5: the status value may be a positional or --status; every other flag stays where it is.
    // A value outside the board's own status vocabulary is refused here, with a usage example, before any
    // request goes out — a typo must never become a silent no-op or a server-side English error.
    const manualStatuses = [...QUEST_STATUSES].filter((status) => status !== 'dispatched');
    const id = positional(args, ['--status', '--detail', '--by', '--evidence-ref', '--note', '--project', '--url']);
    if (!id) {
      throw new Error(`usage: questboard status <id> <status> [--status <status>] [--detail "..."] [--by coordinator|owner]　例：questboard status RUN-4 done --detail "验收完成"；status 只能是 ${manualStatuses.join('|')}（dispatched 只能靠 assign/adopt 到达）`);
    }
    const status = option(args, '--status') || positionals(args, ['--detail', '--by', '--evidence-ref', '--note', '--project', '--url']).find((value) => value !== id);
    if (!manualStatuses.includes(status)) {
      throw new Error(`usage: questboard status <id> <status> [--status <status>]　例：questboard status RUN-4 done --detail "验收完成"；收到不认识的 status「${status}」，只能是 ${manualStatuses.join('|')}`);
    }
    const by = option(args, '--by') || 'coordinator';
    // Feedback 15: --evidence-ref/--note build an acceptance record only for `status done`; actor is always
    // this request's own --by (default coordinator), so it can never claim an identity the request wasn't
    // recorded under. Shape-validated here so a bad flag is refused locally before the round trip; the server
    // still matches every ref against the quest's real current-attempt evidence.
    const evidenceRefs = optionAll(args, '--evidence-ref').map(parseEvidenceRef);
    const note = option(args, '--note');
    const acceptance = status === 'done' && (evidenceRefs.length > 0 || note !== undefined)
      ? validateAcceptanceShape({ actor: by, evidenceRefs, note })
      : undefined;
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(id)}/status`, 'POST', { status, detail: option(args, '--detail'), by, ...(acceptance ? { acceptance } : {}) }, { source: 'cli' });
    out(questLine(quest));
    const detail = await request(base, `/api/quests/${encodeURIComponent(id)}`).catch(() => null);
    const heartbeat = heartbeatLine(detail?.quest?.live);
    if (heartbeat) out(heartbeat);
  },

  async ruling(args) {
    const { base } = context(args);
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(args[0])}/ruling`, 'POST', { text: option(args, '--text'), by: option(args, '--by') || 'owner' });
    out(questLine(quest));
  },

  async assign(args) {
    const { config, base } = context(args);
    const requested = option(args, '--adventurer');
    // A preference never overrides an explicit choice: only a missing card falls back to 派遣规则 → 默认卡,
    // and the board says which card it picked and why before it does anything.
    const adventurer = requested === undefined ? config.policy.defaultCard || undefined : requested;
    if (requested === undefined && adventurer !== undefined) out(`没指定卡，用派遣规则里的默认卡「${adventurer}」`);
    if (adventurer) {
      // S3: a review quest's upstream check (src/core/rules.js reviewUpstreamEvidence) is judged here from
      // the same snapshot the board's own drop preview reads, so the CLI shows the identical warning or
      // refusal text before ever calling assign — never fabricates a pass by staying silent about it. Only a
      // review quest needs the extra snapshot fetch; every other kind assigns exactly as before.
      // F4: once the server enforces the policy itself (questRoutes.js assign branch), a failed detail fetch
      // here is harmless — assign below still gets the server's own refusal — but staying silent about it
      // would look like the local pre-check ran and found nothing to warn about. Say so instead.
      const detail = await request(base, `/api/quests/${encodeURIComponent(args[0])}`).catch(() => null);
      if (!detail) out('没能读取委托详情，跳过本地的复核前置检查，放不放行由服务器决定。');
      if (detail && detail.quest && detail.quest.kind === 'review') {
        const snap = await request(base, '/api/quests');
        const verdict = (snap.eligibility?.[args[0]] || {})[adventurer];
        if (verdict) {
          for (const w of verdict.warnings || []) out(`警告：${w.message}（${w.code}）`);
          if (!verdict.ok) {
            throw new Error(`拒绝派遣：\n${verdict.reasons.map((r) => `- ${r.message}（${r.code}）`).join('\n')}`);
          }
        }
      }
    }
    // X12: the header tells the owner in Chinese when the default card is not in the roster and where to fix
    // it; the CLI is the same owner-facing surface, so when that fallback card is the one the server refuses
    // by name, say the same sentence instead of the bare English `no adventurer <id>` line.
    // FB2-12 item 3: the coordinator's own fast-track limit (default 3). Refused locally when it is not a
    // positive integer — the limit decides whether the coordinator may dispatch at all, so a typo must not
    // quietly fall back to the default.
    const maxFilesRaw = option(args, '--max-files');
    let maxFiles;
    if (maxFilesRaw !== undefined) {
      maxFiles = Number(maxFilesRaw);
      if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error(`--max-files 要是正整数，收到「${maxFilesRaw}」（coordinator 直接派的小修复最多能改几个文件，默认 3）`);
    }
    const body = await request(base, `/api/quests/${encodeURIComponent(args[0])}/assign`, 'POST', {
      adventurer, by: option(args, '--by') || 'coordinator',
      requestKey: option(args, '--request-key'), ifRevision: option(args, '--if-revision'),
      ...(maxFiles === undefined ? {} : { maxFiles }),
    }).catch((error) => {
      if (requested === undefined && adventurer !== undefined
        && error instanceof Error && error.message === `no adventurer ${adventurer}`) {
        throw new Error(`默认卡「${adventurer}」不在名册里，去「派遣规则」改掉，或先把卡补进名册。`);
      }
      throw error;
    });
    out(`${questLine(body.quest)}${body.repeated ? '  (already dispatched under this request key; nothing new started)' : ''}`);
  },

  async adopt(args) {
    const { base } = context(args);
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(args[0])}/adopt`, 'POST', { adventurer: option(args, '--adventurer'), name: option(args, '--name'), by: option(args, '--by') || 'coordinator' });
    out(questLine(quest));
  },

  async get(args) {
    const { base } = context(args);
    const id = positional(args, ['--project', '--url']);
    if (!id) throw new Error('usage: questboard get <id> [--json] [--all] [--report] [--evidence]　读取一个委托的详情：第几版、当前 worker、派遣历史、最近动态、可改文件；--all 打印完整名单（默认长名单只列前 5 张）；--report 打印这次派遣的完整报告原文；--evidence 打印这次派遣的证据（模型自报、项目验证记录、验证钩子）');
    // --report asks the board for the bounded plain-text report itself, not the JSON detail: the reference
    // is re-verified there (digest + containment) and a report that changed after capture is refused.
    if (args.includes('--report')) {
      let response;
      try {
        response = await fetch(`${base}/api/quests/${encodeURIComponent(id)}/report`);
      } catch {
        throw new Error(`看板服务没在 ${base} 运行。先运行：questboard serve`);
      }
      if (!response.ok) {
        const value = await response.json().catch(() => ({}));
        throw new Error(value.error || `HTTP ${response.status}`);
      }
      const text = await response.text();
      // The route marks a capped read with a header, not in the body: without this notice the CLI would
      // print the first 2 MB as though it were the whole report (review round 1, B3).
      if (response.headers.get('x-report-truncated') === '1') {
        const contentLength = response.headers.get('content-length');
        const shown = contentLength ? `前 ${contentLength} 字节` : '前一部分字节';
        process.stderr.write(`报告没有读完整，只显示了${shown}，不是完整报告\n`);
      }
      out(text);
      return;
    }
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(id)}`, 'GET');
    // --evidence prints only the structured evidence object (S2, src/core/evidence.js); an older server that
    // sends no `evidence` field says so instead of printing `undefined`.
    if (args.includes('--evidence')) {
      if (!quest.evidence) throw new Error(`${id} 没有证据数据：看板服务版本太旧，不提供这项数据`);
      // Feedback 15: the acceptance record (if any) rides alongside the evidence it was matched against —
      // additive, null on a quest never accepted or on an older server that predates the field.
      out(JSON.stringify({ ...quest.evidence, acceptance: quest.acceptance ?? null }, null, 2));
      return;
    }
    out(args.includes('--json') ? JSON.stringify(quest, null, 2) : questDetailText(quest, { truncate: !args.includes('--all') }));
  },

  async 'hook-log'(args) {
    const { base } = context(args);
    const [id, hookId] = positionals(args, ['--project', '--url']);
    if (!id || !hookId) throw new Error('usage: questboard hook-log <quest> <hookId>');
    let response;
    try {
      response = await fetch(`${base}/api/quests/${encodeURIComponent(id)}/hooks/${encodeURIComponent(hookId)}/log`);
    } catch {
      throw new Error(`questboard server is not running at ${base}. Start it with: questboard serve`);
    }
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(value.error || `HTTP ${response.status}`);
    }
    const text = await response.text();
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  },

  // Frees a stalled quest whose worker someone confirmed is gone. Says how, or the board keeps the slot:
  // it never forces a status, kills a process, or releases a quest that is not stalled (the server checks).
  async release(args) {
    const { base } = context(args);
    const id = positional(args, ['--project', '--url', '--detail', '--by']);
    const detail = String(option(args, '--detail') || '').trim();
    if (!id) throw new Error('usage: questboard release <id> --detail "怎么确认 worker 已经停了"　只释放 stalled 的任务');
    if (!detail) throw new Error('release 必须用 --detail 写清你怎么确认了 worker 已停止；沉默不等于离开');
    // A "--detail" whose value is the next flag (release X --detail --by x) carried no evidence;
    // prose in the middle of a sentence is untouched, only a leading flag token is refused.
    if (detail.startsWith('--')) throw new Error(`release 的 --detail 后面跟的是选项 "${detail}"，不是证据；请用 --detail "怎么确认 worker 已经停了" 写清理由`);
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(id)}/release`, 'POST', { detail, ack: true, by: option(args, '--by') || 'coordinator' }, { source: 'cli' });
    out(questLine(quest));
  },

  async cancel(args) {
    const CANCEL_RESULT = { manual_required: '无法自动停止，需要手动处理', stopped_by_wrapper: '包装脚本已停下它直接启动的进程', unknown: '不确定是否已停止' };
    const { base } = context(args);
    const id = positional(args, ['--project', '--url', '--reason', '--detail']);
    // FB2-06 item 8: --detail and --reason are the same thing here — the old --reason spelling and the
    // new --detail spelling both name the cancellation reason, and the docs/errors mention both.
    const reason = String(option(args, '--reason') ?? option(args, '--detail') ?? '').trim();
    if (!id) throw new Error('usage: questboard cancel <id> --reason "取消原因"（--detail 等价）');
    if (!reason || reason.startsWith('--')) throw new Error('cancel 必须用 --reason（或 --detail）写明取消原因');
    let result;
    try {
      result = await request(base, `/api/quests/${encodeURIComponent(id)}/cancel`, 'POST', { reason }, { source: 'cli' });
    } catch (error) {
      if (error?.message === 'quest not found') throw new Error('找不到任务');
      throw error;
    }
    const note = result.quest.cancelRequest?.detail || (result.note ? String(result.note) : '已记录取消请求，等待结果');
    out(`${questLine(result.quest)}  取消结果：${CANCEL_RESULT[result.result] ?? result.result}  ${note}`);
  },

  async resolve(args) {
    const { base } = context(args);
    const id = positional(args, ['--project', '--url', '--reason', '--detail']);
    // FB2-06 items 3/8: --detail and --reason are the same thing (--reason first when both are given), and
    // --reopen implies --ack: the quest frees its worker and lands back on posted, keeping its dispatch
    // history — the reopen is a plain status write after the resolve, so the audit trail stays one record.
    const reason = String(option(args, '--reason') ?? option(args, '--detail') ?? '').trim();
    const reopen = args.includes('--reopen');
    if (!id || (!args.includes('--ack') && !reopen)) throw new Error('usage: questboard resolve <id> --reason "你怎么确认 worker 已经停了" --ack [--reopen]　（--reopen 自带确认，并把任务放回 posted 重新招人，派单史保留；--detail 与 --reason 等价）');
    if (!reason || reason.startsWith('--')) throw new Error('resolve 必须用 --reason（或 --detail）写清你怎么确认 worker 已停止');
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(id)}/resolve`, 'POST', { reason, ack: true }, { source: 'cli' });
    out(questLine(quest));
    if (reopen) {
      const reopened = await request(base, `/api/quests/${encodeURIComponent(id)}/status`, 'POST', { status: 'posted', detail: 'resolve --reopen：确认 worker 已停，重新打开招人', by: option(args, '--by') || 'coordinator' }, { source: 'cli' });
      out(questLine(reopened.quest));
    }
  },

  async card(args) {
    const [sub, id, status] = args;
    const home = homePaths();
    if (sub === 'status' && id && status) {
      // A card status set from inside a project belongs to that project (owner decision 2026-09-17); run
      // outside any project it stays a machine-level note that every board shows.
      let scopedProjectId;
      try { scopedProjectId = projectId(projectConfig(args).root); } catch { scopedProjectId = undefined; }
      const entry = new StatusLog(home.status).set(id, { status, reason: option(args, '--reason') || '', setBy: option(args, '--by') || 'coordinator', ...(scopedProjectId ? { projectId: scopedProjectId } : {}) });
      out(`${id} ${entry.status} since ${entry.since}${entry.reason ? ` — ${entry.reason}` : ''}`);
      return;
    }
    if (sub === 'list') {
      const { base } = context(args);
      const { adventurers } = await request(base, '/api/roster');
      for (const a of adventurers) out(`${a.id.padEnd(20)} ${a.status.padEnd(10)} ${a.lane.padEnd(9)} ${a.model}${a.statusReason ? `  ${a.statusReason}` : ''}`);
      return;
    }
    // Writes the roster file directly, like `card status`, so it works before the server is running.
    if (sub === 'add') {
      const model = option(args, '--model');
      const entry = {
        id: option(args, '--id'),
        name: option(args, '--name'),
        provider: option(args, '--provider'),
        lane: option(args, '--lane'),
        model,
        // One underlying model reached through two providers is one author; default it to the model id.
        family: option(args, '--family') || model,
      };
      for (const [field, value] of Object.entries({ variant: option(args, '--variant'), agent: option(args, '--agent'), billing: option(args, '--billing'), notes: option(args, '--notes') })) {
        if (value !== undefined) entry[field] = value;
      }
      if (option(args, '--max-parallel') !== undefined) entry.maxParallel = Number(option(args, '--max-parallel'));
      if (option(args, '--strengths') !== undefined) entry.strengths = String(option(args, '--strengths')).split(',').map((s) => s.trim()).filter(Boolean);
      const env = parseEnvFlags(args);
      if (env !== null) entry.env = env;
      // upsertAdventurer already checks this entry strictly (built-in allowed shapes only, since this CLI has
      // no project's policy.cardEnvAllow); lenient here only means an unrelated, untouched card already on
      // the roster — allowed only by some project's cardEnvAllow — is not re-judged by this project-blind caller.
      saveRoster(home.roster, upsertAdventurer(loadRosterOrEmpty(home.roster), entry), { lenientEnv: true });
      out(`${entry.id}  ${entry.lane}  ${entry.model} -> ${home.roster}`);
      return;
    }
    // FB2-06 item 6: correct a card's facts in place. The whole card is re-validated before anything is
    // written, the roster file is backed up first (same helper the imports use), and only the fields the
    // caller actually passed change — an untouched field keeps its saved value, and --env merges per key.
    const editId = sub === 'edit' ? positional(args.slice(1), ['--name', '--model', '--variant', '--note', '--env']) : null;
    if (sub === 'edit' && editId) {
      const roster = loadRosterOrEmpty(home.roster);
      const card = roster.adventurers.find((a) => a.id === editId);
      if (!card) throw new Error(`${editId} 不在名册里（${home.roster}），先 card add 或用 card list 看一遍`);
      const patch = {};
      for (const [flag, field] of [['--name', 'name'], ['--model', 'model'], ['--variant', 'variant'], ['--note', 'notes']]) {
        const value = option(args, flag);
        if (value !== undefined) patch[field] = value;
      }
      const env = parseEnvFlags(args);
      const next = { ...card, ...patch, ...(env !== null ? { env: { ...(card.env || {}), ...env } } : {}) };
      backupRosterFile(home.roster, false, 'edit');
      saveRoster(home.roster, upsertAdventurer(roster, next), { lenientEnv: true });
      out(`${id}  ${next.lane}  ${next.model} -> ${home.roster}`);
      return;
    }
    throw new Error('usage: questboard card list | card add --id x --name X --provider P --lane codex --model m [--family m] [--variant high] [--agent build] [--billing subscription|plan|payg|free] [--max-parallel 1] [--strengths code,review] [--notes "..."] [--env KEY=VALUE ...] | card edit <id> [--name X] [--model M] [--variant V] [--note "..."] [--env KEY=VALUE ...] | card status <id> <available|limited|broke|paused|disabled> [--reason "..."] [--by who]');
  },

  async roster(args) {
    const [sub, file] = args;
    const home = homePaths();
    if (sub === 'path') { out(`roster: ${home.roster}\nstatus: ${home.status}`); return; }
    if (sub === 'init') {
      if (fs.existsSync(home.roster) && !args.includes('--force')) throw new Error(`${home.roster} exists; pass --force to replace it with an empty roster`);
      saveRoster(home.roster, { adventurers: [] });
      out(`empty roster at ${home.roster}\nadd cards on the board's 冒险者 tab, or with the questboard_* MCP tools`);
      return;
    }
    if (sub === 'import' && file) {
      const replace = args.includes('--replace');
      const dryRun = args.includes('--dry-run');
      const homeExists = fs.existsSync(home.roster);
      // --force only says "yes, go ahead"; the default is a merge, which cannot lose a card.
      // Only --replace erases cards the file lacks, and it demands --force to be honored.
      if (homeExists && !dryRun && !args.includes('--force')) {
        throw new Error(`${home.roster} exists; pass --force to merge the file into it by card id (local env, variants and extra cards survive, a backup is written first), --dry-run to preview the plan, or --replace --force to make this file the entire roster (erasing cards it does not list)`);
      }
      if (!fs.existsSync(file)) throw new Error(`no import file at ${file}`);
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // Never echo the parser's own message: it can fold a slice of the file into it, and this file is
        // arbitrary input the caller pointed us at, not something we already trust.
        throw new Error(`import file ${file} is not valid JSON`);
      }
      // A per-card statusChangedAt on the legacy file is a genuine, owner-authored date; a card without one
      // only gets the file's own mtime as a fallback, which markProvenance below documents, not disguises.
      const genuineDates = new Map((Array.isArray(parsed.adventurers) ? parsed.adventurers : []).map((a) => [a && a.id, Boolean(a && a.statusChangedAt)]));
      const { roster: incoming, statusRecords: rawStatusRecords, policy, report } = splitLegacyRoster(parsed, { setBy: 'import', at: fs.statSync(file).mtime.toISOString() });
      const statusRecords = markProvenance(rawStatusRecords, genuineDates);
      // A malformed roster on disk fails here, loudly — never treated as empty so the import "can proceed".
      const existing = readExistingRoster(home.roster);
      const plan = planRosterImport({ existing, incoming, statusRecords, currentStatus: foldStatuses(readJsonLines(home.status)), replace });
      if (dryRun) {
        out(importPlanText(plan));
        out('dry run: nothing was written');
        return;
      }
      const rosterChanges = replace || plan.added.length > 0 || plan.updated.length > 0;
      if (rosterChanges && homeExists) {
        const backup = backupRosterFile(home.roster, replace);
        out(`${replace ? 'replacing (cards the file does not list will be erased)' : 'merging by card id'}; backup of the current roster: ${backup}`);
      }
      // Everything was validated inside planRosterImport before any byte was written. Not transactional past
      // this point: a crash or disk error between the roster save and the last status append can leave some
      // of this import's status records unwritten even though the roster itself saved — recoverable from the
      // backup written above, but not atomic as a whole.
      // plan.roster already passed planRosterImport's strict check on every changed/added card; lenient here
      // only means a card this import never touched (e.g. one allowed solely by some other project's
      // policy.cardEnvAllow, which this CLI never reads) is not re-judged by a caller with no project list.
      if (rosterChanges) saveRoster(home.roster, plan.roster, { lenientEnv: true });
      for (const record of plan.toAppend) appendJsonLine(home.status, record);
      for (const line of importDetailLines(plan)) out(line);
      out(`imported ${plan.roster.adventurers.length} cards into ${home.roster}; ${plan.toAppend.length} status records into ${home.status}${rosterChanges ? '' : ' (roster unchanged)'}`);
      // Ids and counts only: legacy note text and env values never reach the terminal, only what happened.
      if (report.length) out(`  ${report.length} 条旧备注未原样保留（已转成状态记录或被略过）：${report.map((line) => `${line.id} (${line.movedTo})`).join('; ')}`);
      if (plan.statusSkipped.length) out(`  status kept as-is (card already has a status; an import never overrides one): ${plan.statusSkipped.join(', ')} — change it with "questboard card status <id> ..."`);
      if (policy.bannedModelPatterns.length || policy.bannedAgents.length) out(`policy for the project config: ${policy.bannedModelPatterns.length} banned model pattern(s), ${policy.bannedAgents.length} banned agent(s) — add them to questboard.config.json by hand if still wanted`);
      return;
    }
    // FB2-07 item 2: import from `opencode models --verbose` (or a saved copy of it). The capability
    // filter is on by default (text in/out + tool calls); --no-filter keeps everything. Merges by card id
    // through the same planRosterImport as a legacy file, so local env/variants never get clobbered.
    if (sub === 'import-opencode') {
      const lane = option(args, '--lane');
      if (!lane) throw new Error('usage: questboard roster import-opencode --lane <接入方式> [--file models.txt] [--no-filter] [--dry-run]　缺 --lane：每张卡都得落在某个接入方式上，不猜');
      let text;
      const file = option(args, '--file');
      if (file) {
        if (!fs.existsSync(file)) throw new Error(`no models file at ${file}`);
        text = fs.readFileSync(file, 'utf8');
      } else {
        text = execFileSync('opencode', ['models', '--verbose'], { encoding: 'utf8', timeout: 30000 });
      }
      const models = parseOpencodeModelsVerbose(text);
      const plan0 = planOpencodeImport({ models, lane, filter: !args.includes('--no-filter') });
      const existing = readExistingRoster(home.roster);
      const plan = planRosterImport({ existing, incoming: { adventurers: plan0.kept }, statusRecords: [], currentStatus: foldStatuses(readJsonLines(home.status)) });
      const summary = `解析 ${models.length} 个模型：留下 ${plan0.kept.length} 张（ok ${plan0.kept.filter((c) => c.verified === 'ok').length}、未验证 ${plan0.kept.filter((c) => c.verified === 'unverified').length}、broken ${plan0.kept.filter((c) => c.verified === 'broken').length}）${plan0.filteredOut.length ? `，过滤掉 ${plan0.filteredOut.length} 个（${plan0.filteredOut.join(', ')}）` : ''}`;
      out(summary);
      if (args.includes('--dry-run')) { out(importPlanText(plan)); out('dry run: nothing was written'); return; }
      const rosterChanges = plan.added.length > 0 || plan.updated.length > 0;
      if (rosterChanges && fs.existsSync(home.roster)) out(`merging by card id; backup of the current roster: ${backupRosterFile(home.roster, false)}`);
      if (rosterChanges) saveRoster(home.roster, plan.roster, { lenientEnv: true });
      for (const line of importDetailLines(plan)) out(line);
      out(`imported ${plan.roster.adventurers.length} cards into ${home.roster}${rosterChanges ? '' : ' (roster unchanged)'}`);
      return;
    }
    throw new Error('usage: questboard roster init [--force] | roster path | roster import <old roster.json> [--dry-run | --force | --replace --force] | roster import-opencode --lane <lane> [--file models.txt] [--no-filter] [--dry-run]');
  },

  async board(args) {
    const { config, base } = context(args);
    const [sub] = args;
    if (sub === 'post') {
      const body = await request(base, '/api/threads', 'POST', { title: option(args, '--title'), body: option(args, '--body'), author: option(args, '--author') || 'coordinator', tags: String(option(args, '--tag') || '').split(',').map((t) => t.trim()).filter(Boolean) });
      out(`# ${body.thread.title}\nid: ${body.thread.id}`);
    } else if (sub === 'reply') {
      const body = await request(base, `/api/threads/${encodeURIComponent(option(args, '--thread'))}/messages`, 'POST', { body: option(args, '--body'), author: option(args, '--author') || 'coordinator' });
      out(`replied on ${body.thread.id}`);
    } else if (sub === 'list') {
      const params = new URLSearchParams(Object.fromEntries(['q', 'tag', 'status'].map((k) => [k, option(args, `--${k}`)]).filter(([, v]) => v)));
      const { threads } = await request(base, `/api/threads?${params}`);
      out(threads.length ? threads.map((t) => `${t.id}  ${t.closed ? '[closed] ' : ''}${t.title}  (${t.messageCount})`).join('\n') : 'No threads');
    } else if (sub === 'read') {
      const thread = await request(base, `/api/threads/${encodeURIComponent(option(args, '--thread'))}`);
      out(`# ${thread.title}\n${thread.messages.map((m) => `${m.author}  ${m.createdAt}\n${m.body}\n`).join('\n')}`);
    } else if (sub === 'close') {
      await request(base, `/api/threads/${encodeURIComponent(option(args, '--thread'))}/close`, 'POST', { closed: true });
      out('closed');
    } else if (sub === 'inbox') {
      const reader = option(args, '--for');
      const cursorFile = path.join(config.paths.data, reader ? `inbox.${reader}.cursor` : 'inbox.cursor');
      const since = fs.existsSync(cursorFile) ? fs.readFileSync(cursorFile, 'utf8').trim() : '';
      const params = new URLSearchParams({ ...(since ? { since } : {}), ...(reader ? { for: reader } : {}) });
      const { messages, nextCursor } = await request(base, `/api/inbox?${params}`);
      out(messages.length ? messages.map((m) => `${m.author}  ${m.createdAt}\n${m.body}\n`).join('\n') : 'No new messages');
      if (messages.length && nextCursor) fs.writeFileSync(cursorFile, `${nextCursor}\n`, 'utf8');
    } else {
      throw new Error('usage: questboard board post|reply|list|read|close|inbox [options]');
    }
  },

  async mcp(args) {
    const { config, base } = context(args);
    const { runMcp } = await import('../mcp/server.js');
    runMcp({ config, base, author: option(args, '--author') || 'coordinator' });
  },

  // FB2-08 item 1: the brief shelf's bookkeeping from the terminal. Dismiss marks a brief done/ignored
  // outside the board (a jsonl record under the project's data dir — never a quest event); undismiss
  // takes it back. A bare package covers every current copy; --brief names one physical copy.
  async brief(args) {
    const { base } = context(args);
    const sub = args[0];
    const pkg = positional(args.slice(1), ['--note', '--brief', '--by', '--project', '--url']);
    if ((sub === 'dismiss' || sub === 'undismiss') && pkg) {
      const body = { package: pkg, by: option(args, '--by') || 'owner' };
      const brief = option(args, '--brief');
      if (brief !== undefined) body.brief = brief;
      if (sub === 'dismiss') {
        const { dismissed } = await request(base, '/api/briefs/dismiss', 'POST', { ...body, note: option(args, '--note') || '' });
        out('已归档 ' + dismissed.package + (dismissed.brief ? ' ' + dismissed.brief : '') + '（brief undismiss ' + dismissed.package + ' 撤销）');
      } else {
        const { removed } = await request(base, '/api/briefs/undismiss', 'POST', body);
        out(removed > 0 ? '已撤销归档 ' + pkg + '（' + removed + ' 条）' : '没有 ' + pkg + ' 的归档记录');
      }
      return;
    }
    throw new Error('usage: questboard brief dismiss <package> [--brief <path>] [--note "..."] [--by who]　已在板外完成/忽略的 brief，从货架收起（可撤销）；brief undismiss <package> [--brief <path>] 撤销');
  },

  async watch(args) {
    const config = projectConfig(args);
    watchEvents(config.paths.events, { fromStart: args.includes('--from-start'), write: (line) => out(line) });
  },

  // Read-only setup check: paths, scripts, Git Bash, roster, key sources (never values), the running server.
  async doctor(args) {
    const config = projectConfig(args);
    const { runDoctor } = await import('./doctor.js');
    const result = await runDoctor({ config, home: homePaths() });
    for (const check of result.checks) out(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}：${check.detail}`);
    out(result.ok ? '\n一切正常' : '\n有问题，看上面 FAIL 的行');
    if (!result.ok) process.exitCode = 1;
  },
};

// `show` is an alias of `get`; both read one quest through GET /api/quests/:id.
commands.show = commands.get;
