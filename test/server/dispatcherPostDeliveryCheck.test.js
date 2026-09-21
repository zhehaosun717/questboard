// FB2-05: the delivery self-check gate (policy.postDeliveryCheck) runs after the worker leaves delivery
// evidence and before the board writes delivered; a failPattern hit holds the delivery and bounces the
// worker to fix in the same attempt (file lanes re-run the wrapper with QB_FIX_HINT, API lanes get a
// session message), up to maxRounds, then the quest fails with every round's output. The post-time review
// modes (none|mechanical|model) route the settled delivery. All through the real QuestStore and a real
// spawned check command, so the check log, exit codes and durable records are exercised end to end.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { readJsonLines } from '../../src/core/jsonl.js';
import { isReviewable } from '../../src/core/reviewRequest.js';
import { makeProject, card } from '../helpers.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(25);
  }
}

// A self-check script that fails for the first `failRounds` rounds then passes, tracking rounds in a
// counter file inside the project so the real spawned process sees persistent state across rounds.
const COUNTER_CHECK = (failRounds) => [
  "const fs = require('fs');",
  "const file = 'scripts/check-count.txt';",
  'let n = 0;',
  "try { n = Number(fs.readFileSync(file, 'utf8')); } catch {}",
  'n += 1;',
  "fs.writeFileSync(file, String(n));",
  `if (n <= ${failRounds}) { console.log('FAIL round ' + n + ' src/x.test.js broke'); process.exit(0); }`,
  "console.log('all tests pass');",
  'process.exit(0);',
].join('\n');

function gateProject({ run, failPattern = 'FAIL', timeoutMs = 30000, maxRounds = 2 } = {}) {
  const { config, write } = makeProject({
    policy: { postDeliveryCheck: { run, timeoutMs, failPattern, maxRounds } },
  });
  write('docs/briefs/PX-1-x.md', 'brief');
  const store = new QuestStore(config);
  const dispatcher = createDispatcher({
    config, store,
    runners: {
      run: async () => ({ code: 0 }),
      session: async () => ({ code: 0, session: 'ses_x' }),
    },
  });
  return { config, write, store, dispatcher };
}

function makeRunners() {
  const runCalls = [];
  const runners = {
    run: async (step) => { runCalls.push(step); return { code: 0 }; },
    session: async () => ({ code: 0, session: 'ses_x' }),
  };
  return { runners, runCalls };
}

function postAndDispatch({ config, store, dispatcher = null, runners = null, cardId = 'codex-luna', ...postFields }) {
  store.post({ package: 'PX-1', brief: 'docs/briefs/PX-1-x.md', by: 'owner', ...postFields });
  const d = dispatcher || createDispatcher({ config, store, runners: runners || makeRunners().runners });
  const result = d.assign('PX-1', card(cardId), 'owner');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return d;
}

function deliveredRows(quest, { lastText = 'done' } = {}) {
  return [{
    name: quest.assignee.name, package: quest.id, lane: quest.assignee.lane, model: quest.assignee.model,
    state: 'delivered', dispatchedAt: quest.assignee.at, lastText,
  }];
}

const eventsOf = (config) => (fs.existsSync(config.paths.events) ? readJsonLines(config.paths.events) : []);
const checkLog = (config, quest) => path.join(config.root, '.work', 'codex', `${quest.assignee.name}.check.log`);

describe('dispatcher postDeliveryCheck gate (FB2-05)', () => {
  it('runs the check after delivery evidence and before delivered, writes <name>.check.log and stamps the round on the history', async () => {
    const { config, write, store, dispatcher } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', "console.log('all tests pass'); process.exit(0)");
    postAndDispatch({ config, store, dispatcher });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => store.get('PX-1').status === 'delivered', 'delivered after a passing check');
    const quest = store.get('PX-1');
    assert.equal(quest.assignee.checkResults.length, 1, 'one round recorded');
    assert.equal(quest.assignee.checkResults[0].round, 1);
    assert.equal(quest.assignee.checkResults[0].ok, true);
    assert.equal(quest.assignee.checkResults[0].exitCode, 0);
    assert.deepEqual(quest.dispatches.at(-1).checkResults, quest.assignee.checkResults, 'history carries the same rounds');
    assert.match(fs.readFileSync(checkLog(config, quest), 'utf8'), /all tests pass/);
    assert.ok(quest.assignee.checkResults[0].evidence, 'the checked delivery evidence is remembered');
    assert.equal(eventsOf(config).filter((e) => e.event === 'check_failed').length, 0, 'a pass emits no check_failed');
    assert.ok(eventsOf(config).some((e) => e.event === 'delivered'));
  });

  it('a failPattern hit holds the delivery: check_failed, no delivered, and one identical poll does not re-check', async () => {
    const { config, write, store } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', "console.log('FAIL src/x.test.js 3 tests failed'); process.exit(0)");
    const { runners, runCalls } = makeRunners();
    const dispatcher = postAndDispatch({ config, store, dispatcher: createDispatcher({ config, store, runners }) });
    await wait(40);
    const rows = { packages: deliveredRows(store.get('PX-1')) };
    dispatcher.applyLanes(rows);
    await waitFor(() => eventsOf(config).some((e) => e.event === 'check_failed'), 'check_failed event');
    const held = store.get('PX-1');
    assert.equal(held.status, 'dispatched', 'delivery is held back, not delivered');
    assert.equal(held.assignee.checkResults.length, 1);
    assert.equal(held.assignee.checkResults[0].ok, false);
    assert.equal(held.assignee.checkResults[0].exitCode, 0);
    assert.match(held.assignee.checkResults[0].summary, /src\/x\.test\.js/);
    const failed = eventsOf(config).filter((e) => e.event === 'check_failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].detail, /第 1 轮自检没过/);
    assert.match(failed[0].detail, /src\/x\.test\.js/, 'the event carries the error text');
    assert.equal(eventsOf(config).filter((e) => e.event === 'delivered').length, 0);
    dispatcher.applyLanes(rows);
    await wait(120);
    assert.equal(store.get('PX-1').assignee.checkResults.length, 1, 'the same delivery evidence is never re-checked');
    assert.equal(runCalls.length, 2, 'exactly one fix re-run, no duplicate bounces');
  });

  it('a nonzero check exit without a pattern match also holds the delivery and says so', async () => {
    const { config, write, store, dispatcher } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', "console.error('boom'); process.exit(2)");
    postAndDispatch({ config, store, dispatcher });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => eventsOf(config).some((e) => e.event === 'check_failed'), 'check_failed event');
    const quest = store.get('PX-1');
    assert.equal(quest.status, 'dispatched');
    assert.match(quest.assignee.checkResults[0].summary, /非零退出/);
    assert.match(quest.assignee.checkResults[0].summary, /boom/);
    assert.equal(quest.assignee.checkResults[0].exitCode, 2);
  });

  it('a check command that cannot start fails the round loudly, never delivers silently', async () => {
    const { config, store, dispatcher } = gateProject({ run: ['no-such-check-binary-xyz-123', 'x'] });
    postAndDispatch({ config, store, dispatcher });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => eventsOf(config).some((e) => e.event === 'check_failed'), 'check_failed event');
    const quest = store.get('PX-1');
    assert.equal(quest.status, 'dispatched');
    assert.match(quest.assignee.checkResults[0].summary, /没能启动/);
    assert.equal(quest.assignee.checkResults[0].exitCode, null);
  });

  it('a timed-out check holds the delivery with an explicit timeout summary', async () => {
    const { config, write, store, dispatcher } = gateProject({
      run: ['node', 'scripts/slow.js'], timeoutMs: 400,
    });
    write('scripts/slow.js', 'setTimeout(() => process.exit(0), 20000)');
    postAndDispatch({ config, store, dispatcher });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => eventsOf(config).some((e) => e.event === 'check_failed'), 'check_failed after timeout');
    const quest = store.get('PX-1');
    assert.equal(quest.status, 'dispatched');
    assert.match(quest.assignee.checkResults[0].summary, /超时/);
  });

  it('bounces a failed round by re-running the same wrapper command with QB_FIX_HINT carrying the error text', async () => {
    const { config, write, store } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', "console.log('FAIL src/x.test.js broke'); process.exit(0)");
    const { runners, runCalls } = makeRunners();
    const dispatcher = createDispatcher({ config, store, runners });
    postAndDispatch({ config, store, dispatcher });
    await wait(40);
    const attemptId = store.get('PX-1').assignee.attemptId;
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => runCalls.length >= 2, 'the fix re-run to start');
    const original = runCalls[0];
    const fix = runCalls[1];
    assert.deepEqual(fix.command, original.command, 'the wrapper re-runs with the exact same command');
    assert.match(fix.env.QB_FIX_HINT, /自检失败/);
    assert.match(fix.env.QB_FIX_HINT, /src\/x\.test\.js/);
    assert.equal(fix.env.QUESTBOARD_ATTEMPT_ID, attemptId, 'the same attempt, so rounds keep accumulating');
    const quest = store.get('PX-1');
    assert.equal(quest.status, 'dispatched', 'the worker is fixing in place');
    assert.ok(eventsOf(config).some((e) => e.event === 'status_note' && /原地重跑修复/.test(e.detail)));
  });

  it('fails the quest once maxRounds is reached and names every round in lastDetail', async () => {
    const { config, write, store } = gateProject({
      run: ['node', 'scripts/check.js'], maxRounds: 2,
    });
    write('scripts/check.js', COUNTER_CHECK(5));
    const { runners } = makeRunners();
    const dispatcher = postAndDispatch({ config, store, dispatcher: createDispatcher({ config, store, runners }) });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1'), { lastText: 'v1' }) });
    await waitFor(() => (store.get('PX-1').assignee.checkResults || []).length === 1, 'round 1');
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1'), { lastText: 'v2' }) });
    await waitFor(() => store.get('PX-1').status === 'failed', 'failed after the round cap');
    const quest = store.get('PX-1');
    assert.equal(quest.assignee, null, 'failed frees the slot');
    assert.equal(quest.dispatches.at(-1).checkResults.length, 2);
    assert.match(quest.lastDetail, /第 1 轮（exit 0）/);
    assert.match(quest.lastDetail, /第 2 轮（exit 0）/);
    assert.match(quest.lastDetail, /src\/x\.test\.js/);
    assert.ok(eventsOf(config).some((e) => e.event === 'failed'));
    assert.equal(eventsOf(config).filter((e) => e.event === 'check_failed').length, 2);
  });

  it('delivers once a later round passes and keeps the whole round history', async () => {
    const { config, write, store } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', COUNTER_CHECK(1));
    const { runners } = makeRunners();
    const dispatcher = postAndDispatch({ config, store, dispatcher: createDispatcher({ config, store, runners }) });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1'), { lastText: 'v1' }) });
    await waitFor(() => (store.get('PX-1').assignee.checkResults || []).length === 1, 'round 1');
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1'), { lastText: 'v2' }) });
    await waitFor(() => store.get('PX-1').status === 'delivered', 'delivered after a passing round');
    const quest = store.get('PX-1');
    assert.equal(quest.assignee.checkResults.length, 2);
    assert.equal(quest.assignee.checkResults[0].ok, false);
    assert.equal(quest.assignee.checkResults[1].ok, true);
    assert.equal(quest.dispatches.at(-1).checkResults.length, 2);
    assert.ok(eventsOf(config).some((e) => e.event === 'delivered'));
  });

  it('an API-lane bounce sends the error to the same session instead of re-running a wrapper', async () => {
    const { config, write, store } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', "console.log('FAIL src/y.test.js broke'); process.exit(0)");
    const sent = [];
    const fetchImpl = async (url, options = {}) => { sent.push({ url, options }); return { ok: true }; };
    const { runners } = makeRunners();
    const dispatcher = createDispatcher({ config, store, fetchImpl, runners });
    postAndDispatch({ config, store, dispatcher, cardId: 'oc-mimo' });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => sent.length > 0, 'the fix message to be sent');
    const quest = store.get('PX-1');
    assert.equal(quest.status, 'dispatched');
    const call = sent[0];
    assert.equal(call.options.method, 'POST');
    assert.match(call.url, /session\/ses_x\/message$/);
    assert.match(JSON.parse(call.options.body).message, /自检失败/);
    assert.match(JSON.parse(call.options.body).message, /src\/y\.test\.js/);
    assert.ok(eventsOf(config).some((e) => e.event === 'status_note' && /同一 session/.test(e.detail)));
  });

  it('a bouncing API lane without a recorded session id stays dispatched and says the hint could not be sent', async () => {
    const { config, write, store } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', "console.log('FAIL src/z.test.js broke'); process.exit(0)");
    const dispatcher = postAndDispatch({
      config, store, cardId: 'oc-mimo', dispatcher: createDispatcher({
        config, store,
        runners: {
          run: async () => ({ code: 0 }),
          session: async () => ({ code: 0 }), // no id captured: the session binding stays unknown
        },
      }),
    });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => eventsOf(config).some((e) => e.event === 'status_note' && /session id/.test(e.detail)), 'the missing-session note');
    assert.equal(store.get('PX-1').status, 'dispatched');
  });
});

describe('post --review none|mechanical|model (FB2-05)', () => {
  it('validates review and mechanicalCheck at post time', () => {
    const { config, write, store } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', 'process.exit(0)');
    const missing = store.post({ package: 'PX-1', brief: 'docs/briefs/PX-1-x.md', review: 'mechanical' });
    assert.ok(missing.errors.mechanicalCheck, JSON.stringify(missing));
    assert.match(missing.errors.mechanicalCheck, /mechanical-check/);
    assert.match(store.post({ package: 'PX-1', brief: 'docs/briefs/PX-1-x.md', review: 'bogus' }).errors.review, /none、mechanical 或 model/);
    assert.match(store.post({ package: 'PX-1', brief: 'docs/briefs/PX-1-x.md', mechanicalCheck: 'npm test' }).errors.mechanicalCheck, /只在 review=mechanical/);
    const ok = store.post({ package: 'PX-1', brief: 'docs/briefs/PX-1-x.md', review: 'mechanical', mechanicalCheck: 'npm test' });
    assert.ok(!ok.errors);
    assert.equal(ok.quest.review, 'mechanical');
    assert.equal(ok.quest.mechanicalCheck, 'npm test');
    assert.equal(ok.quest.status, 'posted');
    // A re-post that never mentions the mode must not silently reset it to the default.
    const repost = store.post({ package: 'PX-1', brief: 'docs/briefs/PX-1-x.md' });
    assert.ok(!repost.errors);
    assert.equal(repost.quest.review, 'mechanical', 're-post keeps the review mode');
    assert.equal(repost.quest.mechanicalCheck, 'npm test');
  });

  it('review none delivers into needs_coordinator, never into delivered', async () => {
    const { config, write, store } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', "console.log('ok'); process.exit(0)");
    const dispatcher = postAndDispatch({ config, store, review: 'none' });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => store.get('PX-1').status === 'needs_coordinator', 'needs_coordinator');
    assert.equal(eventsOf(config).filter((e) => e.event === 'delivered').length, 0);
    assert.ok(eventsOf(config).some((e) => e.event === 'status_needs_coordinator'));
    assert.equal(isReviewable(store.get('PX-1')), false, 'not on the model-review shelf');
  });

  it('review none on an API lane still writes the report file before the coordinator handoff', async () => {
    const { config, write, store } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', "console.log('ok'); process.exit(0)");
    const writes = [];
    const dispatcher = postAndDispatch({
      config, store, cardId: 'oc-mimo', review: 'none',
      dispatcher: createDispatcher({
        config, store,
        runners: { run: async () => ({ code: 0 }), session: async () => ({ code: 0, session: 'ses_x' }) },
        writeDelivery: async (cfg, lane, name) => { writes.push(name); return path.join(cfg.root, '.work', 'oc', name + '.md'); },
      }),
    });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => store.get('PX-1').status === 'needs_coordinator', 'needs_coordinator after the report write');
    assert.equal(writes.length, 1, 'the delivery .md is written first, the coordinator reads reports from there');
    assert.equal(eventsOf(config).filter((e) => e.event === 'delivered').length, 0);
    assert.ok(eventsOf(config).some((e) => e.event === 'status_needs_coordinator'));
  });

  it('review mechanical runs the check once at delivery, records the conclusion and never bounces', async () => {
    const { config, write, store } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', "console.log('gate ok'); process.exit(0)");
    write('scripts/mech.js', "console.log('mech says: 3 problems'); process.exit(1)");
    const dispatcher = postAndDispatch({ config, store, review: 'mechanical', mechanicalCheck: 'node scripts/mech.js' });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => store.get('PX-1').status === 'delivered', 'delivered with the mechanical conclusion');
    const quest = store.get('PX-1');
    assert.equal(quest.mechanicalReview.ok, false);
    assert.equal(quest.mechanicalReview.exitCode, 1);
    assert.match(quest.mechanicalReview.summary, /3 problems/);
    assert.equal(quest.dispatches.at(-1).mechanicalReview.exitCode, 1);
    const logFile = path.join(config.root, quest.mechanicalReview.logPath);
    assert.ok(fs.existsSync(logFile), 'the mechanical check log exists');
    assert.ok(eventsOf(config).some((e) => e.event === 'status_note' && /机械复核没过/.test(e.detail)));
    assert.equal(isReviewable(quest), false, 'a mechanical review is already the review — no model review slot');
  });

  it('review mechanical passing records a green conclusion', async () => {
    const { config, write, store } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', "console.log('gate ok'); process.exit(0)");
    write('scripts/mech.js', "console.log('all good'); process.exit(0)");
    const dispatcher = postAndDispatch({ config, store, review: 'mechanical', mechanicalCheck: 'node scripts/mech.js' });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => store.get('PX-1').status === 'delivered', 'delivered');
    const quest = store.get('PX-1');
    assert.equal(quest.mechanicalReview.ok, true);
    assert.equal(quest.mechanicalReview.exitCode, 0);
    assert.ok(eventsOf(config).some((e) => e.event === 'status_note' && /机械复核通过/.test(e.detail)));
  });

  it('the default (model) still lands on the reviewable shelf', async () => {
    const { config, write, store } = gateProject({ run: ['node', 'scripts/check.js'] });
    write('scripts/check.js', "console.log('ok'); process.exit(0)");
    const dispatcher = postAndDispatch({ config, store });
    await wait(40);
    dispatcher.applyLanes({ packages: deliveredRows(store.get('PX-1')) });
    await waitFor(() => store.get('PX-1').status === 'delivered', 'delivered');
    assert.equal(isReviewable(store.get('PX-1')), true);
  });
});

