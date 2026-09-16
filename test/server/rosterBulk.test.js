import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFixture } from './fixture.js';
import { loadRoster, saveRoster } from '../../src/core/roster.js';
import { rosterFingerprint } from '../../src/core/rosterBulk.js';

let fx;
const baseCards = {
  adventurers: [
    { id: 'bulk-one', name: 'Bulk One', provider: 'synthetic', lane: 'codex', model: 'model-one', family: 'family', variant: 'high', env: { BASE_URL: 'https://old.test', KEEP: 'yes' } },
    { id: 'bulk-two', name: 'Bulk Two', provider: 'synthetic', lane: 'codex', model: 'model-two', family: 'family' },
  ],
};

beforeEach(async () => {
  fx = await startFixture();
  saveRoster(fx.home.roster, baseCards);
});

afterEach(async () => fx.close());

describe('roster bulk routes', () => {
  it('previews through the quest route delegation and exposes only safe field summaries', async () => {
    const response = await fx.api('/api/roster/bulk/preview', 'POST', {
      ids: ['bulk-one', 'bulk-two'],
      patch: { status: 'paused', reason: 'batch pause', variant: '', env: { set: { BASE_URL: 'https://new.test' }, remove: ['KEEP'] } },
    });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.ids, ['bulk-one', 'bulk-two']);
    assert.equal(response.body.action, 'update');
    assert.ok(response.body.changedFields.includes('status'));
    assert.ok(response.body.changedFields.includes('variant'));
    assert.ok(response.body.changedFields.includes('env'));
    assert.ok(response.body.preservedFields.includes('name'));
    assert.ok(!response.text.includes('https://new.test'));
  });

  it('denies available when the real overlay still marks a card limited and keeps laneLimits aligned', async () => {
    const now = Date.now();
    const at = new Date(now - 60_000).toISOString();
    const entry = {
      adventurerId: 'bulk-one',
      at,
      since: at,
      until: null,
      resetsAt: new Date(now + 3 * 60 * 60_000).toISOString(),
      name: 'Bulk One',
    };
    fx.holder.lanes = { packages: [], laneLimits: { codex: { ...entry, cards: { 'bulk-one': entry } } } };
    const request = { ids: ['bulk-one'], patch: { status: 'available' } };
    const preview = await fx.api('/api/roster/bulk/preview', 'POST', request);
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.body.counts.denied, 1);
    assert.equal(preview.body.results[0].ready, false);
    assert.match(preview.body.deniedActiveCards[0].reasons[0].message, /\u786e\u8ba4\u989d\u5ea6\u5df2\u6062\u590d/);

    const applied = await fx.api('/api/roster/bulk/apply', 'POST', request);
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.body.counts.denied, 1);
    const snapshot = await fx.api('/api/quests');
    const card = snapshot.body.roster.find((item) => item.id === 'bulk-one');
    assert.equal(card.status, 'limited');
    assert.ok(snapshot.body.laneLimits.codex.cards['bulk-one']);
  });

  it('denies available for manually limited and paused cards through the real overlay', async () => {
    const now = Date.now();
    const evidenceAt = new Date(now - 60_000).toISOString();
    const statusAt = new Date(now - 120_000).toISOString();
    fx.server.statusLog.set('bulk-one', { at: statusAt, status: 'limited', reason: 'manual limit', setBy: 'owner' });
    fx.server.statusLog.set('bulk-two', { at: statusAt, status: 'paused', reason: 'manual pause', setBy: 'owner' });
    const entry = (adventurerId) => ({
      adventurerId,
      at: evidenceAt,
      since: evidenceAt,
      until: null,
      resetsAt: new Date(now + 3 * 60 * 60_000).toISOString(),
      name: adventurerId,
    });
    fx.holder.lanes = { packages: [], laneLimits: { codex: { cards: { 'bulk-one': entry('bulk-one'), 'bulk-two': entry('bulk-two') } } } };
    const request = { ids: ['bulk-one', 'bulk-two'], patch: { status: 'available' } };
    const beforeRecords = fx.server.statusLog.records();
    const preview = await fx.api('/api/roster/bulk/preview', 'POST', request);
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual(preview.body.results.map((result) => result.denied), [true, true]);
    assert.equal(preview.body.counts.denied, 2);
    assert.ok(preview.body.results.every((result) => /确认额度已恢复/.test(result.reasons[0].message)));

    const applied = await fx.api('/api/roster/bulk/apply', 'POST', request);
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.body.counts.denied, 2);
    assert.equal(applied.body.counts.changed, 0);
    assert.deepEqual(fx.server.statusLog.records(), beforeRecords);
    const snapshot = await fx.api('/api/quests');
    assert.deepEqual(snapshot.body.roster.map((card) => card.status), ['limited', 'paused']);
    assert.ok(fx.holder.lanes.laneLimits.codex.cards['bulk-one']);
    assert.ok(fx.holder.lanes.laneLimits.codex.cards['bulk-two']);
    assert.ok(snapshot.body.laneLimits.codex.cards['bulk-one']);
    assert.ok(snapshot.body.laneEvidence.codex.cards['bulk-two']);
  });

  it('applies facts and status separately, records actor/time in status log, and keeps roster data status-free', async () => {
    const roster = loadRoster(fx.home.roster);
    const fingerprint = rosterFingerprint(roster, []);
    const response = await fx.api('/api/roster/bulk/apply', 'POST', {
      ids: ['bulk-one'],
      fingerprint,
      actor: 'owner',
      patch: { status: 'paused', reason: 'manual batch', variant: '', env: { set: { BASE_URL: 'https://new.test' }, remove: ['KEEP'] } },
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.counts.changed, 1);
    const saved = loadRoster(fx.home.roster).adventurers.find((card) => card.id === 'bulk-one');
    assert.deepEqual(saved.env, { BASE_URL: 'https://new.test' });
    assert.equal('variant' in saved, false);
    assert.equal('status' in saved, false);
    const status = fs.readFileSync(fx.home.status, 'utf8');
    assert.match(status, /"adventurerId":"bulk-one"/);
    assert.match(status, /"status":"paused"/);
    assert.match(status, /"setBy":"owner"/);
    assert.ok(!status.includes('https://new.test'));
  });

  it('refuses cross-site writes, stale fingerprints, and active cards before touching the roster', async () => {
    const before = fs.readFileSync(fx.home.roster, 'utf8');
    const refused = await fx.api('/api/roster/bulk/apply', 'POST', { ids: ['bulk-one'], patch: { variant: 'new' } }, { origin: 'http://evil.example' });
    assert.equal(refused.status, 403);
    assert.equal(fs.readFileSync(fx.home.roster, 'utf8'), before);

    const fingerprint = rosterFingerprint(loadRoster(fx.home.roster), []);
    saveRoster(fx.home.roster, { adventurers: [...baseCards.adventurers, { id: 'bulk-new', name: 'New', provider: 'synthetic', lane: 'codex', model: 'm', family: 'f' }] });
    const stale = await fx.api('/api/roster/bulk/apply', 'POST', { ids: ['bulk-one'], fingerprint, patch: { variant: 'new' } });
    assert.equal(stale.status, 409);
    assert.equal(loadRoster(fx.home.roster).adventurers.find((card) => card.id === 'bulk-one').variant, 'high');

    saveRoster(fx.home.roster, baseCards);
    fx.project.write('docs/briefs/BULK-1-active.md', 'active');
    const posted = fx.server.store.post({ package: 'BULK-1', brief: 'docs/briefs/BULK-1-active.md', title: 'active' });
    assert.ok(!posted.errors);
    fx.server.store.assign('BULK-1', { adventurer: baseCards.adventurers[0], name: 'bulk-run' });
    const active = await fx.api('/api/roster/bulk/apply', 'POST', { ids: ['bulk-one'], patch: { variant: 'new' } });
    assert.equal(active.status, 200);
    assert.equal(active.body.counts.denied, 1);
    assert.match(active.body.results[0].reasons[0].message, /BULK-1/);
    assert.equal(loadRoster(fx.home.roster).adventurers.find((card) => card.id === 'bulk-one').variant, 'high');
  });

  it('requires the complete shape and the delete endpoint never uses a hidden filter', async () => {
    const invalid = await fx.api('/api/roster/bulk/preview', 'POST', { ids: Array.from({ length: 101 }, (_, i) => `bulk-${i}`), patch: { variant: 'x' } });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /at most 100/);
    const deleted = await fx.api('/api/roster/bulk/apply', 'POST', { ids: ['bulk-two'], action: 'delete' });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.counts.changed, 1);
    assert.equal(loadRoster(fx.home.roster).adventurers.some((card) => card.id === 'bulk-two'), false);
  });
});
