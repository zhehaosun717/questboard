// Turns owner picks into running workers and lane results into quest statuses.
import path from 'node:path';
import { canDispatch, OPEN_STATUSES } from '../core/rules.js';
import { workerName, planDispatch, executePlan, preflight, workerEvidence } from '../core/dispatch.js';
import { deriveTransitions } from '../core/sync.js';
import { withFileSets } from '../core/briefs.js';
import { lockPresent, briefExists } from '../core/snapshot.js';
import { writeApiDelivery } from '../core/deliveries.js';

const EVIDENCE_WAIT_MS = 10000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDispatcher({ config, store, runners, evidenceWaitMs = EVIDENCE_WAIT_MS, writeDelivery = writeApiDelivery }) {
  const queues = new Map();
  const pendingDeliveries = new Set();

  const stillOurs = (questId, name) => {
    const current = store.get(questId);
    return current && current.status === 'dispatched' && current.assignee && current.assignee.name === name ? current : null;
  };

  // Lanes marked serialize run one dispatch at a time (OpenCode's send script shares a session file);
  // spacingMs waits between starts (the DeepSeek harness races on simultaneous starts).
  function enqueue(laneId, job) {
    const lane = config.lanes[laneId];
    if (!lane.serialize && !lane.spacingMs) return job();
    const previous = queues.get(laneId) || Promise.resolve();
    const run = previous.then(job);
    queues.set(laneId, run.catch(() => null).then(() => delay(lane.spacingMs)));
    return run;
  }

  function announceStarted(questId, name, detail = `脚本已启动，worker ${name}`) {
    const current = stillOurs(questId, name);
    if (current) store.emitEvent(current, 'dispatched', { by: 'board', detail });
  }

  function failIfStillOurs(questId, name, detail) {
    if (stillOurs(questId, name)) store.setStatus(questId, 'failed', { detail, by: 'board' });
  }

  // A wrapper's exit code is not the truth about its worker; wait for the registry row or output first.
  async function settleFailedWrapper(quest, laneId, name, result) {
    const deadline = Date.now() + evidenceWaitMs;
    for (;;) {
      const evidence = workerEvidence(config, laneId, name, quest.assignee.at);
      if (evidence) { announceStarted(quest.id, name, `脚本报错但 worker 已启动（${evidence}）：${result.detail.split('\n')[0]}`); return; }
      if (Date.now() >= deadline) break;
      await delay(Math.min(2000, Math.max(0, deadline - Date.now())));
    }
    failIfStillOurs(quest.id, name, result.detail);
  }

  // Synchronous from the fresh read to store.assign, so two quick drops cannot both pass the checks.
  function assign(questId, adventurer, by) {
    const quests = withFileSets(config, store.list());
    const quest = quests.find((q) => q.id === questId);
    if (!quest) return { status: 404, body: { error: 'quest not found' } };
    const env = { treeLocked: lockPresent(config), briefExists: briefExists(config, quest), laneIds: new Set(Object.keys(config.lanes)) };
    const verdict = canDispatch({ quest, adventurer, quests, policy: config.policy, env });
    if (!verdict.ok) return { status: 409, body: { error: 'refused', reasons: verdict.reasons } };
    const name = workerName(quest);
    let plan;
    try {
      plan = planDispatch(config, quest, adventurer, name);
      if (!runners) preflight(config, plan);
    } catch (error) {
      return { status: 409, body: { error: 'refused', reasons: [{ code: 'preflight', message: error.message }] } };
    }
    const running = store.assign(quest.id, { adventurer, name, by });
    enqueue(adventurer.lane, () => executePlan(config, plan, { name, runners }))
      .then((result) => (result.ok ? announceStarted(quest.id, name) : settleFailedWrapper(running, adventurer.lane, name, result)))
      .catch((error) => failIfStillOurs(quest.id, name, `派遣异常：${error.message}`));
    return { status: 200, body: { quest: running } };
  }

  // Records a worker started by hand so the board tracks it; runs nothing.
  function adopt(questId, adventurer, name, by) {
    const quest = store.get(questId);
    if (!quest) return { status: 404, body: { error: 'quest not found' } };
    if (quest.kind === 'owner') return { status: 409, body: { error: `${questId} is an owner quest` } };
    if (!OPEN_STATUSES.has(quest.status)) return { status: 409, body: { error: `${questId} is ${quest.status}; only an open quest can adopt a worker` } };
    if (!/^[a-z0-9_]{1,48}$/.test(String(name || ''))) return { status: 400, body: { error: 'name must be the worker name given to the dispatch script (e.g. run3)' } };
    return { status: 200, body: { quest: store.assign(questId, { adventurer, name, by, detail: `接管已在跑的 worker ${name}`, event: 'dispatched', adopted: true }) } };
  }

  function deliverFromApi(quest, transition) {
    const { name, lane } = quest.assignee;
    pendingDeliveries.add(quest.id);
    Promise.resolve()
      .then(() => writeDelivery(config, lane, name))
      .then((out) => `交付已写入 ${path.relative(config.root, out).split(path.sep).join('/')}`)
      .catch((error) => {
        store.emitEvent(quest, 'delivery_write_failed', { by: 'board', detail: error.message });
        return `交付文件没写成：${error.message}`;
      })
      .then((note) => {
        if (stillOurs(quest.id, name)) store.setStatus(quest.id, 'delivered', { detail: [note, transition.detail].filter(Boolean).join(' | '), by: 'lanes' });
      })
      .finally(() => pendingDeliveries.delete(quest.id));
  }

  function applyLanes(lanes) {
    for (const transition of deriveTransitions(store.list(), lanes.packages)) {
      if (pendingDeliveries.has(transition.id)) continue;
      const quest = store.get(transition.id);
      const lane = quest.assignee && config.lanes[quest.assignee.lane];
      if (transition.status === 'delivered' && lane && lane.api && lane.deliveryDir) { deliverFromApi(quest, transition); continue; }
      store.setStatus(transition.id, transition.status, { detail: transition.detail, by: 'lanes' });
    }
  }

  return { assign, adopt, applyLanes };
}
