import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sessionState } from '../../src/lanes/opencode.js';

const assistant = (info, parts = []) => ({ info: { role: 'assistant', ...info }, parts });

describe('sessionState', () => {
  it('never bounces from text inside a tool error, only from a structured message error', () => {
    // Repro of N2: a bash tool's own error output happens to quote quota wording. The message itself is
    // still running (no time.completed), so this is not terminal evidence of anything.
    const messages = [assistant({ time: {} }, [
      { type: 'tool', tool: 'bash', state: { status: 'error', error: 'you\'ve hit your usage limit while grepping vendor.log' } },
    ])];
    assert.equal(sessionState(messages).state, 'running', 'tool output text is never bounce evidence, live or not');

    // A completed turn with only a tool part and no `finish` field is the same ambiguity P1 closes: it
    // looks exactly like a tool-only step mid-session, so it is "running" (uncertain), never "bounced" from
    // its tool's own text and never "delivered" from a guess either.
    const completedMessages = [assistant({ time: { completed: Date.now() } }, [
      { type: 'tool', tool: 'bash', state: { status: 'error', error: 'insufficient_balance in a file it just read' } },
    ])];
    assert.equal(sessionState(completedMessages).state, 'running', 'a completed turn is not re-classified as bounced from tool state text, and an ambiguous tool-only step is not delivered either');
  });

  it('bounces only from a structured info.error on the message', () => {
    const messages = [assistant({ error: { name: 'UnknownError', data: { message: 'usage limit exceeded' } } }, [])];
    assert.equal(sessionState(messages).state, 'bounced');
  });

  it('does not call a completed tool-only turn delivered when finish says the session will continue', () => {
    // Same finality gap as B1: finish "tool-calls" means the model only stopped to run tools, and another
    // assistant turn follows once the tool result lands.
    const messages = [assistant({ time: { completed: Date.now() }, finish: 'tool-calls' }, [
      { type: 'tool', tool: 'edit' },
    ])];
    assert.equal(sessionState(messages).state, 'running', 'a tool-calls finish is mid-session, not a delivery');
  });

  it('still calls a genuinely completed turn delivered', () => {
    const messages = [assistant({ time: { completed: Date.now() }, finish: 'stop' }, [{ type: 'text', text: 'done' }])];
    assert.equal(sessionState(messages).state, 'delivered');
    // No finish field at all (older sessions, or a provider that never sets it) still counts as done —
    // the check only ever narrows finality, it never requires the field to be present.
    const noFinish = [assistant({ time: { completed: Date.now() } }, [{ type: 'text', text: 'done' }])];
    assert.equal(sessionState(noFinish).state, 'delivered');
  });

  it('treats a completed tool-only step with no finish field as uncertain, not a terminal fact either way (P1/N2-a)', () => {
    // Neither "delivered" (it might still be mid-session) nor "failed"/"bounced" (it has done nothing wrong
    // yet) — a false terminal call here would free the quest's slot while the worker may still be running.
    const messages = [assistant({ time: { completed: Date.now() } }, [{ type: 'tool', tool: 'edit' }])];
    const result = sessionState(messages);
    assert.equal(result.state, 'running');
    assert.equal(result.lastText, '');
  });

  it('stalls a completed tool-calls turn using its own completed timestamp, not a nonexistent info.time.updated field (N9)', () => {
    // AssistantMessage only ever carries {created, completed?} — there is no `updated`. Before the fix this
    // read `info.time.updated` (always undefined) and so never staled out no matter how old the turn was.
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const messages = [assistant({ time: { completed: threeHoursAgo }, finish: 'tool-calls' }, [{ type: 'tool', tool: 'bash' }])];
    const result = sessionState(messages, Date.now());
    assert.equal(result.state, 'stalled');
    assert.equal(result.lastActivityMs, threeHoursAgo);
  });

  it('does not call a length-truncated or aborted turn delivered, and keeps the partial text as evidence (N10)', () => {
    // Both are real terminal facts from the adapter (finish/info.error), never a guess from text — but
    // neither is a clean final report, so neither may masquerade as "delivered".
    const truncated = [assistant({ time: { completed: Date.now() }, finish: 'length' }, [{ type: 'text', text: 'Here is the first half of' }])];
    const truncatedResult = sessionState(truncated);
    assert.equal(truncatedResult.state, 'failed');
    assert.match(truncatedResult.reason, /length/);
    assert.equal(truncatedResult.lastText, 'Here is the first half of');

    const aborted = [assistant({ time: { completed: Date.now() }, error: { name: 'MessageAbortedError' } }, [{ type: 'text', text: 'Partial notes before the abort' }])];
    const abortedResult = sessionState(aborted);
    assert.equal(abortedResult.state, 'failed');
    assert.match(abortedResult.reason, /MessageAbortedError/);
    assert.equal(abortedResult.lastText, 'Partial notes before the abort');
  });
});
