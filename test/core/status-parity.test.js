import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { appendJsonLine } from '../../src/core/jsonl.js';
import { effectiveRoster } from '../../src/core/overlay.js';
import { buildSnapshot } from '../../src/core/snapshot.js';
import { canDispatch } from '../../src/core/rules.js';
import { QuestStore } from '../../src/core/store.js';
import { createCollector } from '../../src/lanes/collector.js';
import { makeProject, quest } from '../helpers.js';

const card = { id: 'codex-luna', name: 'Luna', lane: 'codex', model: 'gpt-5.6-luna', status: 'available' };
const otherCard = { id: 'codex-astra', name: 'Astra', lane: 'codex', model: 'gpt-6-astra', status: 'available' };

describe('status parity backend contract', () => {
  it('recovers the exact card identity from the current quest row without reading card env', async () => {
    const { config, write } = makeProject();
    write('docs/briefs/RUN-1-x.md', 'RUN-1');
    const store = new QuestStore(config);
    store.post({ package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' });
    store.assign('RUN-1', { adventurer: card, name: 'run1' });
    appendJsonLine(config.paths.registry, { at: new Date().toISOString(), event: 'dispatch', package: 'RUN-1', lane: 'codex', model: card.model, name: 'run1' });
    write('.work/codex/run1.out', 'usage limit');
    write('.work/codex/run1.exit', '1');
    const lanes = await createCollector(config).collect();
    assert.equal(lanes.packages[0].adventurerId, 'codex-luna');
    const [shown] = effectiveRoster([card], lanes);
    assert.equal(shown.status, 'limited');
    assert.equal(shown.derived.at, lanes.packages[0].observedAt);
  });

  it('keeps a bounced card limited after reassignment, then clears it on that card\'s later success', async () => {
    const { config, write } = makeProject();
    write('docs/briefs/RUN-1-x.md', 'RUN-1');
    const store = new QuestStore(config);
    store.post({ package: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' });
    store.assign('RUN-1', { adventurer: card, name: 'run1-a' });
    appendJsonLine(config.paths.registry, { at: new Date().toISOString(), event: 'dispatch', package: 'RUN-1', lane: 'codex', model: card.model, name: 'run1-a' });
    const bounceAt = Date.now() - 5000;
    const bounceOut = write('.work/codex/run1-a.out', "You've hit your usage limit.");
    const bounceExit = write('.work/codex/run1-a.exit', '1');
    fs.utimesSync(bounceOut, new Date(bounceAt), new Date(bounceAt));
    fs.utimesSync(bounceExit, new Date(bounceAt), new Date(bounceAt));

    store.setStatus('RUN-1', 'bounced', { detail: 'quota', source: 'collector', evidence: { kind: 'collector', attemptId: store.get('RUN-1').assignee.attemptId } });
    store.assign('RUN-1', { adventurer: otherCard, name: 'run1-b' });
    let lanes = await createCollector(config).collect({ now: bounceAt + 1000 });
    let shown = effectiveRoster([card, otherCard], lanes, bounceAt + 1000);
    assert.equal(shown.find((entry) => entry.id === card.id).status, 'limited');
    assert.equal(shown.find((entry) => entry.id === otherCard.id).status, 'available');

    appendJsonLine(config.paths.registry, { at: new Date().toISOString(), event: 'dispatch', package: 'RUN-1', lane: 'codex', model: otherCard.model, name: 'run1-b' });
    write('.work/codex/run1-b.out', 'working');
    lanes = await createCollector(config).collect({ now: bounceAt + 2000 });
    shown = effectiveRoster([card, otherCard], lanes, bounceAt + 2000);
    assert.equal(shown.find((entry) => entry.id === card.id).status, 'limited', 'the old dispatch history still identifies card A');
    assert.equal(shown.find((entry) => entry.id === otherCard.id).status, 'available');

    store.setStatus('RUN-1', 'bounced', { detail: 'retry', source: 'collector', evidence: { kind: 'collector', attemptId: store.get('RUN-1').assignee.attemptId } });
    store.assign('RUN-1', { adventurer: card, name: 'run1-a2' });
    appendJsonLine(config.paths.registry, { at: new Date().toISOString(), event: 'dispatch', package: 'RUN-1', lane: 'codex', model: card.model, name: 'run1-a2' });
    const successAt = Date.now() - 1000;
    const successOut = write('.work/codex/run1-a2.out', 'done');
    const successExit = write('.work/codex/run1-a2.exit', '0');
    fs.utimesSync(successOut, new Date(successAt), new Date(successAt));
    fs.utimesSync(successExit, new Date(successAt), new Date(successAt));
    lanes = await createCollector(config).collect({ now: successAt + 1000 });
    shown = effectiveRoster([card, otherCard], lanes, successAt + 1000);
    assert.equal(shown.find((entry) => entry.id === card.id).status, 'available', 'a newer success by card A clears only card A evidence');
  });

  it('reads per-card lane entries while leaving newer unidentified evidence advisory', () => {
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    const lanes = {
      packages: [],
      laneLimits: {
        codex: {
          at: '2026-09-16T11:59:00.000Z', name: 'leftover', until: null,
          cards: { [card.id]: { adventurerId: card.id, at: '2026-09-16T11:00:00.000Z', until: null, name: 'a1' } },
          unidentified: [{ at: '2026-09-16T11:59:00.000Z', model: card.model, name: 'leftover' }],
        },
      },
    };
    const shown = effectiveRoster([card, otherCard], lanes, now);
    assert.equal(shown[0].status, 'limited');
    assert.equal(shown[1].status, 'available');
    assert.equal(shown[0].laneDiagnostics[0].code, 'quota_identity_unknown');
  });

  it('makes the same base/effective/derived shape available through snapshots', () => {
    const { config } = makeProject();
    const store = new QuestStore(config);
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    const lanes = { packages: [{ package: 'RUN-1', lane: 'codex', model: card.model, adventurerId: card.id, state: 'bounced', observedAt: new Date(now).toISOString() }], laneLimits: {} };
    const snapshot = buildSnapshot({ config, store, adventurers: [card], boardStore: null, lanes });
    const shown = snapshot.roster[0];
    assert.deepEqual({ baseStatus: shown.baseStatus, baseReason: shown.baseReason, status: shown.status, from: shown.derived.from, at: shown.derived.at, resetsAt: shown.derived.resetsAt }, {
      baseStatus: 'available', baseReason: '', status: 'limited', from: 'lanes', at: new Date(now).toISOString(), resetsAt: null,
    });
  });

  it('passes laneEvidence through snapshots and keeps expired cards unverified', () => {
    const { config } = makeProject();
    const store = new QuestStore(config);
    const laneEvidence = {
      codex: {
        cards: {
          [card.id]: {
            adventurerId: card.id,
            at: '2026-09-15T10:00:00.000Z',
            since: '2026-09-15T10:00:00.000Z',
            until: '2026-09-15T12:00:00Z',
            resetsAt: '2026-09-15T12:00:00.000Z',
            name: 'expired',
          },
        },
        unidentified: [{ at: '2026-09-16T11:00:00.000Z', name: 'leftover', model: card.model }],
      },
    };
    const snapshot = buildSnapshot({ config, store, adventurers: [card], boardStore: null, lanes: { packages: [], laneLimits: {}, laneEvidence } });
    assert.deepEqual(snapshot.laneEvidence, laneEvidence);
    assert.equal(snapshot.roster[0].status, 'available');
    assert.equal(snapshot.roster[0].derived.reason, '\u9650\u989d\u7a97\u53e3\u5df2\u8fc7\uff0c\u5c1a\u672a\u9a8c\u8bc1\u53ef\u7528');
    assert.equal(snapshot.roster[0].laneDiagnostics[0].code, 'quota_identity_unknown');
  });

  it('includes the effective or manual reason in the limited refusal', () => {
    const result = canDispatch({
      quest: quest(),
      adventurer: { ...card, status: 'limited', baseReason: 'provider quota needs a manual check' },
      quests: [quest()], policy: {}, env: { laneIds: new Set(['codex']), briefExists: true },
    });
    const refusal = result.reasons.find((reason) => reason.code === 'adventurer_limited');
    assert.ok(refusal);
    assert.match(refusal.message, /provider quota needs a manual check/);
  });

  it('drops the lane limit when its card is acknowledged, paused or gone, keeping cleared evidence', () => {
    const { config } = makeProject();
    const store = new QuestStore(config);
    const at = '2026-09-16T10:00:00.000Z';
    const entry = { adventurerId: card.id, at, since: at, until: null, resetsAt: null, name: 'luna-a1' };
    const lanes = { packages: [], laneLimits: { codex: { ...entry, cards: { [card.id]: entry } } } };

    const acknowledged = buildSnapshot({ config, store, adventurers: [{ ...card, statusSetBy: 'owner', statusSince: '2026-09-16T11:00:00.000Z' }], boardStore: null, lanes });
    assert.deepEqual(acknowledged.laneLimits, {}, 'the owner acknowledgement leaves no lane chip');
    assert.equal(acknowledged.laneEvidence.codex.cards[card.id].cleared, 'owner');
    assert.equal(acknowledged.laneEvidence.codex.cards[card.id].name, 'luna-a1');

    const paused = buildSnapshot({ config, store, adventurers: [{ ...card, status: 'paused', statusReason: '\u672c\u5468\u4e0d\u7528' }], boardStore: null, lanes });
    assert.deepEqual(paused.laneLimits, {}, 'a paused card stops asserting the lane');
    assert.equal(paused.laneEvidence.codex.cards[card.id].cleared, 'status');

    const removed = buildSnapshot({ config, store, adventurers: [otherCard], boardStore: null, lanes });
    assert.deepEqual(removed.laneLimits, {}, 'a card missing from the roster stops asserting the lane');
    assert.equal(removed.laneEvidence.codex.cards[card.id].cleared, 'no_card');
  });

  it('keeps the lane limit with the newest kept entry on top while that card is still limited', () => {
    const { config } = makeProject();
    const store = new QuestStore(config);
    const luna = { adventurerId: card.id, at: '2026-09-16T09:00:00.000Z', since: '2026-09-16T09:00:00.000Z', until: null, resetsAt: null, name: 'luna-old' };
    const astra = { adventurerId: otherCard.id, at: '2026-09-16T10:30:00.000Z', since: '2026-09-16T10:30:00.000Z', until: null, resetsAt: null, name: 'astra-new' };
    const lanes = { packages: [], laneLimits: { codex: {
      adventurerId: 'stale', at: '2020-01-01T00:00:00.000Z', since: '2020-01-01T00:00:00.000Z', until: null, resetsAt: null, name: 'stale',
      cards: { [card.id]: luna, [otherCard.id]: astra },
    } } };
    const snapshot = buildSnapshot({ config, store, adventurers: [card, otherCard], boardStore: null, lanes });
    const limit = snapshot.laneLimits.codex;
    assert.ok(limit, 'both cards are still limited, so the lane keeps its key');
    assert.equal(limit.adventurerId, otherCard.id);
    assert.equal(limit.name, 'astra-new');
    assert.equal(limit.at, '2026-09-16T10:30:00.000Z');
    assert.equal(limit.cards[card.id].name, 'luna-old');
    assert.deepEqual(limit.cards[otherCard.id], astra);
  });
});
