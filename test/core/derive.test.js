import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFileSet, titleLine, withFileSets, unpostedBriefs } from '../../src/core/briefs.js';
import { deriveTransitions, liveByName, tailText } from '../../src/core/sync.js';
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

  it('keeps a long-running adopted worker trackable no matter how long it ran before adoption (no retroactive limit)', () => {
    // Adopted only ever bounds the window forward (CLOCK_SKEW_MS past the adoption time); there is no
    // matching backward bound, so a worker that had already been running for days before someone adopted it
    // on the board must not "disappear" the way a non-adopted row would past NO_ROW_MS. Only a row
    // registered well after the adoption reads as unrelated (see the test below).
    const adopted = { ...running, assignee: { ...running.assignee, adopted: true } };
    const daysEarlier = [{ name: 'run4', state: 'delivered', dispatchedAt: '2026-09-01T00:00:00.000Z', lastText: 'finally done' }];
    assert.equal(deriveTransitions([adopted], daysEarlier, later(1))[0].status, 'delivered', 'a row from days before adoption is still trusted');
    assert.deepEqual(Object.keys(liveByName(daysEarlier, [adopted])), ['run4']);
  });

  it('does not let an adopted assignee trust a same-named row registered well after the adoption', () => {
    const adopted = { ...running, assignee: { ...running.assignee, adopted: true } };
    // Registered 5 minutes after the adoption — outside CLOCK_SKEW_MS, so it reads as a later, unrelated
    // dispatch that happens to reuse the name, not evidence of the adopted worker itself. "adopted" only
    // widens the trust window backwards (the registry row predates the adoption), never forwards without
    // bound.
    const futureRow = [{ name: 'run4', state: 'delivered', dispatchedAt: new Date(later(5)).toISOString(), lastText: 'unrelated later dispatch' }];
    assert.deepEqual(deriveTransitions([adopted], futureRow, later(6)), [], 'not trusted just because this assignee was adopted');
    assert.deepEqual(liveByName(futureRow, [adopted]), {}, 'and not shown as this adopted worker\'s live output either');
  });

  it('never lets a legacy bare-name row with no time end a brand-new, non-adopted attempt just because the name matches (P4L)', () => {
    // A registry row with no dispatchedAt at all (predates the field, or a foreign process) has nothing to
    // compare against a fresh, timestamped attempt's own `at` — trusting it here would let an unrelated
    // legacy row silently end an attempt it never touched, exactly the shape a project whose registry
    // predates the board could produce for a genuinely new dispatch.
    const bareRow = [{ name: 'run4', state: 'failed', lastText: 'legacy row with no time' }];
    assert.deepEqual(deriveTransitions([running], bareRow, later(1)), [], 'not trusted as this brand-new attempt\'s own evidence');
  });

  it('still trusts a bare-name row with no time for an adopted worker, whose registry predates the board recording it at all', () => {
    const adopted = { ...running, assignee: { ...running.assignee, adopted: true } };
    const bareRow = [{ name: 'run4', state: 'delivered', lastText: 'legacy adopt, dispatchedAt never recorded' }];
    assert.equal(deriveTransitions([adopted], bareRow, later(1))[0].status, 'delivered', 'adopted compatibility is unaffected by the fix');
  });

  it('never reinterprets a distinct earlier attempt\'s registry row as evidence for a new attempt that re-adopted the same name', () => {
    const T0 = '2026-09-10T00:00:00.000Z';
    const T2 = '2026-09-12T00:00:00.000Z';
    const oldAttempt = { name: 'run4', lane: 'codex', at: T0, attemptId: 'a-old' };
    const newAttempt = { name: 'run4', lane: 'codex', at: T2, adopted: true, attemptId: 'a-new' };
    const readopted = { id: 'RUN-4', status: 'dispatched', dispatches: [oldAttempt, newAttempt], assignee: newAttempt };
    const oldRow = [{ name: 'run4', lane: 'codex', state: 'failed', dispatchedAt: T0, lastText: 'old attempt crashed' }];
    // The row is the old attempt's own registration (dispatchedAt matches its `at` exactly) — it must not
    // be read as this new adoption's evidence just because "adopted" widens the trust window backwards; that
    // widening is bounded by the new attempt's own most recent distinct predecessor, not unbounded.
    assert.deepEqual(deriveTransitions([readopted], oldRow, Date.parse(T2) + 60 * 1000), [], 'no transition — the old row is not trusted, and it is not yet stale enough to report stalled either');
    // A row genuinely registered by the new attempt itself (after it re-adopted) is trusted normally.
    const newRow = [{ name: 'run4', lane: 'codex', state: 'delivered', dispatchedAt: T2, lastText: 'done' }];
    assert.equal(deriveTransitions([readopted], newRow, Date.parse(T2) + 60 * 1000)[0].status, 'delivered');
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

  it('cuts long worker output at a word boundary and marks the cut', () => {
    assert.equal(tailText('short'), 'short');
    assert.equal(tailText(null), '');
    const long = `${'x'.repeat(50)} Strictly follow the taxonomy`;
    const cut = tailText(long, 30);
    assert.equal(cut, '…Strictly follow the taxonomy', 'no half word like "trictly"');
    const chinese = '中'.repeat(40);
    assert.equal(tailText(chinese, 10), `…${'中'.repeat(10)}`, 'text with no spaces keeps the plain tail');
    const delivered = deriveTransitions([running], [{ name: 'run4', state: 'delivered', dispatchedAt: at, lastText: `${'a'.repeat(400)} Strictly done` }], later(1));
    assert.match(delivered[0].detail, /^…/);
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
