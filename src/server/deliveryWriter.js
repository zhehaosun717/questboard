// Writes a server-lane delivery into <deliveryDir>/<name>.md, and a collector-extracted stream-json
// result into <outputDir>/<name>.md, then settles the quest — extracted from dispatcher.js (FB2-S1) so the
// dispatcher stays within its file-size budget. A write failure (including an empty/no-report session) is
// never "delivered": it only counts against the attempt that started it, and a transient failure keeps the
// assignee for the next poll's retry.
import fs from 'node:fs';
import path from 'node:path';
import { writeApiDelivery, TRANSIENT_DELIVERY_CODES } from '../core/deliveries.js';

// A pending delivery write is tracked by the attempt it belongs to, not by quest id: two different attempts
// of the same quest (an old one whose write is still hung, a new one after a reassignment) must never share
// one slot. Keying by quest id alone let a hung old write block every later attempt's delivery indefinitely
// (applyLanes would skip the quest entirely while the entry existed), and let that old write's own .finally
// clear an entry that, by the time it settled, actually belonged to a newer attempt. attemptId is always
// minted by store.assign()/adopt(); the name+lane+at fallback only serves a legacy row that predates it.
export function attemptKey({ attemptId, name, lane, at }) {
  return attemptId || `${name}:${lane || ''}:${at}`;
}

export function createDeliveryWriter({ config, store, stillOurs, safeguard, reportPersistenceFailure, captureReportFor, triggerDeliveredHooks, writeDelivery = writeApiDelivery, attemptEvidence }) {
  const pendingDeliveries = new Set();
  // The last transient delivery-write notice per quest id, so a fast poll loop reports "still running"
  // once per attempt instead of every tick. Bounded: an entry exists only while that quest is stuck in a
  // transient retry, and is dropped the moment the attempt resolves (delivered, terminally failed, or the
  // quest moves on to a new assignment) — never accumulates across quests or attempts.
  const transientNotices = new Map();

  // Clears this attempt's own transient-notice entry only when it is still the one actually recorded there —
  // a stale attempt's late-settling write (a slow success or failure that finally resolves after the quest
  // moved on to a newer attempt) must never wipe out a newer attempt's own de-dup entry just because both
  // happen to share the same quest id; that would only cause the newer attempt's next identical failure to
  // be reported again instead of folded.
  function clearOwnNotice(questId, ownKey) {
    const last = transientNotices.get(questId);
    if (last && last.key === ownKey) transientNotices.delete(questId);
  }

  // A write failure (including an empty/no-report session) is never "delivered" — that would hide the
  // real state behind a fake success. It only counts against the attempt that started it: if the quest
  // moved on (reassigned, released, cancelled) before the write settles, this attempt changes nothing.
  function deliverFromApi(quest, transition, targetStatus = 'delivered') {
    const { name, lane, at, attemptId } = quest.assignee;
    const attempt = { attemptId, name, lane, at };
    const key = attemptKey(attempt);
    pendingDeliveries.add(key);
    // writeDelivery may throw synchronously (a bad argument, a test double, a buggy override) rather than
    // reject; routing the call through a resolved promise turns that into a normal rejection so .catch
    // below still runs and .finally still releases the pending-delivery slot instead of leaking it forever.
    // The identity check runs before the write starts too, not just after: applyLanes calls in with a
    // fresh quest so this is normally a no-op, but it means a caller that reuses this function never sends
    // a write for an attempt it already knows is stale.
    // Every store write below is guarded (safeguard, F4): with nothing upstream left to turn a thrown error
    // into a normal result, an unguarded throw from any of these — either sink down, or (the F4 native case)
    // quests.jsonl and the events file both down at once — would escape this `.catch` itself as an unhandled
    // rejection, since nothing follows it but `.finally`. A guarded failure here simply leaves the quest in
    // whatever its last successfully durable state was (store.save() is disk-first, so a failed setStatus
    // never advances the in-memory copy past what actually got written) — no slot lost, no crash, and the
    // failure is still reported via reportPersistenceFailure even when the events sink that would normally
    // carry it is itself the thing that is down.
    return Promise.resolve()
      .then(() => (stillOurs(quest.id, attempt) ? writeDelivery(config, lane, name) : null))
      .then((out) => {
        if (out === null) return null;
        clearOwnNotice(quest.id, key);
        const current = stillOurs(quest.id, attempt);
        if (!current) return null;
        const note = `交付已写入 ${path.relative(config.root, out).split(path.sep).join('/')}`;
        const detail = [note, transition.detail].filter(Boolean).join(' | ');
        // Capture before the status write so the reference lands in the same durable record as the
        // 'delivered' fact; a captured failure simply carries no reference.
        const report = captureReportFor(current);
        let next = null;
        safeguard('deliverFromApi setStatus ' + targetStatus, detail, () => {
          next = store.setStatus(quest.id, targetStatus, {
          detail, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attempt: attemptEvidence(attempt) },
          ...(report ? { report } : {}),
          });
          if (next && targetStatus === 'delivered') triggerDeliveredHooks(next);
        });
        return next;
      })
      .catch((error) => {
        const current = stillOurs(quest.id, attempt);
        if (!current) { clearOwnNotice(quest.id, key); return; }
        // "Still running", an HTTP error or an unreachable API is not proof the worker died — it is
        // positive evidence it (or the thing polling it) is still there. Leave the assignee alone so the
        // next poll retries, and note it once per attempt (keyed on this attempt's identity and the exact
        // message) so a tight poll loop cannot spam the same notice forever.
        if (TRANSIENT_DELIVERY_CODES.has(error.code)) {
          const last = transientNotices.get(quest.id);
          if (!last || last.key !== key || last.message !== error.message) {
            safeguard('deliverFromApi transient notice', error.message, () => store.emitEvent(current, 'delivery_write_failed', { by: 'board', detail: error.message }));
            transientNotices.set(quest.id, { key, message: error.message });
          }
          return;
        }
        clearOwnNotice(quest.id, key);
        safeguard('deliverFromApi delivery_write_failed', error.message, () => store.emitEvent(current, 'delivery_write_failed', { by: 'board', detail: error.message }));
        // A failed delivery still binds whatever the attempt actually left on disk (a partial report or an
        // exit-file summary), so the failure is readable next to real evidence instead of only a message.
        const report = captureReportFor(current);
        safeguard('deliverFromApi setStatus failed', error.message, () => store.setStatus(quest.id, 'failed', {
          detail: `交差文件没写成：${error.message}`, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attempt: attemptEvidence(attempt) },
          ...(report ? { report } : {}),
        }));
      })
      .finally(() => pendingDeliveries.delete(key));
  }

  // FB2-01.3: the collector found a claude stream-json result line but no .exit and no .md. Write the
  // extracted result as the attempt's report, then run the ordinary delivered transition. The worker's own
  // .md always wins — never overwrite it. A write that fails is reported exactly like an API-lane delivery
  // write failure: the quest fails with the reason, never a fake delivered.
  function deliverStreamResult(quest, transition, lane, targetStatus = 'delivered') {
    const attempt = quest.assignee;
    if (!attempt || !stillOurs(quest.id, attempt)) return null;
    const mdRel = `${lane.outputDir}/${attempt.name}.md`;
    const mdPath = path.join(config.root, mdRel);
    if (!fs.existsSync(mdPath)) {
      try {
        fs.mkdirSync(path.dirname(mdPath), { recursive: true });
        fs.writeFileSync(mdPath, transition.streamResult, 'utf8');
      } catch (error) {
        safeguard('deliverStreamResult delivery_write_failed', error.message, () => store.emitEvent(quest, 'delivery_write_failed', { by: 'board', detail: `交付报告没写成：${error.message}` }));
        const current = stillOurs(quest.id, attempt);
        if (!current) return null;
        const report = captureReportFor(current);
        safeguard('deliverStreamResult setStatus failed', error.message, () => store.setStatus(quest.id, 'failed', {
          detail: `交差文件没写成：${error.message}`, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attempt: attemptEvidence(attempt) },
          ...(report ? { report } : {}),
        }));
        return null;
      }
    }
    const note = `交付报告已写入 ${mdRel}（来自 stream-json 的 result 行）`;
    const detail = [note, transition.detail].filter(Boolean).join(' | ');
    const current = stillOurs(quest.id, attempt);
    if (!current) return null;
    const report = captureReportFor(current);
    let next = null;
    safeguard('deliverStreamResult setStatus ' + targetStatus, detail, () => {
      next = store.setStatus(quest.id, targetStatus, {
        detail, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attempt: attemptEvidence(attempt) },
        ...(report ? { report } : {}),
      });
      if (next && targetStatus === 'delivered') triggerDeliveredHooks(next);
    });
    return next;
  }

  const isPending = (assignee) => pendingDeliveries.has(attemptKey(assignee));
  return { deliverFromApi, deliverStreamResult, attemptKey, isPending };
}
