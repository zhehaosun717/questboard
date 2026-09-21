// FB2-12 items 33/34: the coordinator may only dispatch the machine-check fast track — a card the owner
// marked coordinatorAssignable (free cards only), a quest some machine check produced, and a file set of at
// most --max-files (3) files. Everything else is refused with the reason, and the owner's own dispatch is
// never limited. Enforced on the real route, so the CLI and the MCP tool inherit it unchanged.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixture.js';
import { saveRoster } from '../../src/core/roster.js';
import { CARDS } from '../helpers.js';

let fx;

before(async () => {
  fx = await startFixture();
  saveRoster(fx.home.roster, {
    adventurers: CARDS.map(({ status, ...card }) => card)
      .map((card) => (card.id === 'oc-mimo' || card.id === 'oc-deepseek' ? { ...card, billing: 'free', coordinatorAssignable: true } : card)),
  });
  fx.project.write('docs/briefs/FIX-45-x.md', '# FIX-45\n\n## Files you may edit\n\n- `src/owner-only.js`\n');
  fx.project.write('docs/briefs/RUN-4-the-way-back.md', 'RUN-4');
});
after(() => fx.close());

const post = (body) => fx.api('/api/quests', 'POST', { by: 'coordinator', ...body });
const assign = (id, body = {}) => fx.api(`/api/quests/${id}/assign`, 'POST', { adventurer: 'oc-mimo', ...body });

describe('coordinator identity assign — the machine-check fast track (FB2-12 item 3)', () => {
  it('refuses a plain quest the coordinator posted, and says what a fast-track quest needs', async () => {
    assert.equal((await post({ package: 'FIX-45', brief: 'docs/briefs/FIX-45-x.md' })).status, 201);
    const refused = await assign('FIX-45', { by: 'coordinator' });
    assert.equal(refused.status, 409, refused.text);
    const reason = refused.body.reasons[0];
    assert.equal(reason.code, 'coordinator_origin');
    assert.match(reason.message, /machine-check/);
    assert.match(reason.message, /--origin/);
    assert.equal(fx.server.store.get('FIX-45').status, 'posted', 'nothing was dispatched');
  });

  it('lets the owner dispatch that same quest (owner is not limited)', async () => {
    const ok = await assign('FIX-45', { by: 'owner' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(fx.server.store.get('FIX-45').status, 'dispatched');
    assert.equal(fx.server.store.get('FIX-45').assignee.by, 'owner');
  });

  it('refuses a card the owner never marked coordinatorAssignable', async () => {
    assert.equal((await post({ package: 'FIX-46', brief: 'docs/briefs/FIX-45-x.md', origin: 'machine-check', check: 'unity recompile', files: 'src/card-check.js' })).status, 201);
    const refused = await assign('FIX-46', { by: 'coordinator', adventurer: 'dsh-deepseek' });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.reasons[0].code, 'coordinator_card');
    assert.match(refused.body.reasons[0].message, /coordinatorAssignable/);
  });

  it('refuses a fast-track quest that touches more files than the limit', async () => {
    assert.equal((await post({ package: 'FIX-47', brief: 'docs/briefs/FIX-45-x.md', origin: 'machine-check', check: 'unity recompile', files: 'src/wide-a.js,src/wide-b.js,src/wide-c.js,src/wide-d.js' })).status, 201);
    const refused = await assign('FIX-47', { by: 'coordinator' });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.reasons[0].code, 'coordinator_files');
    assert.match(refused.body.reasons[0].message, /4/);
  });

  it('dispatches a small machine-check fix on a marked card, and records the coordinator as the actor', async () => {
    assert.equal((await post({ package: 'FIX-48', brief: 'docs/briefs/FIX-45-x.md', origin: 'machine-check', check: 'unity recompile', files: 'src/fix48-a.js,src/fix48-b.js' })).status, 201);
    const ok = await assign('FIX-48', { by: 'coordinator' });
    assert.equal(ok.status, 200, ok.text);
    const quest = fx.server.store.get('FIX-48');
    assert.equal(quest.status, 'dispatched');
    assert.equal(quest.assignee.by, 'coordinator');
    assert.equal(quest.origin, 'machine-check');
  });

  it('--max-files raises the limit for a caller that asked for it', async () => {
    assert.equal((await post({ package: 'FIX-49', brief: 'docs/briefs/FIX-45-x.md', origin: 'post-delivery-check', check: 'npm test', files: 'src/fix49-a.js,src/fix49-b.js,src/fix49-c.js,src/fix49-d.js' })).status, 201);
    const refused = await assign('FIX-49', { by: 'coordinator', adventurer: 'oc-deepseek', maxFiles: 2 });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.reasons[0].code, 'coordinator_files');
    const ok = await assign('FIX-49', { by: 'coordinator', adventurer: 'oc-deepseek', maxFiles: 4 });
    assert.equal(ok.status, 200, ok.text);
  });

  it('a nonsense --max-files is refused as a bad request, not silently ignored', async () => {
    assert.equal((await post({ package: 'FIX-50', brief: 'docs/briefs/FIX-45-x.md', origin: 'machine-check', check: 'x', files: 'src/fix50.js' })).status, 201);
    const bad = await assign('FIX-50', { by: 'coordinator', adventurer: 'oc-deepseek', maxFiles: 'lots' });
    assert.equal(bad.status, 400, bad.text);
    assert.match(bad.body.error, /maxFiles/);
  });
});
