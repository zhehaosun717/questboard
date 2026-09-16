// Process-local adapters for the opt-in generic wrapper.  The board never kills the wrapper itself: it
// sends one tokenized request, waits for the wrapper's matching acknowledgement, then checks the matching
// exit-file metadata.  A timeout or a natural exit is deliberately unknown, not stopped.
import fs from 'node:fs';
import path from 'node:path';
import { attemptEvidence } from '../core/cancellation.js';

function exitEvidence(config, laneId, name, requestId) {
  const lane = config.lanes[laneId];
  if (!lane?.outputDir) return null;
  try {
    const text = fs.readFileSync(path.join(config.root, lane.outputDir, `${name}.exit`), 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const metadata = lines[1] ? JSON.parse(lines[1]) : null;
    return metadata && metadata.requestId === requestId && metadata.scope === 'direct-child' ? metadata : null;
  } catch { return null; }
}

export function createGenericWrapperAdapter({ config, timeoutMs = 5000 } = {}) {
  return ({ attempt, request, handle }) => new Promise((resolve) => {
    const child = handle?.child;
    const token = handle?.token;
    if (!child || typeof child.send !== 'function' || !token) {
      resolve({ result: 'manual_required', detail: '该 worker 没有可验证的 generic wrapper 控制通道，需要人工确认' });
      return;
    }
    let acknowledged = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.('message', onMessage);
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      child.off?.('error', onError);
      resolve(value);
    };
    const onMessage = (message) => {
      if (!message || message.type !== 'questboard-cancel-ack' || message.attemptId !== attempt.attemptId || message.requestId !== request.requestId || message.scope !== 'direct-child') return;
      acknowledged = true;
      // The wrapper sends the ack immediately before killing its direct child. The exit event and the
      // exit-file write are the second, independent fact; ack alone never frees the reservation.
      if (exitEvidence(config, attempt.lane, attempt.name, request.requestId)) finish({
        result: 'stopped_by_wrapper', detail: 'generic wrapper acknowledged and recorded a direct-child stop',
        evidence: { kind: 'wrapper', attempt: attemptEvidence(attempt), ack: true, exitRequestId: request.requestId, scope: 'direct-child' },
      });
    };
    const onExit = () => {
      const evidence = exitEvidence(config, attempt.lane, attempt.name, request.requestId);
      if (acknowledged && evidence) finish({
        result: 'stopped_by_wrapper', detail: 'generic wrapper acknowledged and recorded a direct-child stop',
        evidence: { kind: 'wrapper', attempt: attemptEvidence(attempt), ack: true, exitRequestId: evidence.requestId, scope: evidence.scope },
      });
      else finish({ result: 'unknown', detail: 'worker exited without a matching cancellation acknowledgement and exit record' });
    };
    const onError = () => finish({ result: 'unknown', detail: 'worker control channel ended before a matching acknowledgement' });
    const timer = setTimeout(() => finish({ result: 'unknown', detail: 'cancellation control timed out; the worker reservation remains held for manual resolution' }), timeoutMs);
    timer.unref?.();
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('close', onExit);
    child.once('error', onError);
    try {
      child.send({ type: 'questboard-cancel', attemptId: attempt.attemptId, requestId: request.requestId, token }, (error) => {
        if (error) finish({ result: 'unknown', detail: 'cancellation control could not be delivered; the worker reservation remains held' });
      });
    } catch {
      finish({ result: 'unknown', detail: 'cancellation control could not be delivered; the worker reservation remains held' });
    }
  });
}
