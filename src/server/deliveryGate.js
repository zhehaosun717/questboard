// FB2-05: the delivered-transition settlement — the project self-check gate (policy.postDeliveryCheck)
// and the post-time review modes (none|mechanical|model). Extracted from dispatcher.js (which owns the
// surrounding lane loop, the control handles and the delivery writers) so the gate's async chain lives in
// one place and the dispatcher stays within its file-size budget.
//
// The flow per delivered transition, once per attempt at a time:
//   gate (if configured) → a miss holds delivery: check_failed is emitted (store.appendCheckResult) and
//     the worker bounces to fix in the same attempt — a server lane gets a message posted back into its
//     own session, a file lane re-runs the exact wrapper command with QB_FIX_HINT — until maxRounds, then
//     the quest fails with every round's summary and exit code in lastDetail;
//   on pass → the review mode routes the settlement: mechanical runs the owner's check once and records
//     the conclusion (never a bounce), none hands the quest to the coordinator (needs_coordinator), model
//     writes delivered as always.
import fs from 'node:fs';
import path from 'node:path';
import { executePlan } from '../core/dispatch.js';
import { protocolFor } from '../lanes/protocols.js';
import { checkLogPath, mechanicalLogPath, readSessionId, runPostDeliveryGate, runMechanicalCheck } from '../core/postDeliveryCheck.js';

export function createDeliveryGate({
  config, store, runners, fetchImpl, runCheck, runMechanical,
  stillOurs, attemptKey, attachChild, fixPlans, controlHandles,
  safeguard, reportPersistenceFailure, captureReportFor, triggerDeliveredHooks,
  deliverFromApi, deliverStreamResult, attemptEvidence,
}) {
  // A fingerprint of the delivery evidence this transition judged (its text plus the attempt's artifact
  // mtimes): a failed round's fingerprint is stored on the check result, so the next poll's replay of the
  // exact same delivery is skipped (the bounce already consumed it), while the worker's fresh delivery
  // after a fix — new text, new mtimes — starts the next round. Server lanes have no files; their final
  // message text is the fingerprint, and a byte-identical re-delivery after a fix round is the one edge a
  // fingerprint cannot tell apart (the quest then stalls visibly instead of re-checking stale evidence).
  function deliveryFingerprint(quest, transition, lane) {
    const parts = [transition.detail || '', transition.streamResult || ''];
    if (lane && lane.outputDir && quest.assignee) {
      const base = path.join(config.root, lane.outputDir, quest.assignee.name);
      for (const ext of ['.exit', '.md', '.out']) {
        try { parts.push(ext + ':' + fs.statSync(base + ext).mtimeMs); } catch { parts.push(ext + ':'); }
      }
    }
    return parts.join('\u0000').slice(0, 300);
  }

  // Guarded status_note for the gate flow: the quest stays exactly as it is; only the report of the
  // bounce attempt lands in the events file.
  function noteCheck(quest, detail) {
    safeguard('postDeliveryCheck status_note', detail, () => store.emitEvent(quest, 'status_note', { by: 'board', detail }));
  }

  // The failed round's error text, truncated for the env/API payload that carries it back to the worker.
  function fixHintFor(quest) {
    const last = [...(quest.assignee.checkResults || [])].at(-1);
    const round = last ? last.round : '?';
    return ('自检失败（第 ' + round + ' 轮），错误如下：\n' + (last ? last.summary : '')).slice(0, 1200);
  }

  // maxRounds reached: the quest fails with every round's summary and exit code in lastDetail — the whole
  // history a coordinator reads without opening the check log.
  function failWithCheckHistory(quest) {
    const results = quest.assignee.checkResults || [];
    const rounds = results.map((r) => '第 ' + r.round + ' 轮（exit ' + (r.exitCode ?? '—') + '）：' + r.summary).join('\n');
    safeguard('postDeliveryCheck setStatus failed', quest.id, () => store.setStatus(quest.id, 'failed', {
      detail: '自检连续 ' + results.length + ' 轮没过，任务失败：\n' + rounds,
      by: 'lanes', source: 'collector', evidence: { kind: 'collector', attempt: attemptEvidence(quest.assignee) },
    }));
  }

  // One failed round's bounce: the same worker, the same session, the same attempt. A server lane gets a
  // message posted back into its own session; a file lane re-runs the exact wrapper command it was
  // dispatched with, plus QB_FIX_HINT carrying the error text (examples/basic/scripts/run-worker.mjs
  // reads that env and hands the hint to the agent over stdin). A bounce that cannot happen (no session
  // id, no recorded command for a hand-adopted worker, a refused recheck) never invents a substitute: the
  // quest stays dispatched and a status_note says exactly which channel is missing.
  async function bounceFix(quest) {
    const attempt = quest.assignee;
    const lane = config.lanes[attempt.lane];
    const protocol = lane ? protocolFor(lane) : null;
    const roundsDone = (attempt.checkResults || []).length;
    if (protocol) {
      const sessionId = readSessionId(config, lane, attempt.name, attempt.session && attempt.session.id);
      if (!sessionId) {
        noteCheck(quest, '第 ' + roundsDone + ' 轮自检没过，但没有记录的 session id，修复提示发不出去；任务保持派单状态，worker 没收到提示不会改');
        return;
      }
      let sent;
      try {
        sent = await protocol.sendMessage(fetchImpl, lane, sessionId, fixHintFor(quest) + '\n请修复后重新交付。');
      } catch (error) {
        sent = { ok: false, reason: error.message };
      }
      if (!sent.ok) {
        noteCheck(quest, '第 ' + roundsDone + ' 轮自检没过，修复提示没送到 session：' + sent.reason + '；任务保持派单状态');
        return;
      }
      noteCheck(quest, '第 ' + roundsDone + ' 轮自检没过，已把错误发给同一 session 的 worker 让它原地修复');
      return;
    }
    const fixRun = fixPlans.get(attempt.attemptId);
    if (!fixRun) {
      noteCheck(quest, '第 ' + roundsDone + ' 轮自检没过，但这次派遣没有留下可重跑的启动命令（手工接管的 worker 或看板重启过），没法自动回弹；请手动让它修复后重新交付');
      return;
    }
    const controlToken = controlHandles.get(attempt.attemptId)?.token || null;
    const step = {
      kind: 'run',
      command: [...fixRun.command],
      env: {
        ...fixRun.env,
        QB_FIX_HINT: fixHintFor(quest),
        QUESTBOARD_ATTEMPT_ID: attempt.attemptId,
        ...(controlToken ? { QUESTBOARD_CONTROL_TOKEN: controlToken } : {}),
      },
      ...(lane && lane.control ? { control: lane.control } : {}),
    };
    let result;
    try {
      result = await executePlan(config, [step], {
        name: attempt.name,
        runners,
        recheck: () => (stillOurs(quest.id, attempt)
          ? { ok: true }
          : { ok: false, detail: '排队期间任务被改派、释放或取消，不再重跑修复' }),
        onChild: (child, childStep) => attachChild(attempt.attemptId, child, childStep),
      });
    } catch (error) {
      noteCheck(quest, '第 ' + roundsDone + ' 轮自检没过，修复重跑出错：' + error.message);
      return;
    }
    if (result.blocked || !result.ok) {
      noteCheck(quest, '第 ' + roundsDone + ' 轮自检没过，修复重跑没执行：' + result.detail);
      return;
    }
    noteCheck(quest, '第 ' + roundsDone + ' 轮自检没过，已让 worker ' + attempt.name + ' 原地重跑修复（错误已附在提示里）');
  }

  // The delivered transition's whole settlement: gate → (pass) mechanical review + status routing. The
  // gate holds delivery on a miss and bounces/fails; the mechanical check never bounces, it only records.
  async function settleWithCheck(quest, transition, lane) {
    const attempt = quest.assignee;
    // FB2-10 item 3: the delivered attempt's token usage is recorded before any gate outcome, so even a
    // delivery that bounces back for fixes keeps its numbers in the dispatch history.
    if (Object.hasOwn(transition, 'usage')) {
      safeguard('recordDeliveryUsage', quest.id, () => store.recordDeliveryUsage(quest.id, attempt, transition.usage));
    }
    const gate = config.policy?.postDeliveryCheck;
    if (!gate) return settleDelivered(quest, transition, lane);
    if (!stillOurs(quest.id, attempt)) return;
    const fixPlan = fixPlans.get(attempt.attemptId);
    let outcome;
    try {
      outcome = await (runCheck || runPostDeliveryGate)({
        config, check: gate, logPath: checkLogPath(config, lane, attempt.name), env: fixPlan ? fixPlan.env : {},
      });
    } catch (error) {
      outcome = { ok: false, exitCode: null, summary: '自检运行出错：' + error.message };
    }
    let withResult;
    try {
      withResult = store.appendCheckResult(quest.id, attempt, { ...outcome, evidence: deliveryFingerprint(quest, transition, lane) });
    } catch (error) {
      reportPersistenceFailure('appendCheckResult', quest.id, error);
      return;
    }
    if (!outcome.ok) {
      const rounds = withResult.assignee.checkResults.length;
      if (rounds >= gate.maxRounds) failWithCheckHistory(withResult);
      else await bounceFix(withResult);
      return;
    }
    return settleDelivered(withResult, transition, lane);
  }

  // The settled delivery: the review mode decides where it lands. mechanical runs the owner's check once
  // and records the conclusion (never a bounce); none hands the quest to the coordinator; model — the
  // default — writes delivered as always. The per-lane delivery write stays the same in every case: the
  // API lane's report is written to its .md first, the stream-json result to the lane's output.
  async function settleDelivered(quest, transition, lane) {
    const attempt = quest.assignee;
    if (!attempt || !stillOurs(quest.id, attempt)) return;
    let current = quest;
    if (quest.review === 'mechanical' && quest.mechanicalCheck) {
      const fixPlan = fixPlans.get(attempt.attemptId);
      let outcome;
      try {
        outcome = await (runMechanical || runMechanicalCheck)({
          config,
          command: quest.mechanicalCheck,
          logPath: mechanicalLogPath(config, lane, attempt.name),
          env: fixPlan ? fixPlan.env : {},
          timeoutMs: config.policy?.postDeliveryCheck ? config.policy.postDeliveryCheck.timeoutMs : null,
        });
      } catch (error) {
        outcome = { ok: false, exitCode: null, summary: '机械复核运行出错：' + error.message };
      }
      try {
        current = store.recordMechanicalReview(quest.id, attempt, outcome);
      } catch (error) {
        reportPersistenceFailure('recordMechanicalReview', quest.id, error);
        current = quest;
      }
    }
    if (current.review === 'none') {
      const note = ['交付完成，等 coordinator 验证', transition.detail].filter(Boolean).join(' | ');
      if (lane && lane.api && lane.deliveryDir) { deliverFromApi(current, transition, 'needs_coordinator'); return; }
      if (transition.streamResult && lane && lane.outputDir) { deliverStreamResult(current, transition, lane, 'needs_coordinator'); return; }
      const report = captureReportFor(current);
      safeguard('settleDelivered setStatus needs_coordinator', note, () => store.setStatus(current.id, 'needs_coordinator', {
        detail: note, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attempt: attemptEvidence(attempt) },
        ...(report ? { report } : {}),
      }));
      return;
    }
    if (lane && lane.api && lane.deliveryDir) { deliverFromApi(current, transition); return; }
    if (transition.streamResult && lane && lane.outputDir) { deliverStreamResult(current, transition, lane); return; }
    const report = captureReportFor(current);
    const next = store.setStatus(current.id, 'delivered', {
      detail: transition.detail, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attempt: attemptEvidence(attempt) },
      ...(report ? { report } : {}),
    });
    if (next) triggerDeliveredHooks(next);
  }

  return { settleWithCheck, deliveryFingerprint };
}
