import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFileSet, titleLine, withFileSets, unpostedBriefs } from '../../src/core/briefs.js';
import { deriveTransitions, liveByName } from '../../src/core/sync.js';
import { effectiveRoster } from '../../src/core/overlay.js';
import { packageFromFileName, packageIdPattern, briefPathAllowed } from '../../src/core/patterns.js';
import { makeProject } from '../helpers.js';

const brief = `RUN-3C — Catalogue the new smoke fields.

## What to do

Edit \`Assets/Not/This.cs\` is mentioned here but is not in the list.

## Files you may edit (nothing else)

- \`Assets/Editor/QA/PlaySmokeReport.Fields.cs\` (add \`PlaySmokeReport.Fields.Run3.cs\` if needed)
- \`Assets\\Runtime\\Player\\RunLoopController.cs\`
- Tests under \`Assets/Tests/EditMode/\` (new files only)

## Delivery
`;

describe('patterns', () => {
  it('reads package ids from ids and file names', () => {
    const { config } = makeProject();
    assert.ok(packageIdPattern(config).test('ART-WIRE-2H'));
    assert.equal(packageIdPattern(config).test('RUN-4-x'), false);
    assert.equal(packageFromFileName(config, 'RUN-3C-catalogue.md'), 'RUN-3C');
    assert.equal(packageFromFileName(config, 'notes.md'), null);
    assert.equal(briefPathAllowed(config, 'docs\\briefs\\RUN-4.md', 'code'), true);
  });
});

describe('briefs', () => {
  it('reads only the paths under the file-list heading', () => {
    const { config } = makeProject();
    assert.deepEqual(parseFileSet(brief, config.briefs.fileListHeading), ['Assets/Editor/QA/PlaySmokeReport.Fields.cs', 'PlaySmokeReport.Fields.Run3.cs', 'Assets/Runtime/Player/RunLoopController.cs']);
    assert.equal(titleLine(`\n# ${brief}`), 'RUN-3C — Catalogue the new smoke fields.');
  });

  it('attaches file sets and lists recent briefs nobody posted or dispatched', () => {
    const { config, write } = makeProject();
    write('docs/briefs/RUN-3C-catalogue.md', brief);
    write('docs/briefs/RUN-4-the-way-back.md', 'RUN-4 title');
    write('docs/briefs/MOD-1-scanner.md', 'MOD-1 title');
    const old = write('docs/briefs/WP-1-old.md', 'old');
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(old, past, past);
    assert.equal(withFileSets(config, [{ id: 'RUN-3C', brief: 'docs/briefs/RUN-3C-catalogue.md' }])[0].files.length, 3);
    const list = unpostedBriefs(config, { postedIds: new Set(['RUN-4']), dispatchedIds: new Set(['MOD-1']) });
    assert.deepEqual(list.map((b) => b.package), ['RUN-3C']);
  });
});

describe('sync', () => {
  const at = '2026-09-13T05:00:00.000Z';
  const running = { id: 'RUN-4', status: 'dispatched', assignee: { name: 'run4', at } };
  const later = (minutes) => Date.parse(at) + minutes * 60 * 1000;

  it('maps finished rows, keeps bounce times, and treats a never-resumed bounce as a bounce', () => {
    assert.deepEqual(deriveTransitions([running], [{ name: 'run4', state: 'delivered', dispatchedAt: at, lastText: 'done' }], later(1)), [{ id: 'RUN-4', status: 'delivered', detail: 'done' }]);
    assert.match(deriveTransitions([running], [{ name: 'run4', state: 'bounced', reason: 'usage limit', bounceUntil: '1:54 PM', dispatchedAt: at }], later(1))[0].detail, /1:54 PM 恢复/);
    assert.equal(deriveTransitions([running], [{ name: 'run4', state: 'superseded', dispatchedAt: at }], later(1))[0].status, 'bounced');
  });

  it('ignores older rows reusing the name, except for adopted workers', () => {
    const old = [{ name: 'run4', state: 'delivered', dispatchedAt: '2026-09-10T00:00:00.000Z', lastText: 'ok' }];
    assert.deepEqual(deriveTransitions([running], old, later(1)), []);
    const adopted = { ...running, assignee: { ...running.assignee, adopted: true } };
    assert.equal(deriveTransitions([adopted], old, later(1))[0].status, 'delivered');
    assert.deepEqual(Object.keys(liveByName(old, [adopted])), ['run4']);
    assert.deepEqual(liveByName(old, [running]), {});
  });

  it('watches a stalled quest: back to work when output resumes, finished on exit, held otherwise', () => {
    const silent = { ...running, status: 'stalled' };
    const resumed = deriveTransitions([silent], [{ name: 'run4', state: 'running', dispatchedAt: at }], later(30));
    assert.deepEqual([resumed[0].status, /run4 又有动静了/.test(resumed[0].detail)], ['dispatched', true]);
    assert.equal(deriveTransitions([silent], [{ name: 'run4', state: 'delivered', dispatchedAt: at }], later(30))[0].status, 'delivered');
    assert.equal(deriveTransitions([silent], [{ name: 'run4', state: 'failed', reason: 'exit 1', dispatchedAt: at }], later(30))[0].status, 'failed');
    assert.deepEqual(deriveTransitions([silent], [{ name: 'run4', state: 'stalled', dispatchedAt: at }], later(30)), [], 'no repeated stall');
    assert.deepEqual(deriveTransitions([silent], [], later(30)), [], 'a missing row does not free it');
  });

  it('stalls a quest whose worker never registered', () => {
    assert.deepEqual(deriveTransitions([running], [], later(5)), []);
    assert.equal(deriveTransitions([running], [], later(11))[0].status, 'stalled');
  });
});

describe('overlay', () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const roster = [
    { id: 'oc-mimo', lane: 'opencode', model: 'xiaomi/mimo-v2.5-pro', status: 'available' },
    { id: 'codex-luna', lane: 'codex', model: 'gpt-5.6-luna', status: 'available' },
    { id: 'codex-sol', lane: 'codex', model: 'gpt-5.6-sol', status: 'paused' },
  ];

  it('greys a card during a current bounce and heals afterwards', () => {
    const lanes = { packages: [{ package: 'RUN-3', lane: 'opencode', model: 'xiaomi/mimo-v2.5-pro', state: 'bounced', bounceUntil: '1:54 PM', dispatchedAt: '2026-09-13T10:00:00.000Z' }] };
    assert.match(effectiveRoster(roster, lanes, now)[0].derived.reason, /RUN-3 限额退回，1:54 PM 恢复/);
    assert.equal(effectiveRoster(roster, lanes, now + 6 * 3600 * 1000)[0].status, 'available');
  });

  it('greys every card of a limited file lane but keeps manual statuses', () => {
    const result = effectiveRoster(roster, { packages: [], laneLimits: { codex: { since: '2026-09-13T11:05:00.000Z', until: '13:54' } } }, now);
    assert.equal(result[1].status, 'limited');
    assert.match(result[1].derived.reason, /codex 限额中，13:54 恢复/);
    assert.equal(result[2].status, 'paused');
    assert.equal(result[0].status, 'available');
    assert.deepEqual(effectiveRoster(roster, null, now), roster);
  });
});
