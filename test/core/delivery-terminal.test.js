import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { writeApiDelivery, TRANSIENT_DELIVERY_CODES } from '../../src/core/deliveries.js';
import { sessionState } from '../../src/lanes/opencode.js';
import { STALE_MS } from '../../src/lanes/workers.js';
import { makeProject } from '../helpers.js';

// Fake messages only, plus one local 127.0.0.1 server for the recovery case — never a live provider.
const reply = (messages) => async () => ({ ok: true, status: 200, json: async () => messages });
const assistant = (info, parts = []) => ({ info: { role: 'assistant', ...info }, parts });
const text = (t) => ({ type: 'text', text: t });
const done = (info) => ({ time: { completed: Date.now() }, ...info });

function project() {
  const fx = makeProject();
  fx.write('.work/oc_session_mod1.txt', 'ses_terminal');
  fx.md = path.join(fx.config.root, '.work', 'oc', 'mod1.md');
  fx.writeFor = (messages) => writeApiDelivery(fx.config, 'opencode', 'mod1', { fetchImpl: reply(messages) });
  return fx;
}

const isTransient = (error) => TRANSIENT_DELIVERY_CODES.has(error.code);

describe('writeApiDelivery terminal truth', () => {
  it('delivers only on an explicit stop, or the absent-finish compatibility case', async () => {
    const stop = project();
    const out = await stop.writeFor([assistant(done({ finish: 'stop' }), [text('Final report')])]);
    assert.equal(fs.readFileSync(out, 'utf8'), 'Final report\n');

    const compat = project();
    const out2 = await compat.writeFor([assistant(done(), [text('Older build, no finish field')])]);
    assert.equal(fs.readFileSync(out2, 'utf8'), 'Older build, no finish field\n');
  });

  it('writes no report for any other finish value, and names the value in the error (N12)', async () => {
    for (const finish of ['content-filter', 'error', 'other', 'unknown', 'end_turn']) {
      const fx = project();
      const error = await fx.writeFor([assistant(done({ finish }), [text('Text that never counts')])]).then(() => null, (e) => e);
      assert.ok(error, `"${finish}" must not deliver`);
      assert.equal(isTransient(error), false, 'a filtered or errored ending is terminal, retrying changes nothing');
      assert.match(error.message, new RegExp(`finish "${finish}"`), 'the finish value itself is the reason');
      assert.match(error.message, /Text that never counts/, 'the partial text survives as evidence');
      assert.equal(fs.existsSync(fx.md), false, 'no .md on failure');
    }
  });

  it('reads an explicit info.error before completion and before finish (N13)', async () => {
    // (a) An aborted session that never got a time.completed used to read as "still running" forever.
    const fx = project();
    const error = await fx.writeFor([assistant({ time: {}, error: { name: 'MessageAbortedError' } }, [text('cut short')])]).then(() => null, (e) => e);
    assert.ok(!isTransient(error), 'an error without a completed timestamp is terminal, not a retry forever');
    assert.match(error.message, /MessageAbortedError/);
    assert.match(error.message, /cut short/, 'partial failure details survive');
    assert.equal(fs.existsSync(fx.md), false);

    // (b) An error on a turn whose stale finish still says tool-calls must not hide behind it.
    const fx2 = project();
    const error2 = await fx2.writeFor([assistant(done({ finish: 'tool-calls', error: { name: 'APIError', data: { message: 'upstream rejected' } } }), [])]).then(() => null, (e) => e);
    assert.ok(!isTransient(error2), 'info.error outranks a tool-calls finish that will never resume');
    assert.match(error2.message, /upstream rejected/);
    assert.equal(fs.existsSync(fx2.md), false);
  });

  it('never infers a quota or an end from an arbitrary tool transcript', async () => {
    // Quota wording inside a tool's state, with no structured info.error, is not terminal evidence —
    // the same rule the collector enforces; an incomplete turn stays transient here, not failed.
    const fx = project();
    const error = await fx.writeFor([assistant({ time: {} }, [
      { type: 'tool', tool: 'bash', state: { status: 'error', error: 'insufficient_balance' } },
    ])]).then(() => null, (e) => e);
    assert.ok(isTransient(error), 'a live-looking turn with tool errors stays retryable');
    assert.match(error.message, /still running/);
    assert.equal(fs.existsSync(fx.md), false);
  });

  it('treats stale, undated or ambiguous turns as transient reads, matching the collector\'s stall', async () => {
    // A quiet text-only turn the collector calls stalled (N14): the writer must not contradict it with
    // a terminal failure or a delivery — the turn simply has no finished final report yet.
    const old = Date.now() - STALE_MS - 1000;
    const fx = project();
    const error = await fx.writeFor([assistant({ time: { created: old } }, [text('I will now write the report...')])]).then(() => null, (e) => e);
    assert.ok(isTransient(error), 'stalled is still "not yet", never a delivery');
    assert.equal(fs.existsSync(fx.md), false);

    // A completed, textless, finishless turn stays the P1 ambiguity: transient, not terminal.
    const fx2 = project();
    const error2 = await fx2.writeFor([assistant(done(), [])]).then(() => null, (e) => e);
    assert.ok(isTransient(error2) && /finish field/.test(error2.message));
  });

  it('prefers a recent completion over an older creation, and delivers final-assistant-only text', async () => {
    const created = Date.now() - 3 * 60 * 60 * 1000;
    const fx = project();
    const out = await fx.writeFor([
      assistant({ time: { created, completed: 1 }, finish: 'tool-calls' }, [text('earlier progress chatter')]),
      assistant({ time: { created, completed: Date.now() }, finish: 'stop' }, [text('Real final report')]),
    ]);
    assert.equal(fs.readFileSync(out, 'utf8'), 'Real final report\n', 'only the last assistant turn is ever written');
    assert.equal(fs.readFileSync(out, 'utf8').includes('earlier'), false, 'no fallback to an earlier progress assistant');
  });

  it('keeps the collector and the writer in one mind on the same messages', async () => {
    // The aligned contract: whatever the collector calls delivered, the writer must be able to write;
    // whatever it calls running or stalled (uncertain), the writer must refuse transiently; whatever it
    // calls failed or bounced (terminal), the writer must refuse terminally. A divergence here is how
    // quests end up marked delivered with no file, or failed while their worker still runs.
    const old = Date.now() - STALE_MS - 1000;
    const cases = [
      ['stop with text', assistant(done({ finish: 'stop' }), [text('report')])],
      ['absent finish with text', assistant(done(), [text('report')])],
      ['content-filter with text', assistant(done({ finish: 'content-filter' }), [text('report')])],
      ['error with tool-calls finish', assistant(done({ finish: 'tool-calls', error: { name: 'APIError' } }), [])],
      ['error without completion', assistant({ time: {}, error: { name: 'MessageAbortedError' } }, [])],
      ['unfinished turn', assistant({ time: { created: old } }, [text('working...')])],
      ['ambiguous tool-only step', assistant(done(), [{ type: 'tool', tool: 'edit' }])],
      ['length cutoff', assistant(done({ finish: 'length' }), [text('half a report')])],
      ['stop without text', assistant(done({ finish: 'stop' }), [])],
      ['quota error', assistant({ time: {}, error: { name: 'UnknownError', data: { message: 'usage limit exceeded' } } }, [])],
    ];
    for (const [label, message] of cases) {
      const fx = project();
      const collector = sessionState([message], Date.now());
      const error = await fx.writeFor([message]).then(() => null, (e) => e);
      if (collector.state === 'delivered') {
        assert.equal(error, null, `${label}: collector delivered but writer failed: ${error && error.message}`);
      } else if (collector.state === 'running' || collector.state === 'stalled') {
        assert.ok(error && isTransient(error), `${label}: collector saw ${collector.state} but the writer refused terminally`);
        assert.equal(fs.existsSync(fx.md), false, `${label}: no report for unfinished work`);
      } else {
        assert.ok(error && !isTransient(error), `${label}: collector saw ${collector.state} but the writer only hesitated`);
        assert.equal(fs.existsSync(fx.md), false, `${label}: no report for a failed turn`);
      }
    }
  });

  it('recovers over a real local server: a refused read retries, the finished turn then delivers', async () => {
    // A genuine node:http fixture on 127.0.0.1 — transient HTTP (a refused connection / a 500) must not
    // consume the attempt; once the turn really completes with stop + text, the next poll delivers.
    const fx = project();
    const messages = [assistant(done({ finish: 'stop' }), [text('Recovered report')])];
    let mode = 'fail';
    const server = http.createServer((req, res) => {
      if (mode === 'fail') { res.writeHead(500); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(messages));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${server.address().port}`;
    const config = { ...fx.config, lanes: { ...fx.config.lanes, opencode: { ...fx.config.lanes.opencode, api } } };
    try {
      const error = await writeApiDelivery(config, 'opencode', 'mod1').then(() => null, (e) => e);
      assert.ok(error && isTransient(error), 'an HTTP 500 is a failed read, not a failed delivery');
      assert.equal(fs.existsSync(fx.md), false);
      mode = 'ok';
      const out = await writeApiDelivery(config, 'opencode', 'mod1');
      assert.equal(fs.readFileSync(out, 'utf8'), 'Recovered report\n', 'a later good read is not poisoned by the earlier failure');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
