import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../server/fixture.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'questboard.js');

let fx;
let child;
let nextId = 1;
const pending = new Map();

function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
  });
}

async function call(name, args = {}) {
  const { result } = await rpc('tools/call', { name, arguments: args });
  return { error: result.isError === true, value: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
}

before(async () => {
  fx = await startFixture();
  child = spawn(process.execPath, [CLI, 'mcp', '--project', fx.project.root, '--url', fx.base, '--author', 'coordinator'], {
    env: { ...process.env, QUESTBOARD_HOME: fx.home.home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'questboard');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
});

after(async () => {
  child.kill();
  await fx.close();
});

describe('questboard mcp over stdio', () => {
  it('lists the tools with schemas and annotations', async () => {
    const { result } = await rpc('tools/list');
    const names = result.tools.map((t) => t.name);
    for (const name of ['questboard_post_quest', 'questboard_get_quest', 'questboard_adopt', 'questboard_set_card_status', 'questboard_events', 'questboard_board_inbox']) assert.ok(names.includes(name), name);
    const post = result.tools.find((t) => t.name === 'questboard_post_quest');
    assert.deepEqual(post.inputSchema.properties.allowedLanes.items.enum, ['codex', 'claude', 'agy', 'dsh', 'opencode']);
    assert.equal(result.tools.find((t) => t.name === 'questboard_list_quests').annotations.readOnlyHint, true);
  });

  it('posts, lists and explains a quest with grouped refusals', async () => {
    const posted = await call('questboard_post_quest', { package: 'RUN-4', brief: 'docs/briefs/RUN-4-the-way-back.md', allowedLanes: ['codex'] });
    assert.equal(posted.value.status, 'posted');
    assert.deepEqual((await call('questboard_list_quests', { status: 'posted' })).value.map((q) => q.id), ['RUN-4']);
    const quest = (await call('questboard_get_quest', { id: 'RUN-4' })).value;
    assert.ok(quest.eligibility.canTake.includes('codex-luna'));
    assert.ok(quest.eligibility.refused['coordinator 只允许这些通道：codex'].includes('agy-gemini'));
    const missing = await call('questboard_get_quest', { id: 'NOPE-1' });
    assert.deepEqual([missing.error, missing.value], [true, 'no quest NOPE-1 on the board']);
  });

  it('refuses with every reason, names missing arguments, and records card statuses', async () => {
    const card = await call('questboard_set_card_status', { id: 'codex-astra', status: 'paused', reason: '费用' });
    assert.equal(card.value.status, 'paused');
    const refused = await call('questboard_assign', { id: 'RUN-4', adventurer: 'codex-astra' });
    assert.equal(refused.error, true);
    assert.match(refused.value, /这个模型被暂停使用/);
    assert.match((await call('questboard_adopt', { id: 'RUN-4' })).value, /missing required arguments: adventurer, name/);
    const listed = (await call('questboard_list_cards', { status: 'paused' })).value;
    assert.deepEqual(listed.map((c) => [c.id, c.reason]), [['codex-astra', '费用']]);
  });

  it('adopts, reads events since a cursor, and uses the message board', async () => {
    const before = (await call('questboard_events')).value.at(-1).at;
    await call('questboard_adopt', { id: 'RUN-4', adventurer: 'codex-luna', name: 'run4' });
    const fresh = (await call('questboard_events', { since: before })).value;
    assert.deepEqual(fresh.map((e) => [e.event, e.name, e.by]), [['dispatched', 'run4', 'coordinator']]);
    const thread = (await call('questboard_board_post', { title: 'RUN-4 which reserve line?', body: 'A or B?', tags: ['question', 'RUN-4'] })).value;
    fx.server.boardStore.addMessage(thread.id, { body: 'B', author: 'owner' });
    const inbox = (await call('questboard_board_inbox')).value;
    assert.deepEqual(inbox.messages.map((m) => m.body), ['B']);
    assert.ok(inbox.nextCursor);
  });
});
