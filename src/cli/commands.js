// CLI commands. Writes go through the running server (one writer per project); `watch`, `roster import`
// and `card status` work on local files so they keep working while the server restarts.
import fs from 'node:fs';
import path from 'node:path';
import { option, optionAll, projectConfig, serverUrl, request } from './client.js';
import { startServer } from '../server/server.js';
import { validateBoardPort } from '../core/config.js';
import { homePaths } from '../core/home.js';
import { splitLegacyRoster } from '../core/legacy.js';
import { loadRosterOrEmpty, saveRoster, upsertAdventurer } from '../core/roster.js';
import { planRosterImport, importPlanText, importDetailLines } from '../core/rosterImport.js';
import { StatusLog, foldStatuses } from '../core/status.js';
import { appendJsonLine, readJsonLines } from '../core/jsonl.js';
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

function questLine(quest) {
  const who = quest.assignee ? ` <- ${quest.assignee.model} (${quest.assignee.name})` : '';
  const owner = quest.needsOwner ? ` [等裁决: ${quest.needsOwner}]` : '';
  return `${quest.id.padEnd(16)} ${quest.status.padEnd(14)} ${quest.kind.padEnd(6)} ${quest.title}${who}${owner}`;
}

function context(args) {
  const config = projectConfig(args);
  return { config, base: serverUrl(args, config) };
}

// One quest in readable lines. Labels follow the board's everyday wording; --json is the agent-facing form.
// Exported so the CLI tests can pin the exact detail rendering (the report lines especially).
export function questDetailText(quest) {
  const lines = [questLine(quest)];
  lines.push(`  第 ${quest.revision || 0} 版 · priority ${quest.priority} · brief ${quest.brief || '无'}`);
  if (quest.lastDetail) lines.push(`  最近: ${quest.lastDetail}`);
  // The attempt's own report reference, verdict and first paragraph (items 7/12/34), as the detail route
  // exposes them. Null on legacy rows and stale attempts; a capture that found nothing still says why.
  const report = quest.report || null;
  if (report && report.source !== 'none') {
    lines.push(`  报告: ${report.ref}（${report.source}，sha256 ${String(report.digest || '').slice(0, 12)}…${report.truncated ? '，已截断' : ''}）`);
    const verdict = report.verdict || {};
    if (verdict.verdict === 'PASS' || verdict.verdict === 'FAIL') lines.push(`  结论: ${verdict.verdict}${verdict.line ? ` — ${verdict.line}` : ''}`);
    else if (verdict.reason) lines.push(`  结论: 不确定（${verdict.reason}）`);
    else lines.push('  结论: 不确定（报告里没有找到明确的 VERDICT 行）');
    const summary = report.summary || {};
    if (summary.paragraph) lines.push(`  摘要: ${summary.heading ? `${summary.heading} — ` : ''}${summary.paragraph}${summary.hasMore ? ' …' : ''}`);
  } else if (report && report.source === 'none') {
    lines.push(`  报告: 不可用（${report.reason}）`);
  } else if (['delivered', 'failed', 'bounced'].includes(quest.status)) {
    lines.push('  报告: 不可用（这次派遣没有留下报告引用）');
  }
  lines.push(`  可改文件: ${(quest.files || []).join(', ') || '无'}`);
  for (const d of quest.dispatches || []) lines.push(`  派单: ${d.at} ${d.model} (${d.name}) 由 ${d.by}${d.adopted ? '（接管已在跑的 worker）' : ''}${d.requestKey ? ` key=${d.requestKey}` : ''}`);
  for (const r of quest.rulings || []) lines.push(`  裁决: ${r.at} ${r.by}: ${r.text}`);
  if ((quest.threads || []).length) lines.push(`  相关消息: ${quest.threads.map((t) => `${t.id} ${t.title}${t.closed ? '（已关）' : ''}`).join('；')}`);
  const eligibility = quest.eligibility || {};
  lines.push(`  可接手: ${(eligibility.canTake || []).join(', ') || '没有'}`);
  for (const [message, cards] of Object.entries(eligibility.refused || {})) lines.push(`  不可（${(cards || []).join('、')}）: ${message}`);
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
// each keep their own backup instead of the second silently overwriting the first.
function backupRosterFile(rosterFile, replace) {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const suffix = replace ? '-replace' : '-merge';
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
    if (!result.custom.length && !result.detected.length) out('没检测到 codex 或 claude，先按它们写了通道；装好就能用，或者用 --lane 指定你自己的工具');
    if (result.manual.length) out(`另外检测到 ${result.manual.join('、')}：它们不是从 stdin 读提示词，要用 --lane ${result.manual[0]}="<你的命令>" 自己指定（见 README 的 Project config 一节）`);
    out('\n接下来：');
    out(`  questboard card add --id my-codex --name Codex --provider OpenAI --lane ${result.lanes[0]} --model <模型 id>`);
    out(`  questboard serve --project ${result.root}`);
    out('  然后打开 http://127.0.0.1:' + (option(args, '--port') || 6097) + '/ ，把卡拖到任务上');
  },

  async serve(args) {
    const config = projectConfig(args);
    const port = parsePortOption(option(args, '--port'));
    startServer({ config, port });
  },

  async post(args) {
    const { base } = context(args);
    const { quest } = await request(base, '/api/quests', 'POST', {
      package: option(args, '--package'), brief: option(args, '--brief'), kind: option(args, '--kind'),
      parents: option(args, '--parents'), conflicts: option(args, '--conflicts'), allowedLanes: option(args, '--lanes'),
      priority: option(args, '--priority'), needsOwner: option(args, '--needs-owner'), reviewPage: option(args, '--review-page'),
      title: option(args, '--title'), by: option(args, '--by') || 'coordinator',
    });
    out(questLine(quest));
  },

  // Revision-guarded correction of a posted quest's own descriptive fields (title/brief/parents/conflicts/
  // allowedLanes/needsOwner) — never status or assignee, and refused outright while the quest holds a
  // worker's slot. Only flags actually passed are sent, so a field left out is never touched or re-saved.
  async update(args) {
    const { base } = context(args);
    const id = positional(args, ['--title', '--brief', '--parents', '--conflicts', '--lanes', '--needs-owner', '--if-revision', '--by', '--project', '--url']);
    if (!id) {
      throw new Error('usage: questboard update <id> [--title "..."] [--brief docs/briefs/x.md] [--parents A-1,B-2] '
        + '[--conflicts C-3] [--lanes codex,agy] [--needs-owner "question"] [--if-revision 3] [--by who]　'
        + '只改传了的字段，其余不动；worker 占着这个任务时会被拒绝，先 release 再改');
    }
    const payload = { by: option(args, '--by') || 'owner' };
    if (option(args, '--if-revision') !== undefined) payload.ifRevision = option(args, '--if-revision');
    for (const [flag, field] of [
      ['--title', 'title'], ['--brief', 'brief'], ['--parents', 'parents'],
      ['--conflicts', 'conflicts'], ['--lanes', 'allowedLanes'], ['--needs-owner', 'needsOwner'],
    ]) {
      const value = option(args, flag);
      if (value !== undefined) payload[field] = value;
    }
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(id)}/metadata`, 'POST', payload);
    out(questLine(quest));
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
    const [id, status] = args;
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(id)}/status`, 'POST', { status, detail: option(args, '--detail'), by: option(args, '--by') || 'coordinator' });
    out(questLine(quest));
  },

  async ruling(args) {
    const { base } = context(args);
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(args[0])}/ruling`, 'POST', { text: option(args, '--text'), by: option(args, '--by') || 'owner' });
    out(questLine(quest));
  },

  async assign(args) {
    const { base } = context(args);
    const body = await request(base, `/api/quests/${encodeURIComponent(args[0])}/assign`, 'POST', {
      adventurer: option(args, '--adventurer'), by: option(args, '--by') || 'coordinator',
      requestKey: option(args, '--request-key'), ifRevision: option(args, '--if-revision'),
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
    if (!id) throw new Error('usage: questboard get <id> [--json] [--report]　读取一个任务的详情：第几版、当前 worker、派单历史、最近动态、可改文件；--report 打印这次派遣的完整报告原文');
    // --report asks the board for the bounded plain-text report itself, not the JSON detail: the reference
    // is re-verified there (digest + containment) and a report that changed after capture is refused.
    if (args.includes('--report')) {
      let response;
      try {
        response = await fetch(`${base}/api/quests/${encodeURIComponent(id)}/report`);
      } catch {
        throw new Error(`questboard server is not running at ${base}. Start it with: questboard serve`);
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
        process.stderr.write(`报告超过 2 MB，只显示了${shown}，不是完整报告\n`);
      }
      out(text);
      return;
    }
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(id)}`, 'GET');
    out(args.includes('--json') ? JSON.stringify(quest, null, 2) : questDetailText(quest));
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
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(id)}/release`, 'POST', { detail, by: option(args, '--by') || 'coordinator' });
    out(questLine(quest));
  },

  async card(args) {
    const [sub, id, status] = args;
    const home = homePaths();
    if (sub === 'status' && id && status) {
      const entry = new StatusLog(home.status).set(id, { status, reason: option(args, '--reason') || '', setBy: option(args, '--by') || 'coordinator' });
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
      saveRoster(home.roster, upsertAdventurer(loadRosterOrEmpty(home.roster), entry));
      out(`${entry.id}  ${entry.lane}  ${entry.model} -> ${home.roster}`);
      return;
    }
    throw new Error('usage: questboard card list | card add --id x --name X --provider P --lane codex --model m [--family m] [--variant high] [--agent build] [--billing subscription|plan|payg|free] [--max-parallel 1] [--strengths code,review] [--notes "..."] | card status <id> <available|limited|broke|paused|disabled> [--reason "..."] [--by who]');
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
      if (rosterChanges) saveRoster(home.roster, plan.roster);
      for (const record of plan.toAppend) appendJsonLine(home.status, record);
      for (const line of importDetailLines(plan)) out(line);
      out(`imported ${plan.roster.adventurers.length} cards into ${home.roster}; ${plan.toAppend.length} status records into ${home.status}${rosterChanges ? '' : ' (roster unchanged)'}`);
      // Ids and counts only: legacy note text and env values never reach the terminal, only what happened.
      if (report.length) out(`  ${report.length} 条旧备注未原样保留（已转成状态记录或被略过）：${report.map((line) => `${line.id} (${line.movedTo})`).join('; ')}`);
      if (plan.statusSkipped.length) out(`  status kept as-is (card already has a status; an import never overrides one): ${plan.statusSkipped.join(', ')} — change it with "questboard card status <id> ..."`);
      if (policy.bannedModelPatterns.length || policy.bannedAgents.length) out(`policy for the project config: ${policy.bannedModelPatterns.length} banned model pattern(s), ${policy.bannedAgents.length} banned agent(s) — add them to questboard.config.json by hand if still wanted`);
      return;
    }
    throw new Error('usage: questboard roster init [--force] | roster path | roster import <old roster.json> [--dry-run | --force | --replace --force]');
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
