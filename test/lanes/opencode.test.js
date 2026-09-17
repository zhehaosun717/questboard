// The OpenCode collector decides a session-API worker's state from its message list alone: no files, no
// exit codes, just the session's own parts. The A3 review caught it treating any non-"tool-calls" finish
// as success (N12), letting an explicit info.error hide behind a missing completion or a stale
// tool-calls finish (N13), and never ageing out turns with no tool parts (N14). These pin the corrected
// rules: only "stop" (or the absent-finish compatibility case with real text) is a delivery; the
// structured error is the newest fact whatever the other fields claim; quiet turns stall on their real
// timestamps; and a turn without any timestamp stays uncertain with a reason instead of being guessed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchJson, sessionState } from '../../src/lanes/opencode.js';
import { STALE_MS } from '../../src/lanes/workers.js';

const now = () => Date.now();
const ago = (ms) => now() - ms;
const threeHours = 3 * 60 * 60 * 1000;
const msg = (info, parts = []) => ({ info: { role: 'assistant', ...info }, parts });
const txt = (text) => ({ type: 'text', text });
const completed = (info) => ({ time: { completed: now() }, ...info });

describe('sessionState terminal rules (N12-N14)', () => {
  it('delivers on an explicit stop and on the absent-finish compatibility case only', () => {
    assert.equal(sessionState([msg(completed({ finish: 'stop' }), [txt('final')])]).state, 'delivered');
    assert.equal(sessionState([msg(completed(), [txt('final')])]).state, 'delivered', 'the one tolerated compatibility delivery');
  });

  it('fails every other finish value, naming it, even with text present (N12)', () => {
    for (const finish of ['content-filter', 'error', 'other', 'unknown', 'end_turn']) {
      const state = sessionState([msg(completed({ finish }), [txt('reads like a report')])]);
      assert.equal(state.state, 'failed', `"${finish}" is not success`);
      assert.match(state.reason, new RegExp(`finish "${finish}"`), 'the value itself is the reason, not a reworded guess');
      assert.equal(state.lastText, 'reads like a report', 'the text stays as evidence');
    }
  });

  it('fails an ambiguous no-finish turn that goes stale on an unsupported finish before any stall (N12 + N14)', () => {
    const state = sessionState([msg({ time: { created: ago(threeHours), completed: ago(threeHours) }, finish: 'content-filter' }, [txt('half of an answer')])], now());
    assert.equal(state.state, 'failed', 'a completed filtered turn is terminal — age cannot rescue it into stalled');
    assert.match(state.reason, /content-filter/);
  });

  it('ends a session on an explicit info.error that an older field would have masked (N13)', () => {
    const noCompletion = sessionState([msg({ time: {}, error: { name: 'MessageAbortedError' } }, [txt('partial')])]);
    assert.equal(noCompletion.state, 'failed', 'an abort with no time.completed is still terminal');
    assert.match(noCompletion.reason, /MessageAbortedError/);
    assert.equal(noCompletion.lastText, 'partial');

    const staleFinish = sessionState([msg(completed({ finish: 'tool-calls', error: { name: 'APIError', data: { message: 'upstream rejected' } } }), [txt('mid')])]);
    assert.equal(staleFinish.state, 'failed', 'the error is the newest fact, not the stale finish');
    assert.match(staleFinish.reason, /upstream rejected/);

    const quota = sessionState([msg({ time: {}, error: { name: 'RateLimitError', code: 'rate_limit_exceeded', data: { message: "you've hit your usage limit, try again at 17:00" } } }, [txt('mid')])]);
    assert.equal(quota.state, 'bounced', 'bounce evidence still outranks completion');
  });

  it('requires a structured quota name or code and never regexes a free-text 402', () => {
    const textOnly = sessionState([msg({ time: {}, error: { name: 'APIError', data: { message: "you've hit your usage limit" } } }, [txt('mid')])]);
    assert.equal(textOnly.state, 'failed');
    const structuredNonQuota = sessionState([msg({ time: {}, error: { name: 'APIError', data: { message: 'tool failed: exit 402' } } }, [txt('mid')])]);
    assert.equal(structuredNonQuota.state, 'failed');
    const byCode = sessionState([msg({ time: {}, error: { name: 'APIError', code: 'quota_exceeded', data: { message: 'provider rejected the request' } } }, [txt('mid')])]);
    assert.equal(byCode.state, 'bounced');
  });

  it('bounces on a plain structured HTTP 402, not just a named quota error (A3)', () => {
    const byStatus = sessionState([msg({ time: {}, error: { name: 'HTTPError', status: 402, data: { message: 'payment required' } } }, [txt('mid')])]);
    assert.equal(byStatus.state, 'bounced', 'a real error.status field of 402 is quota evidence even with no quota-named code');
    const byDataStatusCode = sessionState([msg({ time: {}, error: { name: 'APIError', data: { statusCode: 402, message: 'payment required' } } }, [txt('mid')])]);
    assert.equal(byDataStatusCode.state, 'bounced', 'a real data.statusCode field of 402 counts the same way');
    // Never regexed from free text: "402" appearing only inside the message stays an ordinary failure.
    const textOnly402 = sessionState([msg({ time: {}, error: { name: 'APIError', data: { message: 'server replied 402 payment required' } } }, [txt('mid')])]);
    assert.equal(textOnly402.state, 'failed', 'a 402 mentioned only in message text is still never evidence');
  });

  it('does not infer a quota from an arbitrary tool transcript', () => {
    const state = sessionState([msg({ time: {} }, [{ type: 'tool', tool: 'bash', state: { status: 'error', error: "insufficient_balance quoted in passing" } }])]);
    assert.equal(state.state, 'running', 'only the structured message error is evidence');
  });

  it('stalls a quiet turn on its real timestamps even with no tool parts (N14)', () => {
    const created = ago(threeHours);
    const textOnly = sessionState([msg({ time: { created } }, [txt('I will now write...')])], now());
    assert.equal(textOnly.state, 'stalled', 'a text-only turn with no completion still ages out');
    assert.equal(textOnly.lastActivityMs, created, 'created is the only real timestamp there is');

    const completedAt = ago(threeHours);
    const reasoningOnly = sessionState([msg({ time: { created: ago(4 * 60 * 60 * 1000), completed: completedAt } }, [{ type: 'reasoning', text: 'hmm' }])], now());
    assert.equal(reasoningOnly.state, 'stalled', 'the ambiguous completed-no-finish-no-text turn ages out on completion');
    assert.equal(reasoningOnly.lastActivityMs, completedAt, 'completed outranks an older created');

    assert.equal(sessionState([msg({ time: { created: now() } }, [txt('starting')])], now()).state, 'running');
    assert.equal(sessionState([msg(completed(), [{ type: 'reasoning', text: 'fresh' }])], now()).state, 'running', 'quiet needs the full stale window before it is a stall');
  });

  it('keeps a timestampless turn uncertain with a reason, never a guessed success (N14)', () => {
    const noStamps = sessionState([msg({ time: {} }, [txt('dateless')])], now() + STALE_MS * 2);
    assert.equal(noStamps.state, 'running');
    assert.match(noStamps.reason, /no created or completed timestamp/, 'the uncertainty is explained, not silent');
  });

  it('stays running while the session is mid-step or ambiguous', () => {
    assert.equal(sessionState([msg(completed({ finish: 'tool-calls' }), [txt('progress'), { type: 'tool', tool: 'bash' }])]).state, 'running');
    assert.equal(sessionState([msg(completed(), [{ type: 'tool', tool: 'edit' }])]).state, 'running', 'P1: a completed tool-only turn is not a delivery');
    assert.equal(sessionState([msg(completed({ finish: 'tool-calls' }), [{ type: 'tool', tool: 'bash' }])], now() + 3 * 60 * 60 * 1000).state, 'stalled');
  });

  it('does not fall back to an earlier assistant message', () => {
    const state = sessionState([
      msg({ time: { completed: ago(300 * 60 * 1000) }, finish: 'stop' }, [txt('an old report')]),
      msg({ time: {} }, [txt('now working on fixes')]),
    ], now());
    assert.equal(state.state, 'running', 'the incomplete latest turn decides');
    assert.equal(state.lastText, 'now working on fixes');
  });

  it('reports a clean terminal turn with no text as failed, not delivered', () => {
    const state = sessionState([msg(completed({ finish: 'stop' }), [])]);
    assert.equal(state.state, 'failed');
    assert.match(state.reason, /no final assistant text/);
  });

  it('keeps the established terminal facts: length cutoff and abort fail with partial text', () => {
    const truncated = sessionState([msg(completed({ finish: 'length' }), [txt('half a report')])]);
    assert.equal(truncated.state, 'failed');
    assert.match(truncated.reason, /length/);
    assert.equal(truncated.lastText, 'half a report');
    const aborted = sessionState([msg(completed({ error: { name: 'MessageAbortedError' } }), [txt('partial notes')])]);
    assert.equal(aborted.state, 'failed');
    assert.match(aborted.reason, /MessageAbortedError/);
  });

  it('names a Chinese reason instead of going silent (Bundle 3: connection, timeout, HTTP status, non-JSON)', async () => {
    const refused = await fetchJson('http://oc.test', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.deepEqual(refused, { ok: false, reason: '连接失败：ECONNREFUSED' });

    const timedOut = await fetchJson('http://oc.test', {
      timeout: 5,
      fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.reason, '请求超时');

    const badStatus = await fetchJson('http://oc.test', { fetchImpl: async () => ({ ok: false, status: 500 }) });
    assert.deepEqual(badStatus, { ok: false, reason: 'HTTP 500' });

    const badJson = await fetchJson('http://oc.test', { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } }) });
    assert.equal(badJson.ok, false);
    assert.match(badJson.reason, /响应不是合法 JSON/);

    const ok = await fetchJson('http://oc.test', { fetchImpl: async () => ({ ok: true, json: async () => ({ hello: 'world' }) }) });
    assert.deepEqual(ok, { ok: true, data: { hello: 'world' } });
  });

  it('respects stallAfterMinutes threshold: 21m running, 46m stalled >45m', () => {
    const quiet21 = sessionState([msg({ time: { created: ago(21 * 60 * 1000) } }, [txt('working')])], now(), { stallAfterMinutes: 45 });
    assert.equal(quiet21.state, 'running');

    const quiet46 = sessionState([msg({ time: { created: ago(46 * 60 * 1000) } }, [txt('working')])], now(), { stallAfterMinutes: 45 });
    assert.equal(quiet46.state, 'stalled');
    assert.equal(quiet46.reason, 'running, no activity >45m');
  });
});
