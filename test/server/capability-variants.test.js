import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture, tick } from './fixture.js';

describe('variant capability eligibility and dispatch', () => {
  it('uses the same refusal before assign and at assign, carries unknown warnings in eligibility and dispatched detail', async () => {
    const fx = await startFixture();
    try {
      const unsupportedCard = {
        id: 'codex-luna', name: 'Luna', provider: 'OpenAI Codex', lane: 'codex', model: 'gpt-5.6-luna',
        family: 'gpt-5.6-luna', variant: 'high', variants: [], maxParallel: 1, strengths: ['code', 'review'],
      };
      assert.equal((await fx.api('/api/roster', 'POST', { adventurer: unsupportedCard })).status, 200);
      await fx.api('/api/quests', 'POST', { package: 'VAR-1', brief: 'docs/briefs/RUN-4-the-way-back.md' });
      const snapshot = (await fx.api('/api/quests')).body;
      const preDrop = snapshot.eligibility['VAR-1']['codex-luna'];
      assert.equal(preDrop.ok, false);
      assert.equal(preDrop.reasons.find((reason) => reason.code === 'variant_unsupported').message, '这张卡的模型不接受 variant「high」，请在名册里清空 variant 或改用支持它的卡');
      const assigned = await fx.api('/api/quests/VAR-1/assign', 'POST', { adventurer: 'codex-luna' });
      assert.equal(assigned.status, 409);
      assert.deepEqual(assigned.body.reasons, preDrop.reasons);
      assert.equal(fx.events().some((event) => event.event === 'assigned'), false);

      const unknownCard = { ...unsupportedCard, variants: undefined };
      assert.equal((await fx.api('/api/roster', 'POST', { adventurer: unknownCard })).status, 200);
      await fx.api('/api/quests', 'POST', { package: 'VAR-2', brief: 'docs/briefs/RUN-4-the-way-back.md' });
      const unknownSnapshot = (await fx.api('/api/quests')).body;
      const verdict = unknownSnapshot.eligibility['VAR-2']['codex-luna'];
      assert.equal(verdict.ok, true);
      assert.deepEqual(verdict.warnings, [{ code: 'variant_unconfirmed', message: '尚未确认这张卡支持 variant「high」，派遣会照常进行' }]);
      assert.equal((await fx.api('/api/quests/VAR-2/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
      await tick();
      const dispatched = fx.events().find((event) => event.event === 'dispatched' && event.package === 'VAR-2');
      assert.ok(dispatched);
      assert.match(dispatched.detail, /variant_unconfirmed/);
      assert.match(dispatched.detail, /尚未确认这张卡支持 variant「high」，派遣会照常进行/);
    } finally {
      await fx.close();
    }
  });
});
