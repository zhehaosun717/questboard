import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFileSet, titleLine, withFileSets, unpostedBriefs } from '../../src/core/briefs.js';
import { deriveTransitions, liveByName, tailText } from '../../src/core/sync.js';
import { effectiveRoster, visibleLaneLimits } from '../../src/core/overlay.js';
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


  it('reads the Chinese 可改文件 heading too, and nothing outside any file-list section (FB2-03 item 30)', () => {
    const { config } = makeProject();
    const zh = ['# X', '正文提到 `src/mentioned-only.js`，不在可改文件节。', '', '## 可改文件', '- `src/a.js`', '- `src/b.js`', '', '## 交付', '- `src/not-editable.js`'].join('\n');
    assert.deepEqual(parseFileSet(zh, config.briefs.fileListHeading), ['src/a.js', 'src/b.js']);
    // the English heading keeps working
    const en = ['## Files you may edit', '- `src/e.js`'].join('\n');
    assert.deepEqual(parseFileSet(en, config.briefs.fileListHeading), ['src/e.js']);
  });

  it('honours an explicit filesOverride instead of parsing the brief (FB2-03 item 30)', () => {
    const { config, write } = makeProject();
    write('docs/briefs/RUN-3C-catalogue.md', brief);
    const [derived] = withFileSets(config, [{ id: 'RUN-3C', brief: 'docs/briefs/RUN-3C-catalogue.md' }]);
    assert.equal(derived.files.length, 3);
    const [overridden] = withFileSets(config, [{ id: 'RUN-3C', brief: 'docs/briefs/RUN-3C-catalogue.md', filesOverride: ['src/only-this.js'] }]);
    assert.deepEqual(overridden.files, ['src/only-this.js']);
    // an empty override is an override too: the poster said this quest touches nothing
    const [empty] = withFileSets(config, [{ id: 'RUN-3C', brief: 'docs/briefs/RUN-3C-catalogue.md', filesOverride: [] }]);
    assert.deepEqual(empty.files, []);
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

  it('a delivered row with token usage carries it into the transition (FB2-10 item 3)', () => {
    const usage = { messages: 2, firstInputTokens: 60000, inputTokens: 69000, outputTokens: 800, cacheTokens: 20000 };
    const rows = [{ name: 'run4', state: 'delivered', dispatchedAt: at, lastText: 'done', usage }];
    const transitions = deriveTransitions([running], rows, later(1));
    assert.equal(transitions.length, 1);
    assert.deepEqual(transitions[0].usage, usage);
    const plain = deriveTransitions([running], [{ name: 'run4', state: 'delivered', dispatchedAt: at, lastText: 'done' }], later(1));
    assert.equal(plain[0].usage, undefined, 'no usage on the row, no usage on the transition');
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

  it('lets terminal rows win over stale bounds and applies a later bound reason to a silent quest', () => {
    const silent = { ...running, status: 'stalled', lastDetail: 'worker quiet' };
    const terminal = { name: 'run4', state: 'delivered', limitReason: '超过时长上限 1 分钟', dispatchedAt: at, lastText: 'done' };
    assert.equal(deriveTransitions([silent], [terminal], later(30))[0].status, 'delivered');
    const bounded = { name: 'run4', state: 'stalled', reason: '超过时长上限 1 分钟', limitReason: '超过时长上限 1 分钟', manualRequired: true, dispatchedAt: at };
    const [transition] = deriveTransitions([silent], [bounded], later(30));
    assert.deepEqual(transition, {
      id: 'RUN-4', status: 'stalled', detail: '超过时长上限 1 分钟 | 无法自动停止，请手动处理',
      limitReason: '超过时长上限 1 分钟', manualRequired: true,
    });
    assert.deepEqual(deriveTransitions([{ ...silent, lastDetail: transition.detail }], [bounded], later(30)), []);
  });

  it('never prefixes a manual_required detail with the result code itself', () => {
    // No reason/limitReason/lastText on this row, unlike the bound-reason fixture above — the manual
    // sentence is the whole detail, so a reintroduced `manual_required：` prefix has nowhere to hide behind
    // an earlier part of the joined string.
    const manualOnly = { name: 'run4', state: 'failed', manualRequired: true, dispatchedAt: at };
    const [transition] = deriveTransitions([running], [manualOnly], later(1));
    assert.equal(transition.detail, '无法自动停止，请手动处理', 'the owner-facing detail is exactly the current Chinese sentence');
    assert.ok(!transition.detail.startsWith('manual_required'), 'the owner-facing detail must never lead with the raw result code');
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

  it('passes an additive heartbeat through the live worker block', () => {
    const heartbeat = { at, ageMs: 7000, token: 'run-token', phase: 'running' };
    const row = { name: 'run4', state: 'running', dispatchedAt: at, elapsed: 1000, edits: 0, lastText: '', tokens: null, heartbeat };
    assert.deepEqual(liveByName([row], [running]), {
      run4: { state: 'running', elapsed: 1000, edits: 0, lastText: '', tokens: null, heartbeat },
    });
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
    const lanes = { packages: [{ package: 'RUN-3', lane: 'opencode', model: 'xiaomi/mimo-v2.5-pro', adventurerId: 'oc-mimo', state: 'bounced', bounceUntil: '1:54 PM', observedAt: '2026-09-13T10:00:00.000Z', dispatchedAt: '2026-09-13T10:00:00.000Z' }] };
    const during = effectiveRoster(roster, lanes, now)[0];
    assert.match(during.derived.reason, /RUN-3 限额退回，1:54 PM 恢复/);
    assert.equal(during.baseStatus, 'available');
    assert.equal(during.baseReason, '');
    assert.equal(during.derived.at, '2026-09-13T10:00:00.000Z');
    assert.equal(during.derived.resetsAt, '2026-09-13T20:54:00.000Z');
    const after = effectiveRoster(roster, lanes, now + 12 * 3600 * 1000)[0];
    assert.equal(after.status, 'available');
    assert.equal(after.derived.reason, '限额窗口已过，尚未验证可用');
    assert.equal(after.derived.resetsAt, '2026-09-13T20:54:00.000Z');
  });

  it('never shows a raw ISO timestamp in the limit reason (A4)', () => {
    // A structured API can hand back its reset as a raw ISO string instead of provider prose; the reason
    // must read the same way a human-worded reset does, never the machine string itself.
    const lanes = { packages: [{ package: 'RUN-9', lane: 'opencode', model: 'xiaomi/mimo-v2.5-pro', adventurerId: 'oc-mimo', state: 'bounced', bounceUntil: '2026-09-13T20:54:00.000Z', observedAt: '2026-09-13T10:00:00.000Z', dispatchedAt: '2026-09-13T10:00:00.000Z' }] };
    const during = effectiveRoster(roster, lanes, now)[0];
    assert.doesNotMatch(during.derived.reason, /\d{4}-\d{2}-\d{2}T/, 'no raw ISO timestamp leaks into the reason');
    assert.match(during.derived.reason, /RUN-9 限额退回，Sep 13, 2026 1:54 PM 恢复/);
  });

  it('parses a dated Codex-style reset and stops repeating it once it has passed (A4/N11)', () => {
    const lanes = { packages: [{ package: 'RUN-10', lane: 'codex', model: 'gpt-5.6-luna', adventurerId: 'codex-luna', state: 'bounced', bounceUntil: 'Sep 18, 2026 1:54 PM', observedAt: '2026-09-13T10:00:00.000Z', dispatchedAt: '2026-09-13T10:00:00.000Z' }] };
    const during = effectiveRoster(roster, lanes, now)[1];
    assert.equal(during.status, 'limited');
    assert.match(during.derived.reason, /RUN-10 限额退回，Sep 18, 2026 1:54 PM 恢复/);
    const after = effectiveRoster(roster, lanes, Date.parse('2026-09-18T21:00:00.000Z'))[1];
    assert.equal(after.status, 'available', 'the dated reset is now parseable, so it expires like any other');
    assert.equal(after.derived.reason, '限额窗口已过，尚未验证可用', 'a passed dated reset is never repeated');
  });

  it('scopes file-lane evidence to its exact card and keeps manual statuses', () => {
    const result = effectiveRoster(roster, { packages: [], laneLimits: { codex: { since: '2026-09-13T11:05:00.000Z', at: '2026-09-13T11:05:00.000Z', until: '13:54', adventurerId: 'codex-luna' } } }, now);
    assert.equal(result[1].status, 'limited');
    assert.match(result[1].derived.reason, /codex 限额中，13:54 恢复/);
    assert.equal(result[2].status, 'paused');
    assert.equal(result[0].status, 'available');
    assert.equal(result[1].baseStatus, 'available');
    assert.equal(result[2].baseStatus, 'paused');
    assert.equal(effectiveRoster(roster, null, now)[0].baseStatus, 'available');
  });

  it('does not apply ambiguous lane evidence to any card, but gives matching cards a diagnostic', () => {
    const result = effectiveRoster(roster, { packages: [], laneLimits: { codex: { since: '2026-09-13T11:05:00.000Z', until: null } } }, now);
    assert.equal(result[1].status, 'available');
    assert.equal(result[2].status, 'paused');
    assert.equal(result[1].laneDiagnostics[0].code, 'quota_identity_unknown');
    assert.equal(result[1].laneDiagnostics[0].adventurerId, undefined);
  });

  it('keeps an old dispatch-time row limited when the bounce was observed now', () => {
    const row = { package: 'P-7', lane: 'agy', model: 'g', adventurerId: 'agy-gemini', state: 'bounced', bounceUntil: null, dispatchedAt: new Date(now - 6 * 3600 * 1000).toISOString() };
    assert.equal(effectiveRoster([{ ...roster[0], id: 'agy-gemini', lane: 'agy', model: 'g' }], { packages: [row], laneLimits: {} }, now)[0].status, 'limited');
  });

  it('clears only for a later success with the same exact card identity', () => {
    const bounced = { package: 'P-bounce', lane: 'codex', model: 'gpt-5.6-luna', adventurerId: 'codex-luna', state: 'bounced', observedAt: '2026-09-13T10:00:00.000Z' };
    const sameCard = { package: 'P-success', lane: 'codex', model: 'gpt-5.6-luna', adventurerId: 'codex-luna', state: 'delivered', observedAt: '2026-09-13T10:01:00.000Z' };
    const otherCard = { ...sameCard, package: 'P-other', adventurerId: 'codex-astra' };
    const card = [roster[1]];
    assert.equal(effectiveRoster(card, { packages: [bounced, sameCard], laneLimits: {} }, now)[0].status, 'available');
    assert.equal(effectiveRoster(card, { packages: [bounced, otherCard], laneLimits: {} }, now)[0].status, 'limited');
  });

  it('preserves manual limited, paused and disabled records and carries their reasons as base data', () => {
    const manual = [
      { id: 'limited', lane: 'codex', model: 'm', status: 'limited', statusReason: 'manual check' },
      { id: 'paused', lane: 'codex', model: 'm', status: 'paused', statusReason: 'cost' },
      { id: 'disabled', lane: 'codex', model: 'm', status: 'disabled', statusReason: 'retired' },
    ];
    const lanes = { packages: [{ package: 'P', lane: 'codex', model: 'm', adventurerId: 'limited', state: 'bounced' }], laneLimits: { codex: { until: null } } };
    const result = effectiveRoster(manual, lanes, now);
    assert.deepEqual(result.map((card) => [card.status, card.baseStatus, card.baseReason]), [['limited', 'limited', 'manual check'], ['paused', 'paused', 'cost'], ['disabled', 'disabled', 'retired']]);
  });

  it('reports the reset as unknown, never an invented date that drifts with the poll, when there is no real observation time (F1/N5)', () => {
    const row = {
      package: 'RUN-11', lane: 'codex', model: 'gpt-5.6-luna', adventurerId: 'codex-luna',
      state: 'bounced', bounceUntil: '1:54 PM',
      // Only a week-old dispatch time, never a real observation of the bounce itself — dispatchedAt is when
      // the worker was launched, not when it bounced, so it must not anchor the reset.
      dispatchedAt: '2026-09-13T08:00:00.000Z',
    };
    for (const hours of [0, 30, 240]) {
      const at = Date.parse('2026-09-13T12:00:00.000Z') + hours * 3600 * 1000;
      const during = effectiveRoster([roster[1]], { packages: [row], laneLimits: {} }, at)[0];
      assert.equal(during.status, 'limited', `+${hours}h: stays limited, never auto-recovers from an unknown reset`);
      assert.equal(during.derived.resetsAt, null, `+${hours}h: no invented reset date, unlike a poll-anchored guess that would move forward with each check`);
      assert.doesNotMatch(during.derived.reason, /\d{1,2}:\d{2}/, `+${hours}h: the reason carries no time when the reset is unknown`);
    }
  });

  it('honours a full or dated reset even with no real observation time, and recovers after it (F4)', () => {
    const lanes = { packages: [{ package: 'RUN-11', lane: 'codex', model: 'gpt-5.6-luna', adventurerId: 'codex-luna', state: 'bounced', bounceUntil: 'Sep 18, 2026 1:54 PM',
      // Only a week-old dispatch time, never a real observation — but a dated reset carries its own
      // calendar day and needs no anchor, unlike a bare clock time.
      dispatchedAt: '2026-09-13T08:00:00.000Z' }] };
    const before = effectiveRoster(roster, lanes, now)[1];
    assert.equal(before.status, 'limited');
    assert.notEqual(before.derived.resetsAt, null, 'a full/dated reset needs no observation time to anchor it, unlike a bare clock time');
    assert.match(before.derived.reason, /RUN-11 限额退回，Sep 18, 2026 1:54 PM 恢复/);
    const after = effectiveRoster(roster, lanes, Date.parse('2026-09-18T21:00:00.000Z'))[1];
    assert.equal(after.status, 'available', 'a known reset that F4 dropped would never have recovered; this one does');
  });

  it('anchors a time-only reset to a real observation time, and recovers once it has passed (N5)', () => {
    const observedAt = '2026-09-13T10:00:00.000Z';
    const row = {
      package: 'RUN-11', lane: 'codex', model: 'gpt-5.6-luna', adventurerId: 'codex-luna',
      state: 'bounced', bounceUntil: '1:54 PM', observedAt,
      // The stale, week-old dispatch time is present too, but observedAt — the real evidence timestamp —
      // must win as the calendar reference, not dispatchedAt and not the current poll.
      dispatchedAt: '2026-09-06T08:00:00.000Z',
    };
    const lanes = { packages: [row], laneLimits: {} };
    const during = effectiveRoster([roster[1]], lanes, Date.parse('2026-09-13T12:00:00.000Z'))[0];
    assert.equal(during.status, 'limited');
    assert.equal(during.derived.resetsAt, '2026-09-13T20:54:00.000Z', 'anchored to the real observation day, not the stale dispatch day');
    const after = effectiveRoster([roster[1]], lanes, Date.parse('2026-09-13T21:00:00.000Z'))[0];
    assert.equal(after.status, 'available', 'recovers once the real observation-anchored reset has passed');
  });

  it('shows a duplicated ambiguous-evidence diagnostic once, keyed by code and text (N4)', () => {
    const lanes = {
      packages: [{ package: 'RUN-20', lane: 'codex', model: 'gpt-5.6-luna', state: 'bounced', observedAt: '2026-09-16T09:00:00.000Z' }],
      laneLimits: { codex: { until: null, unidentified: [{ at: '2026-09-16T09:05:00.000Z', model: 'gpt-5.6-luna' }] } },
    };
    const result = effectiveRoster([roster[1]], lanes, now);
    assert.equal(result[0].laneDiagnostics.length, 1, 'two ambiguous entries for the same lane collapse into one notice');
  });

  it('splits cleared into owner, success and expired instead of one blurred owner marker (N16)', () => {
    const at = '2026-09-16T10:00:00.000Z';
    const laneLimits = {
      codex: {
        cards: {
          'owner-card': { adventurerId: 'owner-card', at, since: at, until: null, resetsAt: null, name: 'a' },
          'success-card': { adventurerId: 'success-card', at, since: at, until: null, resetsAt: null, name: 'b' },
          'expired-card': { adventurerId: 'expired-card', at, since: at, until: '11:00 AM', resetsAt: '2026-09-16T11:00:00.000Z', name: 'c' },
        },
      },
    };
    const cardRoster = [
      { id: 'owner-card', status: 'available', statusSetBy: 'owner', statusSince: '2026-09-16T10:30:00.000Z' },
      { id: 'success-card', status: 'available' },
      { id: 'expired-card', status: 'available' },
    ];
    const later = Date.parse('2026-09-16T12:00:00.000Z');
    const result = visibleLaneLimits(laneLimits, cardRoster, {}, later);
    assert.deepEqual(result.laneLimits, {}, 'none of the three cards are still limited');
    assert.equal(result.laneEvidence.codex.cards['owner-card'].cleared, 'owner');
    assert.equal(result.laneEvidence.codex.cards['success-card'].cleared, 'success');
    assert.equal(result.laneEvidence.codex.cards['expired-card'].cleared, 'expired');
  });

  it('drops a stale `until` when a manual re-limit supersedes the evidence it kept, but keeps a fresher one (N18)', () => {
    const bounceAt = '2026-09-16T09:00:00.000Z';
    const laneLimits = {
      codex: {
        cards: {
          'codex-luna': { adventurerId: 'codex-luna', at: bounceAt, since: bounceAt, until: 'Sep 18th, 2026 1:54 PM', resetsAt: '2026-09-18T13:54:00.000Z', name: 'a' },
        },
      },
    };
    const later = Date.parse('2026-09-16T12:00:00.000Z');

    const staleRoster = [{ id: 'codex-luna', status: 'limited', statusSetBy: 'owner', statusSince: '2026-09-16T10:00:00.000Z' }];
    const stale = visibleLaneLimits(laneLimits, staleRoster, {}, later);
    const kept = stale.laneLimits.codex.cards['codex-luna'];
    assert.equal(kept.until, null, 'the bounce\'s own recovery time is dropped once a manual re-limit supersedes it');
    assert.equal(kept.resetsAt, null);
    assert.match(kept.reason, /手动设为限额/);
    assert.equal(stale.laneLimits.codex.until, null, 'the lane header drops the stale time too');

    const freshRoster = [{ id: 'codex-luna', status: 'limited', statusSetBy: 'owner', statusSince: '2026-09-16T08:00:00.000Z' }];
    const fresh = visibleLaneLimits(laneLimits, freshRoster, {}, later);
    assert.equal(fresh.laneLimits.codex.cards['codex-luna'].until, 'Sep 18th, 2026 1:54 PM', 'a manual limit that predates the evidence never clears it');
  });

  it('keeps an unidentified legacy top-level lane-limit entry as named evidence instead of dropping it (N19)', () => {
    const laneLimits = { codex: { since: '2026-09-16T09:00:00.000Z', at: '2026-09-16T09:00:00.000Z', until: '13:54', resetsAt: null, name: 'legacy' } };
    const result = visibleLaneLimits(laneLimits, [], {}, now);
    assert.deepEqual(result.laneLimits, {});
    assert.equal(result.laneEvidence.codex.cards && Object.keys(result.laneEvidence.codex.cards).length, 0);
    const [entry] = result.laneEvidence.codex.unidentified;
    assert.equal(entry.name, 'legacy');
    assert.match(entry.note, /旧格式限额记录/);
    assert.match(entry.note, /codex/);
  });

  it('is a fixed point of its own output across every cleared kind — owner, success and expired, not just one owner fixture (F2/N8)', () => {
    const acknowledgedAt = '2026-09-16T11:00:00.000Z';
    const ownerAt = '2026-09-16T10:00:00.000Z';
    const ownerEntry = { adventurerId: 'codex-luna', at: ownerAt, since: ownerAt, until: null, resetsAt: null, name: 'luna-a1' };

    const bounceAt = '2026-09-16T08:00:00.000Z';
    const successAt = '2026-09-16T08:30:00.000Z';
    const successEntry = { adventurerId: 'codex-nova', at: bounceAt, since: bounceAt, until: null, resetsAt: null, name: 'nova-run' };

    const expiredAt = '2026-09-16T08:00:00.000Z';
    const expiredEntry = { adventurerId: 'codex-vega', at: expiredAt, since: expiredAt, until: '09:00 AM', resetsAt: '2026-09-16T09:00:00.000Z', name: 'vega-run' };

    const fixtures = [
      {
        label: 'owner: a status-log record after the evidence acknowledges the card',
        at: now,
        rosterInput: [{ id: 'codex-luna', lane: 'codex', model: 'gpt-5.6-luna', status: 'available', statusSetBy: 'owner', statusSince: acknowledgedAt }],
        lanes: { packages: [], laneLimits: { codex: { ...ownerEntry, cards: { 'codex-luna': ownerEntry } } } },
      },
      {
        label: 'success: a later delivered run by the same card clears it',
        at: Date.parse('2026-09-16T09:00:00.000Z'),
        rosterInput: [{ id: 'codex-nova', lane: 'codex', model: 'gpt-5.6-nova', status: 'available' }],
        lanes: {
          packages: [{ package: 'P-nova-2', lane: 'codex', model: 'gpt-5.6-nova', adventurerId: 'codex-nova', state: 'delivered', observedAt: successAt }],
          laneLimits: { codex: { ...successEntry, cards: { 'codex-nova': successEntry } } },
        },
      },
      {
        label: 'expired: the entry\'s own known reset has passed with no acknowledgement (F2 regression)',
        at: Date.parse('2026-09-16T10:00:00.000Z'),
        rosterInput: [{ id: 'codex-vega', lane: 'codex', model: 'gpt-5.6-vega', status: 'available' }],
        lanes: { packages: [], laneLimits: { codex: { ...expiredEntry, cards: { 'codex-vega': expiredEntry } } } },
      },
    ];

    for (const { label, at, rosterInput, lanes } of fixtures) {
      const roster1 = effectiveRoster(rosterInput, lanes, at);
      const visible1 = visibleLaneLimits(lanes.laneLimits, roster1, lanes.laneEvidence || {}, at);

      const lanes2 = { packages: [], laneLimits: visible1.laneLimits, laneEvidence: visible1.laneEvidence };
      const roster2 = effectiveRoster(rosterInput, lanes2, at);
      const visible2 = visibleLaneLimits(lanes2.laneLimits, roster2, lanes2.laneEvidence, at);

      assert.deepEqual(roster2, roster1, `${label}: the same roster comes back when the overlay's own output is fed back in`);
      assert.deepEqual(visible2, visible1, `${label}: the same laneLimits/laneEvidence come back on the second pass`);
    }
  });
});
