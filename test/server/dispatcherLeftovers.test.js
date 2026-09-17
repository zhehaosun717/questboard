// The dispatcher-leftovers slice (backlog parked rows X5 and X6): the diagnostic sink names the disk
// operation that actually failed (读取失败 for a read, 没写成 for a write), a settled failure names the step
// that actually failed (the snapshot write vs its record, the role card write vs its record), and the
// "wrapper reported an error but the worker started" fallback carries the same variant warnings as the
// normal path. Exercised through the real dispatcher/store, the same harness style as
// dispatcherFaultRecovery.test.js.
// Polish 14 (N1/N2) continues that honesty: a role-card directory failure names the role card with its own
// code, and a rebuilt-plan failure names the rebuilt plan unless the step that failed is the role card.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { checkVariantSupport } from '../../src/core/rules.js';
import { makeProject, card } from '../helpers.js';
import { appendJsonLine } from '../../src/core/jsonl.js';

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const readEvents = (config) => fs.readFileSync(config.paths.events, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

// Captures only the dispatcher's own diagnostic lines and lets every other stderr write (the test runner's
// own output) pass through untouched, so a failure inside the dispatcher can never be swallowed by the probe.
function captureDispatcherStderr() {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    const text = String(chunk);
    if (text.startsWith('[dispatcher]')) { lines.push(text); return true; }
    return original.call(process.stderr, chunk, ...rest);
  };
  return { lines, restore: () => { process.stderr.write = original; } };
}

describe('X5: the diagnostic sink says what actually failed', () => {
  it('logs a registry read failure as 读取失败, never as a failed write', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/LBL-1-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'LBL-1', brief: 'docs/briefs/LBL-1-x.md', by: 'owner' });
    fs.mkdirSync(path.dirname(realConfig.paths.registry), { recursive: true });
    fs.mkdirSync(realConfig.paths.registry); // a directory, not a file: workerEvidence's own read throws
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50, runners: { run: async () => ({ code: 1, error: 'wrapper exit' }) } });
    const capture = captureDispatcherStderr();
    try {
      dispatcher.assign('LBL-1', card('codex-luna'), 'owner');
      await wait(300);
    } finally {
      capture.restore();
    }
    const joined = capture.lines.join('');
    assert.match(joined, /workerEvidence read 读取失败/, 'a report that could not be read is reported as a read failure');
    assert.equal(joined.includes('没能写盘'), false, 'a read failure must never be logged as a write that failed');
  });

  it('still logs a store write that did not land as 没写成', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/LBL-2-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'LBL-2', brief: 'docs/briefs/LBL-2-x.md', by: 'owner' });
    const events = realConfig.paths.events;
    let backup;
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      // The run itself succeeds; the confirming event's own append is what breaks (the F2 shape), so the
      // only reporting path left is the sink the safeguard uses.
      runners: { run: async () => { backup = fs.readFileSync(events); fs.rmSync(events); fs.mkdirSync(events); return { code: 0 }; } },
    });
    const capture = captureDispatcherStderr();
    try {
      dispatcher.assign('LBL-2', card('codex-luna'), 'owner');
      await wait(200);
    } finally {
      capture.restore();
      if (backup !== undefined) { fs.rmdirSync(events); fs.writeFileSync(events, backup); }
    }
    assert.match(capture.lines.join(''), /announceStarted 没写成/, 'a write that did not land is still reported as a failed write');
  });
});

describe('X5: a settled failure names the step that actually failed', () => {
  it('says the snapshot did not get written when the file write itself fails', async () => {
    const { config: realConfig, write } = makeProject({ reviewPages: { dir: 'docs/art' } });
    write('docs/briefs/SNAP-1-x.md', 'brief body');
    write('docs/art/review_robot1.html', '<script type="application/json" id="review-data">{"page":"robot1","title":"机器人 1"}</script>');
    const store = new QuestStore(realConfig);
    store.post({ package: 'SNAP-1', kind: 'art', reviewPage: 'robot1', brief: 'docs/briefs/SNAP-1-x.md', by: 'owner' });
    fs.mkdirSync(realConfig.paths.data, { recursive: true });
    fs.writeFileSync(path.join(realConfig.paths.data, 'dispatch-briefs'), 'blocking file');
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50, runners: { run: async () => ({ code: 0 }) } });
    const result = dispatcher.assign('SNAP-1', card('codex-astra'), 'owner');
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error, 'snapshot_failed_after_assign');
    assert.equal(result.body.settled, true);
    const failed = readEvents(realConfig).findLast((event) => event.event === 'failed');
    assert.match(failed.detail, new RegExp(`^批注快照没写成（派遣 ${result.body.attemptId}），worker 没有启动：`), 'the write step is named as the write step');
    assert.equal(store.get('SNAP-1').status, 'failed');
    assert.equal(store.get('SNAP-1').assignee, null);
  });

  it('says the snapshot record did not land when only the metadata write fails after the file is written', async () => {
    const { config: realConfig, write } = makeProject({ reviewPages: { dir: 'docs/art' } });
    write('docs/briefs/SNAP-2-x.md', 'brief body');
    write('docs/art/review_robot2.html', '<script type="application/json" id="review-data">{"page":"robot2","title":"机器人 2"}</script>');
    class FailRecordSnapshot extends QuestStore {
      recordAnnotationSnapshot() { throw new Error('EBUSY: snapshot record failed (test fixture)'); }
    }
    const store = new FailRecordSnapshot(realConfig);
    store.post({ package: 'SNAP-2', kind: 'art', reviewPage: 'robot2', brief: 'docs/briefs/SNAP-2-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50, runners: { run: async () => ({ code: 0 }) } });
    const result = dispatcher.assign('SNAP-2', card('codex-astra'), 'owner');
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error, 'snapshot_failed_after_assign');
    assert.equal(result.body.settled, true);
    const snapshotFile = path.join(realConfig.paths.data, 'dispatch-briefs', 'SNAP-2', `SNAP-2-${result.body.attemptId}.md`);
    assert.equal(fs.existsSync(snapshotFile), true, 'the file write itself landed; only its record failed');
    const failed = readEvents(realConfig).findLast((event) => event.event === 'failed');
    assert.match(failed.detail, new RegExp(`^批注快照记录没写成（派遣 ${result.body.attemptId}），worker 没有启动：EBUSY: snapshot record failed`));
    assert.equal(failed.detail.includes('批注快照没写成'), false, 'the file was written; the detail must not blame the write');
  });

  it('says the role card record did not land when the card file was already written', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/CARD-1-x.md', 'brief');
    class FailRecordRoleCard extends QuestStore {
      recordRoleCard() { throw new Error('EBUSY: role card record failed (test fixture)'); }
    }
    const store = new FailRecordRoleCard(realConfig);
    store.post({ package: 'CARD-1', brief: 'docs/briefs/CARD-1-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50, runners: { run: async () => ({ code: 0 }) } });
    const result = dispatcher.assign('CARD-1', card('codex-luna'), 'owner');
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error, 'role_card_failed_after_assign');
    assert.equal(result.body.settled, true);
    const cardFile = path.join(realConfig.paths.data, 'dispatch-briefs', 'CARD-1', `CARD-1-${result.body.attemptId}.role.md`);
    assert.equal(fs.existsSync(cardFile), true, 'the card file itself was written; only its record failed');
    const failed = readEvents(realConfig).findLast((event) => event.event === 'failed');
    assert.match(failed.detail, new RegExp(`^角色卡记录没写成（派遣 ${result.body.attemptId}，worker 还没启动）：EBUSY: role card record failed`));
    assert.equal(store.get('CARD-1').status, 'failed');
  });
});

describe('X6: the "wrapper reported an error but the worker started" path keeps the variant warnings', () => {
  it('carries the same 警告 lines as the normal path, in the same event shape', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/WARN-1-x.md', 'brief');
    write('docs/briefs/WARN-2-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'WARN-1', brief: 'docs/briefs/WARN-1-x.md', by: 'owner' });
    store.post({ package: 'WARN-2', brief: 'docs/briefs/WARN-2-x.md', by: 'owner' });
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: { run: async (step) => {
        const name = step.command[1];
        // The stubbed wrapper for WARN-1 exits non-zero only after its registry row is on disk — the worker
        // started, the wrapper still reported an error (the fallback path). WARN-2's stub exits cleanly (the
        // normal path), so both announcements can be compared directly.
        if (name === 'warn1') {
          const current = store.get('WARN-1');
          appendJsonLine(realConfig.paths.registry, { at: new Date().toISOString(), event: 'dispatch', package: 'WARN-1', lane: current.assignee.lane, model: current.assignee.model, variant: current.assignee.variant || '', name: current.assignee.name });
          return { code: 1, error: 'wrapper exit 1' };
        }
        return { code: 0 };
      } },
    });
    dispatcher.assign('WARN-1', card('codex-luna'), 'owner');
    await wait(300);
    dispatcher.assign('WARN-2', card('codex-astra'), 'owner');
    await wait(300);
    const events = readEvents(realConfig);
    const fallback = events.findLast((event) => event.event === 'dispatched' && event.package === 'WARN-1');
    const normal = events.findLast((event) => event.event === 'dispatched' && event.package === 'WARN-2');
    assert.ok(fallback && normal);
    assert.equal(fallback.detail.split('\n')[0], '脚本报错但 worker 已启动（登记表有 warn1 的派遣记录）：tools/codex-run.sh 退出码 1：wrapper exit 1');
    assert.equal(normal.detail.split('\n')[0], '脚本已启动，worker warn2');
    assert.deepEqual(fallback.detail.split('\n').slice(1), normal.detail.split('\n').slice(1), 'the same warnings the normal path carries, byte for byte');
    // The expected line comes from the same helper the normal path's verdict uses (rules.js's
    // checkVariantSupport, reached through canDispatch), so the assertion pins the wiring, not the prose.
    const [variantWarning] = checkVariantSupport(store.get('WARN-1'), card('codex-luna')).warnings;
    assert.equal(fallback.detail.split('\n')[1], `警告 ${variantWarning.code}：${variantWarning.message}`);
    assert.equal('warnings' in fallback, false, 'no new field on the dispatched event: the warnings ride in detail exactly as on the normal path');
  });

  it('keeps the fallback detail byte-identical when the card declares the variant', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/WARN-3-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'WARN-3', brief: 'docs/briefs/WARN-3-x.md', by: 'owner' });
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: { run: async () => {
        const current = store.get('WARN-3');
        appendJsonLine(realConfig.paths.registry, { at: new Date().toISOString(), event: 'dispatch', package: 'WARN-3', lane: current.assignee.lane, model: current.assignee.model, variant: current.assignee.variant || '', name: current.assignee.name });
        return { code: 1, error: 'wrapper exit 1' };
      } },
    });
    dispatcher.assign('WARN-3', card('codex-luna', { variants: ['high'] }), 'owner');
    await wait(300);
    const dispatched = readEvents(realConfig).findLast((event) => event.event === 'dispatched');
    assert.equal(dispatched.detail, '脚本报错但 worker 已启动（登记表有 warn3 的派遣记录）：tools/codex-run.sh 退出码 1：wrapper exit 1', 'no warnings leaves the announcement byte-identical to the previous single-line detail');
  });
});

describe('Polish 14: the role card and the rebuilt plan name their own steps', () => {
  it('names a role-card directory failure as the role card, never as the snapshot', () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/CARD-2-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'CARD-2', brief: 'docs/briefs/CARD-2-x.md', by: 'owner' });
    fs.mkdirSync(realConfig.paths.data, { recursive: true });
    fs.writeFileSync(path.join(realConfig.paths.data, 'dispatch-briefs'), 'blocking file');
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50, runners: { run: async () => ({ code: 0 }) } });
    const result = dispatcher.assign('CARD-2', card('codex-luna'), 'owner');
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error, 'role_card_failed_after_assign');
    assert.equal(result.body.settled, true);
    assert.equal(result.body.reasons[0].code, 'role_card_write_failed');
    assert.match(result.body.reasons[0].message, /^角色卡目录创建失败：/);
    const failed = readEvents(realConfig).findLast((event) => event.event === 'failed');
    assert.match(failed.detail, new RegExp(`^角色卡写入失败（派遣 ${result.body.attemptId}，worker 还没启动）：角色卡目录创建失败：`));
    assert.equal(failed.detail.includes('批注快照'), false, 'the card step must never be blamed on the snapshot');
    assert.equal(store.get('CARD-2').status, 'failed');
    assert.equal(store.get('CARD-2').assignee, null);
  });

  it('labels a rebuilt-plan preflight failure as the rebuilt plan, not the role card', () => {
    const { config: realConfig, write } = makeProject({
      reviewPages: { dir: 'docs/art' },
      lanes: { art: { run: ['node', 'tools/art-run.js', '{name}', '{brief}'], outputDir: '.work/art' } },
    });
    write('docs/briefs/ART-77-x.md', 'brief body');
    write('docs/art/review_robot3.html', '<script type="application/json" id="review-data">{"page":"robot3","title":"机器人 3"}</script>');
    const scriptFile = write('tools/art-run.js', '// stub\n');
    class RaceDeletesScript extends QuestStore {
      // The race the review names: the first preflight passed, and by the time the role card is recorded the
      // script the rebuilt plan still needs is gone.
      recordRoleCard(...args) {
        const running = super.recordRoleCard(...args);
        fs.rmSync(scriptFile);
        return running;
      }
    }
    const store = new RaceDeletesScript(realConfig);
    store.post({ package: 'ART-77', kind: 'art', reviewPage: 'robot3', brief: 'docs/briefs/ART-77-x.md', by: 'owner' });
    // No runners: both preflights run for real; the first one passes and the rebuilt one is the one that fails.
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50 });
    const result = dispatcher.assign('ART-77', card('codex-astra', { lane: 'art' }), 'owner');
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error, 'role_card_plan_failed_after_assign');
    assert.equal(result.body.settled, true);
    assert.equal(result.body.reasons[0].code, 'role_card_plan');
    assert.match(result.body.reasons[0].message, /^缺少派遣脚本 tools\/art-run\.js$/);
    const failed = readEvents(realConfig).findLast((event) => event.event === 'failed');
    assert.match(failed.detail, new RegExp(`^派遣计划重建失败（派遣 ${result.body.attemptId}，worker 还没启动）：缺少派遣脚本 tools/art-run\\.js$`));
    assert.equal(failed.detail.includes('角色卡计划失败'), false, 'a rebuilt-plan failure must not be labelled as a role-card plan step');
    assert.equal(store.get('ART-77').status, 'failed');
    assert.equal(store.get('ART-77').assignee, null);
  });

  it('keeps the role-card label when the rebuilt plan fails reading the role card itself', () => {
    const { config: realConfig, write } = makeProject({ lanes: {
      cardlane: {
        session: { run: ['node', 'tools/role-new.js'], saveTo: '.work/cardlane-{name}.txt' },
        run: ['node', 'tools/role-send.js', '{name}', '{brief}'], outputDir: '.work/cardlane', roleInPrompt: true,
      },
    } });
    write('docs/briefs/CARD-3-x.md', 'brief');
    write('tools/role-new.js', '// stub\n');
    write('tools/role-send.js', '// stub\n');
    class RaceDeletesCard extends QuestStore {
      // The card exists long enough for the first plan to be built; the rebuilt plan has to read it into the
      // session prompt, and by then it is gone.
      recordRoleCard(packageId, attempt, roleCard) {
        const running = super.recordRoleCard(packageId, attempt, roleCard);
        fs.rmSync(path.join(realConfig.root, roleCard.path));
        return running;
      }
    }
    const store = new RaceDeletesCard(realConfig);
    store.post({ package: 'CARD-3', brief: 'docs/briefs/CARD-3-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50 });
    const result = dispatcher.assign('CARD-3', card('codex-luna', { lane: 'cardlane' }), 'owner');
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error, 'role_card_plan_failed_after_assign');
    assert.equal(result.body.settled, true);
    assert.equal(result.body.reasons[0].code, 'role_card_plan');
    assert.match(result.body.reasons[0].message, /^无法读取角色卡：/);
    const failed = readEvents(realConfig).findLast((event) => event.event === 'failed');
    assert.match(failed.detail, new RegExp(`^角色卡计划失败（派遣 ${result.body.attemptId}，worker 还没启动）：无法读取角色卡：`));
    assert.equal(failed.detail.includes('派遣计划重建失败'), false, 'the step that failed here is the role card, not the rebuilt plan');
    assert.equal(store.get('CARD-3').status, 'failed');
    assert.equal(store.get('CARD-3').assignee, null);
  });

  it('labels a plan-build failure during the rebuild as the rebuilt plan when the lane takes no role', () => {
    const { config: realConfig, write } = makeProject({
      reviewPages: { dir: 'docs/art' },
      lanes: { art: { run: ['node', 'tools/art-run.js', '{name}', '{brief}'], outputDir: '.work/art' } },
    });
    write('docs/briefs/ART-78-x.md', 'brief body');
    write('docs/art/review_robot4.html', '<script type="application/json" id="review-data">{"page":"robot4","title":"机器人 4"}</script>');
    write('tools/art-run.js', '// stub\n');
    // The rebuilt plan's own build can throw on a lane that never reads the role card (the review's P2 probe):
    // the lane is swapped once the card is recorded, so the first plan is built and the rebuilt one throws.
    const config = { ...realConfig, lanes: { ...realConfig.lanes } };
    class RaceBreaksLaneRead extends QuestStore {
      recordRoleCard(...args) {
        const running = super.recordRoleCard(...args);
        config.lanes.art = { ...realConfig.lanes.art, get run() { throw new Error('计划模板读取失败（测试桩）'); } };
        return running;
      }
    }
    const store = new RaceBreaksLaneRead(realConfig);
    store.post({ package: 'ART-78', kind: 'art', reviewPage: 'robot4', brief: 'docs/briefs/ART-78-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config, store, evidenceWaitMs: 50 });
    const result = dispatcher.assign('ART-78', card('codex-astra', { lane: 'art' }), 'owner');
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error, 'role_card_plan_failed_after_assign');
    assert.equal(result.body.settled, true);
    assert.equal(result.body.reasons[0].code, 'role_card_plan');
    assert.equal(result.body.reasons[0].message, '计划模板读取失败（测试桩）');
    const failed = readEvents(realConfig).findLast((event) => event.event === 'failed');
    assert.match(failed.detail, new RegExp(`^派遣计划重建失败（派遣 ${result.body.attemptId}，worker 还没启动）：计划模板读取失败（测试桩）$`));
    assert.equal(failed.detail.includes('角色卡计划失败'), false, 'a plan-build failure on a lane without a role must not be labelled as a role-card step');
    assert.equal(store.get('ART-78').status, 'failed');
    assert.equal(store.get('ART-78').assignee, null);
  });
});
