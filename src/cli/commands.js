// CLI commands. Writes go through the running server (one writer per project); `watch`, `roster import`
// and `card status` work on local files so they keep working while the server restarts.
import fs from 'node:fs';
import path from 'node:path';
import { option, optionAll, projectConfig, serverUrl, request } from './client.js';
import { startServer } from '../server/server.js';
import { homePaths } from '../core/home.js';
import { splitLegacyRoster } from '../core/legacy.js';
import { loadRosterOrEmpty, saveRoster, upsertAdventurer, validateRoster } from '../core/roster.js';
import { StatusLog, validateStatusRecord } from '../core/status.js';
import { appendJsonLine } from '../core/jsonl.js';
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
function questDetailText(quest) {
  const lines = [questLine(quest)];
  lines.push(`  第 ${quest.revision || 0} 版 · priority ${quest.priority} · brief ${quest.brief || '无'}`);
  if (quest.lastDetail) lines.push(`  最近: ${quest.lastDetail}`);
  lines.push(`  可改文件: ${(quest.files || []).join(', ') || '无'}`);
  for (const d of quest.dispatches || []) lines.push(`  派单: ${d.at} ${d.model} (${d.name}) 由 ${d.by}${d.adopted ? '（接管已在跑的 worker）' : ''}${d.requestKey ? ` key=${d.requestKey}` : ''}`);
  for (const r of quest.rulings || []) lines.push(`  裁决: ${r.at} ${r.by}: ${r.text}`);
  if ((quest.threads || []).length) lines.push(`  相关消息: ${quest.threads.map((t) => `${t.id} ${t.title}${t.closed ? '（已关）' : ''}`).join('；')}`);
  const eligibility = quest.eligibility || {};
  lines.push(`  可接手: ${(eligibility.canTake || []).join(', ') || '没有'}`);
  for (const [message, cards] of Object.entries(eligibility.refused || {})) lines.push(`  不可（${(cards || []).join('、')}）: ${message}`);
  return lines.join('\n');
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
    const port = option(args, '--port') ? Number(option(args, '--port')) : undefined;
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
    if (!id) throw new Error('usage: questboard get <id> [--json]　读取一个任务的详情：第几版、当前 worker、派单历史、最近动态、可改文件');
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
      if (fs.existsSync(home.roster) && !args.includes('--force')) throw new Error(`${home.roster} exists; pass --force to replace it`);
      const { roster, statusRecords, policy, report } = splitLegacyRoster(JSON.parse(fs.readFileSync(file, 'utf8')), { setBy: 'import' });
      saveRoster(home.roster, validateRoster(roster));
      for (const record of statusRecords) appendJsonLine(home.status, validateStatusRecord(record));
      out(`imported ${roster.adventurers.length} cards into ${home.roster}; ${statusRecords.length} status records into ${home.status}`);
      for (const line of report) out(`  ${line.id}: "${line.note}" -> ${line.movedTo}`);
      if (policy.bannedModelPatterns.length || policy.bannedAgents.length) out(`policy for the project config: ${JSON.stringify(policy)}`);
      return;
    }
    throw new Error('usage: questboard roster init [--force] | roster path | roster import <old roster.json> [--force]');
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
