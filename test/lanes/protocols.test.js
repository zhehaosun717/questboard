// The vendor-neutral registry (Bundle 3): collector.js and deliveries.js look a lane's protocol up here
// instead of branching on lane.api directly. These pin the lookup itself; the OpenCode behaviour it
// dispatches to is already covered by opencode.test.js (sessionState) and delivery-terminal.test.js
// (writeApiDelivery, which exercises parseDelivery through the real writer).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROTOCOLS, protocolFor } from '../../src/lanes/protocols.js';

describe('protocolFor', () => {
  it('resolves a lane by its protocol field, never by api alone', () => {
    assert.equal(protocolFor({ api: 'http://oc.test', protocol: 'opencode-session' }), PROTOCOLS['opencode-session']);
    assert.equal(protocolFor({ api: 'http://oc.test' }), null, 'no protocol field means no dispatch, even with api set');
    assert.equal(protocolFor({ outputDir: 'o' }), null, 'a file lane has neither api nor protocol');
    assert.equal(protocolFor(null), null);
    assert.equal(protocolFor({ api: 'http://oc.test', protocol: 'ghost' }), null, 'an unregistered name resolves to nothing, same as none');
  });

  it('registers the eight functions the collector and the delivery writer both need, including the URL shapes and transport (M2)', () => {
    const protocol = PROTOCOLS['opencode-session'];
    assert.equal(typeof protocol.fetchJson, 'function');
    assert.equal(typeof protocol.sessionModel, 'function');
    assert.equal(typeof protocol.sessionState, 'function');
    assert.equal(typeof protocol.sessionLimitReason, 'function');
    assert.equal(typeof protocol.parseDelivery, 'function');
    assert.equal(typeof protocol.messagesUrl, 'function');
    assert.equal(typeof protocol.sessionUrl, 'function');
    assert.equal(typeof protocol.fetchMessages, 'function');
  });

  it('M2: the registry owns the URL shapes, not collector.js/deliveries.js — messagesUrl/sessionUrl leave the session id as given (collector never encodes it)', () => {
    const protocol = PROTOCOLS['opencode-session'];
    const lane = { api: 'http://oc.test' };
    assert.equal(protocol.messagesUrl(lane, 'ses 1'), 'http://oc.test/session/ses 1/message');
    assert.equal(protocol.sessionUrl(lane, 'ses 1'), 'http://oc.test/session/ses 1');
  });

  it('M2: fetchMessages encodes the session id into messagesUrl and returns the parsed body', async () => {
    const protocol = PROTOCOLS['opencode-session'];
    const lane = { api: 'http://oc.test' };
    const seen = [];
    const fetchImpl = async (url) => { seen.push(url); return { ok: true, json: async () => ['msg'] }; };
    const messages = await protocol.fetchMessages(fetchImpl, lane, 'ses 1', { laneId: 'oc' });
    assert.deepEqual(messages, ['msg']);
    assert.deepEqual(seen, ['http://oc.test/session/ses%201/message']);
  });

  it('parseDelivery returns the report text on a clean stop, and throws named, coded errors otherwise', () => {
    const protocol = PROTOCOLS['opencode-session'];
    const stop = [{ info: { role: 'assistant', time: { completed: Date.now() }, finish: 'stop' }, parts: [{ type: 'text', text: 'Final report' }] }];
    assert.equal(protocol.parseDelivery(stop, 'ses_1'), 'Final report');

    assert.throws(() => protocol.parseDelivery([], 'ses_2'), (err) => err.code === 'STILL_RUNNING' && /no assistant messages/.test(err.message));

    const errored = [{ info: { role: 'assistant', time: {}, error: { name: 'MessageAbortedError' } }, parts: [] }];
    assert.throws(() => protocol.parseDelivery(errored, 'ses_3'), (err) => err.code === undefined && /MessageAbortedError/.test(err.message));
  });
});
