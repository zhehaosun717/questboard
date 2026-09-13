// CLI commands. Writes go through the running server (one writer per project); `watch`, `roster import`
// and `card status` work on local files so they keep working while the server restarts.
import fs from 'node:fs';
import path from 'node:path';
import { option, projectConfig, serverUrl, request } from './client.js';
import { startServer } from '../server/server.js';
import { homePaths } from '../core/home.js';
import { splitLegacyRoster } from '../core/legacy.js';
import { saveRoster, validateRoster } from '../core/roster.js';
import { StatusLog, validateStatusRecord } from '../core/status.js';
import { appendJsonLine } from '../core/jsonl.js';
import { watchEvents } from './watch.js';

const out = (text) => process.stdout.write(`${text}\n`);

function questLine(quest) {
  const who = quest.assignee ? ` <- ${quest.assignee.model} (${quest.assignee.name})` : '';
  const owner = quest.needsOwner ? ` [等裁决: ${quest.needsOwner}]` : '';
  return `${quest.id.padEnd(16)} ${quest.status.padEnd(14)} ${quest.kind.padEnd(6)} ${quest.title}${who}${owner}`;
}

function context(args) {
  const config = projectConfig(args);
  return { config, base: serverUrl(args, config) };
}

export const commands = {
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
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(args[0])}/assign`, 'POST', { adventurer: option(args, '--adventurer'), by: option(args, '--by') || 'coordinator' });
    out(questLine(quest));
  },

  async adopt(args) {
    const { base } = context(args);
    const { quest } = await request(base, `/api/quests/${encodeURIComponent(args[0])}/adopt`, 'POST', { adventurer: option(args, '--adventurer'), name: option(args, '--name'), by: option(args, '--by') || 'coordinator' });
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
    throw new Error('usage: questboard card list | card status <id> <available|limited|broke|paused|disabled> [--reason "..."] [--by who]');
  },

  async roster(args) {
    const [sub, file] = args;
    const home = homePaths();
    if (sub === 'path') { out(`roster: ${home.roster}\nstatus: ${home.status}`); return; }
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
    throw new Error('usage: questboard roster path | roster import <old roster.json> [--force]');
  },

  async board(args) {
    const { config, base } = context(args);
    const [sub] = args;
    if (sub === 'post') {
      const body = await request(base, '/api/threads', 'POST', { title: option(args, '--title'), body: option(args, '--body'), author: option(args, '--author'), tags: String(option(args, '--tag') || '').split(',').map((t) => t.trim()).filter(Boolean) });
      out(`# ${body.thread.title}\nid: ${body.thread.id}`);
    } else if (sub === 'reply') {
      const body = await request(base, `/api/threads/${encodeURIComponent(option(args, '--thread'))}/messages`, 'POST', { body: option(args, '--body'), author: option(args, '--author') });
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

  async watch(args) {
    const config = projectConfig(args);
    watchEvents(config.paths.events, { fromStart: args.includes('--from-start'), write: (line) => out(line) });
  },
};
