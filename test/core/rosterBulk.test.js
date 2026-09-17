import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyRosterBulk,
  previewRosterBulk,
  rosterFingerprint,
  validateRosterBulkRequest,
} from '../../src/core/rosterBulk.js';
import { applyStatuses, foldStatuses, StatusLog } from '../../src/core/status.js';
import { effectiveRoster, visibleLaneLimits } from '../../src/core/overlay.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const card = (id, over = {}) => ({
  id, name: id.toUpperCase(), provider: 'synthetic', lane: 'code', model: `model-${id}`, family: 'family',
  ...over,
});

describe('roster bulk request validation', () => {
  it('bounds ids, accepts explicit env removal and does not accept an empty operation', () => {
    assert.throws(() => validateRosterBulkRequest({ ids: [], patch: { variant: 'x' } }), /non-empty array/);
    assert.throws(() => validateRosterBulkRequest({ ids: ['a'], patch: {} }), /must contain a change/);
    assert.throws(
      () => validateRosterBulkRequest({ ids: ['a'], patch: { env: { set: { bad: 'x' } } } }),
      (err) => /UPPER_SNAKE_CASE/.test(err.message) && /[一-鿿]/u.test(err.message) && err.message.includes('bad'),
    );
    assert.throws(() => validateRosterBulkRequest({ ids: ['a'], patch: { env: { set: { OPENAI_MODEL: 'sk-secret' } } } }), /OPENAI_MODEL 的值看起来像密钥/);
    assert.throws(() => validateRosterBulkRequest({ ids: ['a'], patch: { env: { set: { TOKEN: 'x' } } } }), /TOKEN 不是卡片可以设置的/);
    assert.equal(validateRosterBulkRequest({ ids: ['a'], patch: { env: { set: { OC_AGENT: 'build' } } } }, { cardEnvAllow: ['OC_AGENT'] }).patch.env.set.OC_AGENT, 'build');
    assert.throws(() => validateRosterBulkRequest({ ids: ['a'], patch: { env: { set: { OLD_MODEL: 'x' }, remove: ['OLD_MODEL'] } } }), /既设置又删除环境变量 OLD_MODEL/);
    assert.equal(validateRosterBulkRequest({ ids: ['a'], patch: { env: { remove: ['OLD'] } } }).patch.env.remove[0], 'OLD');
    assert.throws(
      () => validateRosterBulkRequest({ ids: ['a'], patch: { env: { remove: ['ld_audit'] } } }),
      (err) => /UPPER_SNAKE_CASE/.test(err.message) && /[一-鿿]/u.test(err.message) && err.message.includes('ld_audit'),
    );
    assert.equal(validateRosterBulkRequest({ ids: ['a'], patch: { variant: '' } }).patch.variant, '');
    assert.equal(validateRosterBulkRequest({ ids: ['a'], action: 'delete' }).patch.action, 'delete');
  });
});

describe('roster bulk preview and apply', () => {
  it('shows changed/preserved fields, protects canonical held and unresolved attempts, and never returns env values', () => {
    const roster = { adventurers: [card('one', { variant: 'high', env: { OPENAI_BASE_URL: 'https://old.test' } }), card('two')] };
    const preview = previewRosterBulk({
      roster,
      quests: [
        { id: 'RUN-1', status: 'stalled', assignee: { adventurerId: 'one' } },
        { id: 'RUN-2', status: 'failed', assignee: { adventurerId: 'two', unresolved: true } },
      ],
      request: { ids: ['one', 'two'], patch: { variant: '', env: { set: { OPENAI_BASE_URL: 'https://new.test' }, remove: ['MISSING'] } } },
    });
    assert.deepEqual(preview.results.map((r) => r.ok), [false, false]);
    assert.match(preview.deniedActiveCards[0].reasons[0].message, /RUN-1/);
    assert.match(preview.deniedActiveCards[1].reasons[0].message, /RUN-2/);
    assert.match(preview.statusNote, /限额/);
    assert.ok(!JSON.stringify(preview).includes('https://new.test'));
    assert.ok(!JSON.stringify(preview).includes('https://old.test'));
    assert.ok(preview.results[0].preservedFields.includes('name'));
  });

  it('denies bulk available for real derived quota evidence and keeps the lane limit visible', async () => {
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    const roster = { adventurers: [card('quota')] };
    const entry = {
      adventurerId: 'quota',
      at: '2026-09-16T11:59:00.000Z',
      since: '2026-09-16T11:59:00.000Z',
      until: null,
      resetsAt: '2026-09-16T15:00:00.000Z',
      name: 'QUOTA',
    };
    const lanes = { packages: [], laneLimits: { code: { ...entry, cards: { quota: entry } } } };
    const effective = effectiveRoster(applyStatuses(roster.adventurers, new Map()), lanes, now);
    assert.equal(effective[0].status, 'limited');
    assert.equal(effective[0].derived.from, 'lanes');

    const request = { ids: ['quota'], patch: { status: 'available' } };
    const preview = previewRosterBulk({ roster, statusRecords: [], quests: [], effectiveRoster: effective, request });
    assert.equal(preview.results[0].ready, false);
    assert.equal(preview.results[0].denied, true);
    assert.equal(preview.counts.denied, 1);
    assert.equal(preview.deniedActiveCards[0].id, 'quota');
    assert.match(preview.deniedActiveCards[0].reasons[0].message, /\u786e\u8ba4\u989d\u5ea6\u5df2\u6062\u590d/);
    assert.match(preview.statusNote, /不能批量设为空闲/);
    assert.doesNotMatch(preview.statusNote, /可用/, 'the bulk note must use the single-card 空闲 label, never 可用');
    assert.doesNotMatch(preview.deniedActiveCards[0].reasons[0].message, /可用/, 'the bulk refusal must call available 空闲 too');

    const dir = tmp('qb-roster-bulk-derived-');
    const file = path.join(dir, 'roster.json');
    fs.writeFileSync(file, `${JSON.stringify(roster)}\n`);
    const log = new StatusLog(path.join(dir, 'status.jsonl'));
    const applied = await applyRosterBulk({
      rosterFile: file,
      statusLog: log,
      request,
      getEffectiveRoster: () => effectiveRoster(
        applyStatuses(JSON.parse(fs.readFileSync(file, 'utf8')).adventurers, log.current()),
        lanes,
        now,
      ),
    });
    assert.equal(applied.counts.denied, 1);
    assert.equal(applied.counts.changed, 0);
    assert.deepEqual(log.records(), []);

    const after = effectiveRoster(
      applyStatuses(JSON.parse(fs.readFileSync(file, 'utf8')).adventurers, log.current()),
      lanes,
      now,
    );
    assert.equal(after[0].status, 'limited');
    const visible = visibleLaneLimits(lanes.laneLimits, after, {});
    assert.ok(visible.laneLimits.code);
    assert.ok(visible.laneLimits.code.cards.quota);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).adventurers[0].id, 'quota');
  });

  it('denies available for manually limited and paused cards when the real overlay finds active evidence', async () => {
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    const roster = { adventurers: [card('manual', { lane: 'code' }), card('paused', { lane: 'code' })] };
    const statusRecords = [
      { at: '2026-09-16T11:50:00.000Z', adventurerId: 'manual', status: 'limited', reason: 'manual limit', setBy: 'owner' },
      { at: '2026-09-16T11:50:00.000Z', adventurerId: 'paused', status: 'paused', reason: 'manual pause', setBy: 'owner' },
    ];
    const entry = (adventurerId) => ({
      adventurerId,
      at: '2026-09-16T11:59:00.000Z',
      since: '2026-09-16T11:59:00.000Z',
      until: null,
      resetsAt: '2026-09-16T15:00:00.000Z',
      name: adventurerId,
    });
    const lanes = { packages: [], laneLimits: { code: { cards: { manual: entry('manual'), paused: entry('paused') } } } };
    const withStatuses = applyStatuses(roster.adventurers, foldStatuses(statusRecords));
    const effective = effectiveRoster(withStatuses, lanes, now);
    const quotaEvidence = effectiveRoster(withStatuses.map((item) => item.status === 'available' ? item : {
      ...item, status: 'available', statusSince: null, statusReason: '', statusSetBy: null,
    }), lanes, now);
    assert.deepEqual(effective.map((item) => item.status), ['limited', 'paused']);
    assert.deepEqual(quotaEvidence.map((item) => item.status), ['limited', 'limited']);

    const request = { ids: ['manual', 'paused'], patch: { status: 'available' } };
    const preview = previewRosterBulk({ roster, statusRecords, quests: [], effectiveRoster: effective, quotaEvidenceRoster: quotaEvidence, request });
    assert.deepEqual(preview.results.map((result) => result.denied), [true, true]);
    assert.equal(preview.counts.denied, 2);
    assert.ok(preview.results.every((result) => result.reasons[0].code === 'quota_evidence'));
    assert.ok(preview.results.every((result) => /确认额度已恢复/.test(result.reasons[0].message)));

    const dir = tmp('qb-roster-bulk-manual-status-');
    const file = path.join(dir, 'roster.json');
    const statusFile = path.join(dir, 'status.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(roster)}\n`);
    fs.writeFileSync(statusFile, `${statusRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const log = new StatusLog(statusFile);
    const overlays = () => {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const current = applyStatuses(saved.adventurers, log.current());
      const probe = current.map((item) => item.status === 'available' ? item : {
        ...item, status: 'available', statusSince: null, statusReason: '', statusSetBy: null,
      });
      return {
        effectiveRoster: effectiveRoster(current, lanes, now),
        quotaEvidenceRoster: effectiveRoster(probe, lanes, now),
      };
    };
    const applied = await applyRosterBulk({
      rosterFile: file,
      statusLog: log,
      request,
      getEffectiveRoster: () => overlays().effectiveRoster,
      getQuotaEvidenceRoster: () => overlays().quotaEvidenceRoster,
    });
    assert.equal(applied.counts.denied, 2);
    assert.equal(applied.counts.changed, 0);
    assert.deepEqual(log.records(), statusRecords);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), roster);
    assert.ok(lanes.laneLimits.code.cards.manual);
    assert.ok(lanes.laneLimits.code.cards.paused);
    const visible = visibleLaneLimits(lanes.laneLimits, overlays().effectiveRoster, {});
    assert.ok(visible.laneLimits.code.cards.manual);
    assert.ok(visible.laneEvidence.code.cards.paused);
  });

  it('a bulk available that finds a card already acknowledged keeps its existing reason instead of blanking it (F6)', async () => {
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    const roster = { adventurers: [card('acked', { lane: 'code' })] };
    const statusRecords = [
      { at: '2026-09-16T11:55:00.000Z', adventurerId: 'acked', status: 'available', reason: '已手动确认额度恢复', setBy: 'owner' },
    ];
    const dir = tmp('qb-roster-bulk-keep-reason-');
    const file = path.join(dir, 'roster.json');
    const statusFile = path.join(dir, 'status.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(roster)}\n`);
    fs.writeFileSync(statusFile, `${statusRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const log = new StatusLog(statusFile);
    const request = { ids: ['acked'], patch: { status: 'available' } };
    const preview = previewRosterBulk({ roster, statusRecords, quests: [], request });
    assert.equal(preview.results[0].ok, true);
    assert.equal(preview.results[0].ready, true);
    assert.deepEqual(preview.results[0].changedFields, [], 'already available with no new reason given: nothing to change');
    const applied = await applyRosterBulk({ rosterFile: file, statusLog: log, request, now: () => '2026-09-16T12:00:00.000Z' });
    assert.equal(applied.counts.changed, 0);
    assert.equal(applied.counts.unchanged, 1);
    assert.equal(applied.results[0].ok, true);
    const records = log.records();
    assert.equal(records.length, 1, 'no new record is written for a bulk action that changes nothing');
    assert.equal(records[0].reason, '已手动确认额度恢复', 'the earlier acknowledgement reason must survive untouched');
  });

  it('a bulk available with an explicit empty reason keeps the existing reason, same as no reason at all (F6)', async () => {
    const roster = { adventurers: [card('acked', { lane: 'code' })] };
    const statusRecords = [
      { at: '2026-09-16T11:55:00.000Z', adventurerId: 'acked', status: 'available', reason: '已手动确认额度恢复', setBy: 'owner' },
    ];
    const dir = tmp('qb-roster-bulk-empty-reason-');
    const file = path.join(dir, 'roster.json');
    const statusFile = path.join(dir, 'status.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(roster)}\n`);
    fs.writeFileSync(statusFile, `${statusRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const log = new StatusLog(statusFile);
    // An explicitly empty reason means the same thing as leaving it out: this request names no new reason of
    // its own, so the existing acknowledgement must survive. Bulk deliberately cannot clear a reason — that
    // is a single-card action.
    const request = { ids: ['acked'], patch: { status: 'available', reason: '' } };
    const preview = previewRosterBulk({ roster, statusRecords, quests: [], request });
    assert.deepEqual(preview.results[0].changedFields, []);
    const applied = await applyRosterBulk({ rosterFile: file, statusLog: log, request, now: () => '2026-09-16T12:00:00.000Z' });
    assert.equal(applied.counts.changed, 0);
    assert.equal(applied.counts.unchanged, 1);
    const records = log.records();
    assert.equal(records.length, 1, 'no new record is written for a bulk action that changes nothing');
    assert.equal(records[0].reason, '已手动确认额度恢复');
  });

  it('a bulk available with an explicit non-empty reason replaces the old reason (F6)', async () => {
    const roster = { adventurers: [card('acked', { lane: 'code' })] };
    const statusRecords = [
      { at: '2026-09-16T11:55:00.000Z', adventurerId: 'acked', status: 'available', reason: '已手动确认额度恢复', setBy: 'owner' },
    ];
    const dir = tmp('qb-roster-bulk-new-reason-');
    const file = path.join(dir, 'roster.json');
    const statusFile = path.join(dir, 'status.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(roster)}\n`);
    fs.writeFileSync(statusFile, `${statusRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const log = new StatusLog(statusFile);
    const request = { ids: ['acked'], patch: { status: 'available', reason: '额度已确认，确实恢复了' } };
    const applied = await applyRosterBulk({ rosterFile: file, statusLog: log, request, now: () => '2026-09-16T12:00:00.000Z' });
    assert.equal(applied.counts.changed, 1);
    const records = log.records();
    assert.equal(records.length, 2);
    assert.equal(records[1].status, 'available');
    assert.equal(records[1].reason, '额度已确认，确实恢复了', 'an explicit non-empty reason still replaces the old one');
  });

  it('a bulk status transition away from an acknowledged available card still clears the old reason normally', async () => {
    const roster = { adventurers: [card('acked', { lane: 'code' })] };
    const statusRecords = [
      { at: '2026-09-16T11:55:00.000Z', adventurerId: 'acked', status: 'available', reason: '已手动确认额度恢复', setBy: 'owner' },
    ];
    const dir = tmp('qb-roster-bulk-transition-');
    const file = path.join(dir, 'roster.json');
    const statusFile = path.join(dir, 'status.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(roster)}\n`);
    fs.writeFileSync(statusFile, `${statusRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const log = new StatusLog(statusFile);
    const request = { ids: ['acked'], patch: { status: 'paused', reason: '手动暂停' } };
    const applied = await applyRosterBulk({ rosterFile: file, statusLog: log, request, now: () => '2026-09-16T12:00:00.000Z' });
    assert.equal(applied.counts.changed, 1);
    const records = log.records();
    assert.equal(records.length, 2);
    assert.equal(records[1].status, 'paused');
    assert.equal(records[1].reason, '手动暂停', 'an explicit reason on a real status transition is never overridden');
  });

  it('allows bulk available for a card whose single-card acknowledgement is newer than its quota evidence', async () => {
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    const roster = { adventurers: [card('acked', { lane: 'code' })] };
    const statusRecords = [
      { at: '2026-09-16T11:55:00.000Z', adventurerId: 'acked', status: 'available', reason: '已手动确认额度恢复', setBy: 'owner' },
    ];
    const entry = {
      adventurerId: 'acked',
      at: '2026-09-16T11:50:00.000Z',
      since: '2026-09-16T11:50:00.000Z',
      until: null,
      resetsAt: '2026-09-16T15:00:00.000Z',
      name: 'acked',
    };
    const lanes = { packages: [], laneLimits: { code: { cards: { acked: entry } } } };
    const withStatuses = applyStatuses(roster.adventurers, foldStatuses(statusRecords));
    const effective = effectiveRoster(withStatuses, lanes, now);
    const quotaEvidence = effectiveRoster(withStatuses.map((item) => item.status === 'available' ? item : {
      ...item, status: 'available', statusSince: null, statusReason: '', statusSetBy: null,
    }), lanes, now);
    assert.equal(effective[0].status, 'available');
    assert.equal(quotaEvidence[0].status, 'available');

    const request = { ids: ['acked'], patch: { status: 'available' } };
    const preview = previewRosterBulk({ roster, statusRecords, quests: [], effectiveRoster: effective, quotaEvidenceRoster: quotaEvidence, request });
    assert.equal(preview.results[0].denied, false);
    assert.equal(preview.results[0].ready, true);
    assert.equal(preview.counts.denied, 0);

    const dir = tmp('qb-roster-bulk-acked-');
    const file = path.join(dir, 'roster.json');
    const statusFile = path.join(dir, 'status.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(roster)}\n`);
    fs.writeFileSync(statusFile, `${statusRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const log = new StatusLog(statusFile);
    const overlays = () => {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const current = applyStatuses(saved.adventurers, log.current());
      const probe = current.map((item) => item.status === 'available' ? item : {
        ...item, status: 'available', statusSince: null, statusReason: '', statusSetBy: null,
      });
      return {
        effectiveRoster: effectiveRoster(current, lanes, now),
        quotaEvidenceRoster: effectiveRoster(probe, lanes, now),
      };
    };
    const applied = await applyRosterBulk({
      rosterFile: file,
      statusLog: log,
      request,
      getEffectiveRoster: () => overlays().effectiveRoster,
      getQuotaEvidenceRoster: () => overlays().quotaEvidenceRoster,
      now: () => '2026-09-16T12:00:00.000Z',
    });
    assert.equal(applied.counts.denied, 0);
    // Already available, and the bulk request names no reason of its own: F6 keeps the existing "已手动确认
    // 额度恢复" acknowledgement untouched rather than writing a fresh record that blanks it — see the
    // dedicated F6 test above.
    assert.equal(applied.counts.changed, 0);
    assert.equal(applied.counts.unchanged, 1);
    assert.equal(applied.results[0].ok, true);
    const records = log.records();
    assert.equal(records.length, 1);
    assert.equal(records[0].reason, '已手动确认额度恢复');
  });

  it('allows bulk available for a card whose quota evidence has expired', async () => {
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    const roster = { adventurers: [card('expired', { lane: 'code' }), card('expired-paused', { lane: 'code' })] };
    const statusRecords = [
      { at: '2026-09-16T10:00:00.000Z', adventurerId: 'expired-paused', status: 'paused', reason: 'manual pause', setBy: 'owner' },
    ];
    const entry = (adventurerId) => ({
      adventurerId,
      at: '2026-09-16T10:00:00.000Z',
      since: '2026-09-16T10:00:00.000Z',
      until: null,
      resetsAt: '2026-09-16T11:59:00.000Z',
      name: adventurerId,
    });
    const lanes = { packages: [], laneLimits: { code: { cards: { expired: entry('expired'), 'expired-paused': entry('expired-paused') } } } };
    const withStatuses = applyStatuses(roster.adventurers, foldStatuses(statusRecords));
    const effective = effectiveRoster(withStatuses, lanes, now);
    const quotaEvidence = effectiveRoster(withStatuses.map((item) => item.status === 'available' ? item : {
      ...item, status: 'available', statusSince: null, statusReason: '', statusSetBy: null,
    }), lanes, now);
    assert.equal(effective[0].status, 'available');
    assert.equal(effective[1].status, 'paused');
    assert.equal(quotaEvidence[0].status, 'available');
    assert.equal(quotaEvidence[1].status, 'available');

    const request = { ids: ['expired', 'expired-paused'], patch: { status: 'available' } };
    const preview = previewRosterBulk({ roster, statusRecords, quests: [], effectiveRoster: effective, quotaEvidenceRoster: quotaEvidence, request });
    assert.deepEqual(preview.results.map((r) => r.denied), [false, false]);
    assert.deepEqual(preview.results.map((r) => r.ready), [true, true]);
    assert.equal(preview.counts.denied, 0);

    const dir = tmp('qb-roster-bulk-expired-');
    const file = path.join(dir, 'roster.json');
    const statusFile = path.join(dir, 'status.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(roster)}\n`);
    fs.writeFileSync(statusFile, `${statusRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const log = new StatusLog(statusFile);
    const overlays = () => {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const current = applyStatuses(saved.adventurers, log.current());
      const probe = current.map((item) => item.status === 'available' ? item : {
        ...item, status: 'available', statusSince: null, statusReason: '', statusSetBy: null,
      });
      return {
        effectiveRoster: effectiveRoster(current, lanes, now),
        quotaEvidenceRoster: effectiveRoster(probe, lanes, now),
      };
    };
    const applied = await applyRosterBulk({
      rosterFile: file,
      statusLog: log,
      request,
      getEffectiveRoster: () => overlays().effectiveRoster,
      getQuotaEvidenceRoster: () => overlays().quotaEvidenceRoster,
      now: () => '2026-09-16T12:00:00.000Z',
    });
    assert.equal(applied.counts.denied, 0);
    assert.equal(applied.counts.changed, 1);
    assert.equal(applied.counts.unchanged, 1);
    assert.deepEqual(applied.results.map((r) => r.ok), [true, true]);
    const records = log.records();
    assert.equal(records.length, 2);
    assert.equal(records[1].adventurerId, 'expired-paused');
    assert.equal(records[1].status, 'available');
  });

  it('validates the complete planned roster before any write and preserves the roster status-free', async () => {
    const dir = tmp('qb-roster-bulk-validation-');
    const file = path.join(dir, 'roster.json');
    const roster = { adventurers: [card('one')] };
    fs.writeFileSync(file, `${JSON.stringify(roster)}\n`);
    const log = new StatusLog(path.join(dir, 'status.jsonl'));
    let writes = 0;
    await assert.rejects(
      applyRosterBulk({
        rosterFile: file,
        statusLog: log,
        request: { ids: ['one'], patch: { status: 'paused', env: { set: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`E${i}`, 'x'])) } } },
        save: () => { writes += 1; },
      }),
      /最多只能设置 10 个环境变量/,
    );
    assert.equal(writes, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), roster);
  });

  it('merges env per key, clears a blank variant, appends status actor/time, and refuses stale fingerprints', async () => {
    const dir = tmp('qb-roster-bulk-apply-');
    const file = path.join(dir, 'roster.json');
    const statusFile = path.join(dir, 'status.jsonl');
    const roster = { adventurers: [card('one', { variant: 'high', env: { OPENAI_BASE_URL: 'https://old.test', KEEP_MODEL: 'yes' } })] };
    fs.writeFileSync(file, `${JSON.stringify(roster)}\n`);
    const log = new StatusLog(statusFile);
    const fingerprint = rosterFingerprint(roster, []);
    const result = await applyRosterBulk({
      rosterFile: file,
      statusLog: log,
      request: { ids: ['one'], fingerprint, actor: 'owner', patch: { status: 'paused', reason: 'manual pause', variant: '', env: { set: { OPENAI_BASE_URL: 'https://new.test' }, remove: ['KEEP_MODEL'] } } },
      now: () => '2026-09-16T10:00:00.000Z',
    });
    assert.equal(result.counts.changed, 1);
    assert.equal(result.counts.failed, 0);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.adventurers[0].env, { OPENAI_BASE_URL: 'https://new.test' });
    assert.equal('variant' in saved.adventurers[0], false);
    assert.equal('status' in saved.adventurers[0], false);
    assert.deepEqual(log.records(), [{ at: '2026-09-16T10:00:00.000Z', adventurerId: 'one', status: 'paused', reason: 'manual pause', setBy: 'owner' }]);
    assert.ok(fs.readdirSync(dir).some((entry) => entry.startsWith('roster.json.bak-') && entry.endsWith('-update')));

    let writes = 0;
    await assert.rejects(
      applyRosterBulk({ rosterFile: file, statusLog: log, request: { ids: ['one'], fingerprint, patch: { variant: 'later' } }, save: () => { writes += 1; } }),
      (error) => error.code === 'stale_revision',
    );
    assert.equal(writes, 0);
  });

  it('rechecks a race before writing and reports a per-card save failure instead of all-success', async () => {
    const dir = tmp('qb-roster-bulk-race-');
    const file = path.join(dir, 'roster.json');
    const roster = { adventurers: [card('one'), card('two')] };
    fs.writeFileSync(file, `${JSON.stringify(roster)}\n`);
    const log = new StatusLog(path.join(dir, 'status.jsonl'));
    const quests = [];
    let writes = 0;
    const raced = await applyRosterBulk({
      rosterFile: file,
      statusLog: log,
      getQuests: () => quests,
      request: { ids: ['one'], patch: { variant: 'safe' } },
      beforeRecheck: async () => { quests.push({ id: 'RUN-RACE', status: 'dispatched', assignee: { adventurerId: 'one' } }); },
      save: () => { writes += 1; },
    });
    assert.equal(raced.counts.denied, 1);
    assert.equal(writes, 0);

    quests.length = 0;
    const failed = await applyRosterBulk({
      rosterFile: file,
      statusLog: log,
      request: { ids: ['one', 'two'], patch: { variant: 'safe' } },
      save: (target, next) => { writes += 1; if (writes === 1) throw new Error('disk fault'); fs.writeFileSync(target, `${JSON.stringify(next)}\n`); },
    });
    assert.equal(failed.counts.failed, 1);
    assert.equal(failed.counts.changed, 1);
    assert.equal(failed.results[0].ok, false);
    assert.equal(failed.results[1].ok, true);
  });
});
