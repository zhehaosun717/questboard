// Owner decision 2026-09-17: a card's STATUS is project-scoped, while the card itself stays machine-level.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { StatusLog, applyStatuses, foldStatuses } from '../../src/core/status.js';
import { tmpDir } from '../helpers.js';

const record = (adventurerId, status, extra = {}) => ({ at: '2026-09-17T00:00:00.000Z', adventurerId, status, reason: '', setBy: 'owner', ...extra });

describe('project-scoped card status', () => {
  it('a record written in one project never changes another project\'s view', () => {
    const records = [record('agy-sonnet', 'broke', { projectId: 'aaaaaa' })];
    assert.equal(foldStatuses(records, 'aaaaaa').get('agy-sonnet').status, 'broke');
    assert.equal(foldStatuses(records, 'bbbbbb').get('agy-sonnet'), undefined);
  });

  it('a machine-level record with no projectId still applies everywhere', () => {
    const records = [record('agy-sonnet', 'broke')];
    assert.equal(foldStatuses(records, 'aaaaaa').get('agy-sonnet').status, 'broke');
    assert.equal(foldStatuses(records, 'bbbbbb').get('agy-sonnet').status, 'broke');
  });

  it('the same card can hold different statuses in two projects', () => {
    const records = [record('agy-sonnet', 'broke', { projectId: 'aaaaaa' }), record('agy-sonnet', 'available', { projectId: 'bbbbbb' })];
    assert.equal(foldStatuses(records, 'aaaaaa').get('agy-sonnet').status, 'broke');
    assert.equal(foldStatuses(records, 'bbbbbb').get('agy-sonnet').status, 'available');
  });

  it('StatusLog.set writes the project id, scopes the read, and refuses a malformed id', () => {
    const file = path.join(tmpDir('qb-status-'), 'status.jsonl');
    const log = new StatusLog(file);
    log.set('agy-sonnet', { status: 'broke', reason: 'x', setBy: 'owner', projectId: 'aaaaaaaa' });
    const written = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    assert.equal(written.projectId, 'aaaaaaaa');
    assert.equal(log.current('aaaaaaaa').get('agy-sonnet').status, 'broke');
    assert.equal(log.current('bbbbbbbb').get('agy-sonnet'), undefined);
    assert.throws(() => log.set('agy-sonnet', { status: 'broke', setBy: 'owner', projectId: 'BAD ID' }), /projectId/);
  });

  it('applyStatuses marks a card available when this project has no record for it', () => {
    const applied = applyStatuses([{ id: 'agy-sonnet', name: 'S' }], foldStatuses([record('agy-sonnet', 'broke', { projectId: 'aaaaaa' })], 'bbbbbb'));
    assert.equal(applied[0].status, 'available');
  });
});