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

// FB2-01.3/4: file-lane transcript tail parsers. The claude lane's .out is a stream-json tool transcript
// whose final line is a {"type":"result"} object; the agy lane's ends with a VERDICT line. Both are parsed
// here, vendor-neutral, so collector.js and workers.js never hand-roll the scan.
import { parseStreamJsonResult, parseAgyVerdict } from '../../src/lanes/protocols.js';

describe('parseStreamJsonResult (FB2-01.3)', () => {
  it('returns the final result line text, scanning from the end of the transcript', () => {
    const wanted = '1. fixed src/a.js\n2. all tests green';
    const text = [
      '{"type":"assistant","message":"..."}',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: wanted }),
    ].join('\n');
    assert.deepEqual(parseStreamJsonResult(text), { result: wanted, isError: false });
  });

  it('keeps the LAST result line when a transcript has more than one', () => {
    const text = [
      '{"type":"result","is_error":false,"result":"first, superseded"}',
      '{"type":"result","is_error":false,"result":"final answer"}',
    ].join('\n');
    assert.equal(parseStreamJsonResult(text).result, 'final answer');
  });

  it('flags an error result instead of treating it as a delivery', () => {
    const text = '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 401"}';
    assert.deepEqual(parseStreamJsonResult(text), { result: 'API Error: 401', isError: true });
  });

  it('returns null when no result line exists, and never throws on garbage lines', () => {
    assert.equal(parseStreamJsonResult('plain text\n{"type":"assistant"}'), null);
    assert.equal(parseStreamJsonResult('{not json}\n{"type":"result"'), null);
    assert.equal(parseStreamJsonResult(''), null);
    assert.equal(parseStreamJsonResult(null), null);
    // A result-looking line that is not the last word still counts; trailing noise lines do not hide it.
    const text = '{"type":"result","is_error":false,"result":"done"}\n{"type":"system","msg":"bye"}\n';
    assert.equal(parseStreamJsonResult(text).result, 'done');
  });
});

describe('parseAgyVerdict (FB2-01.4)', () => {
  it('parses the final VERDICT line, case-insensitively, PASS WITH FINDINGS before PASS', () => {
    assert.equal(parseAgyVerdict('working...\nVERDICT: PASS\n'), 'PASS');
    assert.equal(parseAgyVerdict('VERDICT: FAIL, see above\n'), 'FAIL');
    assert.equal(parseAgyVerdict('verdict: pass with findings\n'), 'findings');
  });

  it('keeps the last verdict line and returns null when there is none', () => {
    assert.equal(parseAgyVerdict('VERDICT: FAIL\nmore work\nVERDICT: PASS\n'), 'PASS');
    assert.equal(parseAgyVerdict('no verdict here'), null);
    assert.equal(parseAgyVerdict(''), null);
    // "VERDICT: PASS or FAIL" lists alternatives -- a template, not a verdict -- and does not count.
    assert.equal(parseAgyVerdict('VERDICT: PASS or FAIL, pick one'), null);
  });
});
