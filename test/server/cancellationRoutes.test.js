import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixture.js';

let fx;
before(async () => { fx = await startFixture(); fx.project.write('docs/briefs/CAN-HTTP-1-x.md', 'CAN-HTTP'); });
after(() => fx.close());

describe('cancellation HTTP routes', () => {
  it('records one UI request, reports unsupported control honestly, and requires manual acknowledgement', async () => {
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'CAN-HTTP-1', brief: 'docs/briefs/CAN-HTTP-1-x.md' })).status, 201);
    assert.equal((await fx.api('/api/quests/CAN-HTTP-1/assign', 'POST', { adventurer: 'codex-luna' }, { 'x-questboard-source': 'ui' })).status, 200);
    const missing = await fx.api('/api/quests/CAN-HTTP-1/cancel', 'POST', {}, { 'x-questboard-source': 'ui' });
    assert.equal(missing.status, 409);
    const requested = await fx.api('/api/quests/CAN-HTTP-1/cancel', 'POST', { reason: 'owner stopped the run' }, { 'x-questboard-source': 'ui' });
    assert.equal(requested.status, 200);
    assert.equal(requested.body.result, 'manual_required');
    assert.equal(requested.body.quest.status, 'dispatched');
    const duplicate = await fx.api('/api/quests/CAN-HTTP-1/cancel', 'POST', { reason: 'second click' }, { 'x-questboard-source': 'ui' });
    assert.equal(duplicate.body.quest.cancelRequest.requestId, requested.body.quest.cancelRequest.requestId);
    const noAck = await fx.api('/api/quests/CAN-HTTP-1/resolve', 'POST', { reason: 'not acknowledged' }, { 'x-questboard-source': 'ui' });
    assert.equal(noAck.status, 409);
    const resolved = await fx.api('/api/quests/CAN-HTTP-1/resolve', 'POST', { reason: 'verified worker is gone', ack: true }, { 'x-questboard-source': 'ui' });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.quest.assignee, null);
    assert.equal(resolved.body.quest.manualResolution.actorSource, 'ui');
  });

  it('does not skip the core guard when HTTP omits or invents the source header', async () => {
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'CAN-HTTP-2', brief: 'docs/briefs/CAN-HTTP-1-x.md' })).status, 201);
    assert.equal((await fx.api('/api/quests/CAN-HTTP-2/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
    const refused = await fx.api('/api/quests/CAN-HTTP-2/status', 'POST', { status: 'done', detail: 'no acknowledgement' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.reasons[0].code, 'manual_ack_required');
    assert.equal((await fx.api('/api/quests/CAN-HTTP-2/cancel', 'POST', { reason: 'unknown caller' }, { 'x-questboard-source': 'not-a-source' })).status, 409);
    const resolved = await fx.api('/api/quests/CAN-HTTP-2/status', 'POST', { status: 'done', detail: 'owner verified the worker is gone', ack: true });
    assert.equal(resolved.status, 200, resolved.text);
    assert.equal(resolved.body.quest.assignee, null);
    assert.equal(resolved.body.quest.manualResolution.actorSource, 'unknown');
  });
});
