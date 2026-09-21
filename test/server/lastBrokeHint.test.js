// FB2-07 item 4: a card that broke and recovered keeps the memory — the snapshot carries lastBroke and
// the drag preview warns 上次 broke instead of pretending nothing happened.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendJsonLine } from '../../src/core/jsonl.js';
import { startFixture } from './fixture.js';

let fx;
before(async () => {
  fx = await startFixture();
  appendJsonLine(fx.home.status, { at: '2026-09-18T02:00:00.000Z', adventurerId: 'codex-luna', status: 'broke', reason: 'HTTP 410 model decommissioned', setBy: 'board' });
  appendJsonLine(fx.home.status, { at: '2026-09-19T09:00:00.000Z', adventurerId: 'codex-luna', status: 'available', reason: '换回了可用的模型', setBy: 'owner' });
  fx.project.write('docs/briefs/LB-1-x.md', '# LB-1');
  const posted = await fx.api('/api/quests', 'POST', { package: 'LB-1', brief: 'docs/briefs/LB-1-x.md' });
  assert.equal(posted.status, 201);
});
after(() => fx.close());

describe('lastBroke wiring (FB2-07 item 4)', () => {
  it('snapshot roster carries lastBroke and eligibility warns with it', async () => {
    const snap = (await fx.api('/api/quests')).body;
    const card = snap.roster.find((entry) => entry.id === 'codex-luna');
    assert.equal(card.status, 'available', 'currently recovered');
    assert.deepEqual(card.lastBroke, { reason: 'HTTP 410 model decommissioned', at: '2026-09-18T02:00:00.000Z' });
    const verdict = snap.eligibility['LB-1']?.['codex-luna'];
    assert.ok(verdict, 'eligibility row exists');
    const warning = (verdict.warnings || []).find((w) => w.code === 'last_broke');
    assert.ok(warning, 'drag preview warns');
    assert.match(warning.message, /上次 broke/);
    assert.match(warning.message, /HTTP 410 model decommissioned/);
  });

  it('a card whose latest record is still broke stays a refusal, not a hint', async () => {
    appendJsonLine(fx.home.status, { at: '2026-09-20T01:00:00.000Z', adventurerId: 'agy-gemini', status: 'broke', reason: 'model retired', setBy: 'board' });
    const snap = (await fx.api('/api/quests')).body;
    const verdict = snap.eligibility['LB-1']?.['agy-gemini'];
    assert.ok(verdict.reasons.some((r) => r.code === 'adventurer_broke'), 'still refused');
    assert.ok(!(verdict.warnings || []).some((w) => w.code === 'last_broke'), 'no redundant hint on top of the refusal');
  });
});
