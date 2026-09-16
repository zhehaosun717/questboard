import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuestStore } from '../../src/core/store.js';
import { holdsSlot } from '../../src/core/rules.js';
import { readJsonLines } from '../../src/core/jsonl.js';
import { makeProject, card } from '../helpers.js';

function runningStore() {
  const project = makeProject();
  const store = new QuestStore(project.config);
  store.post({ package: 'CAN-1', brief: 'docs/briefs/CAN-1-x.md' });
  const quest = store.assign('CAN-1', { adventurer: card('codex-luna'), name: 'can1' });
  return { project, store, quest };
}

describe('cancellation request and manual resolution', () => {
  it('persists one request per attempt and replays it after restart', () => {
    const { project, store, quest } = runningStore();
    const requested = store.requestCancellation('CAN-1', { source: 'ui', reason: 'owner changed the brief' });
    assert.equal(requested.status, 'dispatched');
    assert.equal(holdsSlot(requested), true);
    assert.equal(requested.cancelRequest.bySource, 'ui');
    assert.equal(requested.cancelRequest.attemptId, quest.assignee.attemptId);
    const duplicate = store.requestCancellation('CAN-1', { source: 'cli', reason: 'a duplicate click' });
    assert.equal(duplicate.cancelRequest.requestId, requested.cancelRequest.requestId);
    assert.equal(readJsonLines(project.config.paths.events).filter((event) => event.event === 'cancel_requested').length, 1);
    const replayed = new QuestStore(project.config).get('CAN-1');
    assert.equal(replayed.cancelRequest.requestId, requested.cancelRequest.requestId);
    assert.equal(replayed.assignee.cancelRequest.result, 'pending');
  });

  it('requires explicit acknowledgement for a manual free and preserves the audit if event append fails', () => {
    const { store } = runningStore();
    assert.throws(() => store.setStatus('CAN-1', 'done', { source: 'ui', detail: 'not enough', ack: false }), { code: 'manual_ack_required' });
    assert.equal(store.get('CAN-1').status, 'dispatched');
    store.emitEvent = () => { throw new Error('events unavailable'); };
    const resolved = store.resolveManually('CAN-1', { source: 'mcp', reason: 'verified in the owner console', ack: true });
    assert.equal(resolved.status, 'cancelled');
    assert.equal(resolved.assignee, null);
    assert.equal(resolved.manualResolution.actorSource, 'mcp');
    assert.equal(new QuestStore(store.config).get('CAN-1').manualResolution.reason, 'verified in the owner console');
  });

  it('accepts only matching scoped wrapper evidence, never a bare acknowledgement', () => {
    const { store } = runningStore();
    const requested = store.requestCancellation('CAN-1', { source: 'cli', reason: 'stop this attempt' });
    const held = store.recordCancellationResult('CAN-1', {
      requestId: requested.cancelRequest.requestId, result: 'stopped_by_wrapper',
      evidence: { attemptId: requested.assignee.attemptId, ack: true, exitRequestId: 'old-request', scope: 'direct-child' },
    });
    assert.equal(held.status, 'dispatched');
    assert.equal(held.cancelRequest.result, 'unknown');
    assert.equal(held.assignee.name, 'can1');
    const stopped = store.recordCancellationResult('CAN-1', {
      requestId: requested.cancelRequest.requestId, result: 'stopped_by_wrapper', detail: 'direct child stopped',
      evidence: { attemptId: requested.assignee.attemptId, ack: true, exitRequestId: requested.cancelRequest.requestId, scope: 'direct-child' },
    });
    assert.equal(stopped.status, 'dispatched');
    assert.equal(holdsSlot(stopped), true);
    assert.equal(stopped.assignee.name, 'can1');
    assert.equal(stopped.cancelRequest.result, 'stopped_by_wrapper');
    assert.equal(stopped.cancelRequest.resolvedAt, undefined);
  });

  it('lets verified natural collector terminal evidence win a racing cancellation request', () => {
    const { store } = runningStore();
    const requested = store.requestCancellation('CAN-1', { source: 'ui', reason: 'stop if it is still running' });
    const delivered = store.setStatus('CAN-1', 'delivered', {
      source: 'collector', by: 'lanes', detail: 'exit 0 with report',
      evidence: { kind: 'collector', attemptId: requested.assignee.attemptId },
    });
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.assignee.name, 'can1');
    assert.equal(store.recordCancellationResult('CAN-1', {
      requestId: requested.cancelRequest.requestId, result: 'stopped_by_wrapper',
      evidence: { attemptId: requested.assignee.attemptId, ack: true, exitRequestId: requested.cancelRequest.requestId, scope: 'direct-child' },
    }).status, 'delivered');
  });
});
