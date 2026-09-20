// FB2-02 item 3: dispatcher.assign backs up the previous attempts' artifacts before the redo spawns.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { readJsonLines } from '../../src/core/jsonl.js';
import { makeProject, card } from '../helpers.js';

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('dispatcher re-dispatch backup (FB2-02)', () => {
  it('backs up the previous attempt\'s artifacts before the redo runner starts', async () => {
    const { config, write } = makeProject();
    write('docs/briefs/MOD-30-x.md', 'brief');
    const store = new QuestStore(config);
    store.post({ package: 'MOD-30', brief: 'docs/briefs/MOD-30-x.md', by: 'owner' });
    let backupSeenAtRun = null;
    const dispatcher = createDispatcher({
      config,
      store,
      runners: {
        session: async () => ({ code: 0, session: 'ses_bak' }),
        run: async () => {
          const dir = path.join(config.root, '.work/codex');
          backupSeenAtRun = fs.readdirSync(dir).filter((entry) => entry.startsWith('mod30.bak-'));
          return { code: 0 };
        },
      },
    });
    dispatcher.assign('MOD-30', card('codex-luna'), 'owner');
    await wait();
    const first = store.get('MOD-30');
    const firstName = first.assignee.name;
    write(`.work/codex/${firstName}.out`, 'old log');
    write(`.work/codex/${firstName}.exit`, '{"code":0}');
    store.setStatus('MOD-30', 'failed', { detail: '退回重做：确认释放', by: 'owner', ack: true });
    backupSeenAtRun = null;
    const second = dispatcher.assign('MOD-30', card('codex-luna'), 'owner');
    assert.equal(second.status, 200, JSON.stringify(second.body));
    await wait();
    const dir = path.join(config.root, '.work/codex');
    const backups = fs.readdirSync(dir).filter((entry) => entry.startsWith(`${firstName}.bak-`));
    assert.equal(backups.length, 1, 'exactly one backup folder');
    assert.equal(fs.readFileSync(path.join(dir, backups[0], `${firstName}.out`), 'utf8'), 'old log');
    assert.equal(fs.readFileSync(path.join(dir, `${firstName}.out`), 'utf8'), 'old log', 'original untouched');
    assert.ok(backupSeenAtRun && backupSeenAtRun.length === 1, 'the backup existed before the runner started');
    const events = readJsonLines(config.paths.events);
    const dispatched = events.filter((e) => e.event === 'dispatched').at(-1);
    assert.equal(dispatched.backupCount, 1, 'the dispatched event carries the backup');
    assert.match(dispatched.backupDirs[0], /\.bak-/);
  });

  it('refuses to spawn when the backup fails, settles the attempt failed, and leaves the old delivery in place', async () => {
    const { config, write } = makeProject();
    write('docs/briefs/MOD-31-x.md', 'brief');
    const store = new QuestStore(config);
    store.post({ package: 'MOD-31', brief: 'docs/briefs/MOD-31-x.md', by: 'owner' });
    let runs = 0;
    const dispatcher = createDispatcher({
      config,
      store,
      runners: {
        session: async () => ({ code: 0, session: 'ses_bak2' }),
        run: async () => { runs += 1; return { code: 0 }; },
      },
    });
    dispatcher.assign('MOD-31', card('codex-luna'), 'owner');
    await wait();
    const firstName = store.get('MOD-31').assignee.name;
    write(`.work/codex/${firstName}.out`, 'old log');
    store.setStatus('MOD-31', 'failed', { detail: '退回重做：确认释放', by: 'owner', ack: true });
    // A directory with the artifact's name: readdir sees it, statSync says not a file, nothing to copy —
    // instead make the artifact unreadable as a copy source by occupying every backup name is impossible,
    // so block the backup by turning the artifact dir into a plain file is also impossible (artifacts live
    // inside it). The honest block: the artifact dir itself is replaced by a file after the first run.
    const dir = path.join(config.root, '.work/codex');
    for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a directory');
    runs = 0;
    const second = dispatcher.assign('MOD-31', card('codex-luna'), 'owner');
    assert.equal(second.status, 503, JSON.stringify(second.body));
    assert.equal(second.body.error, 'backup_failed_after_assign');
    assert.equal(second.body.settled, true);
    await wait();
    assert.equal(runs, 0, 'the redo runner never started');
    const quest = store.get('MOD-31');
    assert.equal(quest.status, 'failed');
    assert.match(quest.lastDetail, /备份/);
    assert.equal(fs.readFileSync(dir, 'utf8'), 'not a directory', 'the old path was not touched');
  });
});
