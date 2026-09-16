// Focused tests for lanes.<id>.optionalArgs (config.js validation + fillOptionalArgs) and its use in
// dispatch.js's planDispatch. Deliberately does not touch test/helpers.js: its own small fixtures only, so
// this file stays disjoint from other in-flight work on the shared dispatch/dispatcher test fixtures.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, saveProjectConfig, readRawConfig, fillTemplate, fillOptionalArgs } from '../../src/core/config.js';
import { planDispatch, preflight, executePlan } from '../../src/core/dispatch.js';

// Its own tmp dir helper, not test/helpers.js's: same reason as the file-level comment above.
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qb-optionalargs-'));

// No {variant} in run itself: most tests below make {variant} optional, and run already requiring it too
// would be the T5 "required and optional at once" contradiction that has its own dedicated tests further
// down (those build their own run array with {variant} explicitly included).
const baseRun = ['tools/codex-run.sh', '{name}', '{brief}', '{model}'];

// A lane whose {variant} is *not* required in run (matching decision 2: absent must stay legal), with an
// optional --effort group appended by default, so most tests only need to vary the group's own fields.
function laneWithOptionalEffort(overrides = {}) {
  return resolveConfig('E:/g', {
    name: 'G',
    lanes: {
      codex: {
        run: ['tools/codex-run.sh', '{name}', '{brief}', '{model}'],
        outputDir: '.work/codex',
        optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], ...overrides }],
      },
    },
  }).lanes.codex;
}

const values = (variant) => ({ name: 'n1', brief: 'docs/briefs/x.md', model: 'm1', variant, agent: undefined, package: 'PKG-1' });

describe('lanes.<id>.optionalArgs — config validation', () => {
  it('a lane without optionalArgs is unaffected: no field, and fillOptionalArgs is a byte-for-byte no-op', () => {
    const lane = resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex' } } }).lanes.codex;
    assert.equal(lane.optionalArgs, undefined);
    assert.equal(fillOptionalArgs(lane.run, lane.optionalArgs, values('high')), lane.run, 'same array reference back, not just an equal copy');
  });

  it('an empty optionalArgs array behaves the same as omitting the field', () => {
    const lane = resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [] } } }).lanes.codex;
    assert.deepEqual(lane.optionalArgs, []);
    assert.deepEqual(fillOptionalArgs(lane.run, lane.optionalArgs, values('high')), lane.run);
  });

  it('rejects an unknown when, missing {when} in args, and a non-array/empty args list', () => {
    const make = (group) => () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [group] } } });
    assert.throws(make({ when: 'model', args: ['--x', '{model}'] }), /optionalArgs\[0\]\.when must be one of/);
    assert.throws(make({ when: 'variant', args: ['--effort', 'high'] }), /optionalArgs\[0\]\.args must use \{variant\}/);
    assert.throws(make({ when: 'variant', args: [] }), /optionalArgs\[0\]\.args must be a non-empty array/);
    assert.throws(make({ when: 'variant', args: ['--effort', 1] }), /optionalArgs\[0\]\.args must be a non-empty array of strings/);
    assert.throws(make({ when: 'variant', args: ['--effort', '{nmae}'] }), /unknown placeholder \{nmae\}/);
  });

  it('rejects insertAt out of range, including 0 (position 0 is always the lane\'s own command)', () => {
    const make = (insertAt) => () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], insertAt }] } } });
    assert.throws(make(0), /insertAt must be an integer between 1 and 4/);
    assert.throws(make(5), /insertAt must be an integer between 1 and 4/);
    assert.throws(make(-1), /insertAt must be an integer between 1 and 4/);
    assert.throws(make(2.5), /insertAt must be an integer between 1 and 4/);
    assert.doesNotThrow(make(1));
    assert.doesNotThrow(make(4));
  });

  it('rejects a duplicate omitWhen value and a whitespace-only one (ambiguous configuration, not a real argv value)', () => {
    const make = (omitWhen) => () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], omitWhen }] } } });
    assert.throws(make(['none', 'none']), /omitWhen must not repeat a value/);
    assert.throws(make(['none', '   ']), /omitWhen must be an array of non-empty strings/);
    assert.doesNotThrow(make(['none', 'off']));
  });

  it('rejects {when} required in run and also declared optional at the same time (T5)', () => {
    assert.throws(
      () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: [...baseRun, '{variant}'], outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'] }] } } }),
      /optionalArgs makes \{variant\} optional, but lanes\.codex\.run still requires it/,
    );
  });

  it('rejects {when} optional in run but still required in session.run, session.saveTo, or env (T4/T5, named per surface)', () => {
    const run = ['tools/oc-send.sh', '{name}'];
    const withSessionRun = { run, session: { run: ['node', 'tools/oc.js', 'new', '{variant}'], saveTo: '.work/oc_{name}.txt' }, api: 'http://oc.test', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'] }] };
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes: { oc: withSessionRun } }), /lanes\.oc\.session\.run still requires it/);

    const withSaveTo = { run, session: { run: ['node', 'tools/oc.js', 'new'], saveTo: '.work/oc_{variant}.txt' }, api: 'http://oc.test', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'] }] };
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes: { oc: withSaveTo } }), /lanes\.oc\.session\.saveTo still requires it/);

    const withEnv = { run, outputDir: '.work/oc', env: { OC_VARIANT: '{variant}' }, optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'] }] };
    assert.throws(() => resolveConfig('E:/g', { name: 'G', lanes: { oc: withEnv } }), /lanes\.oc\.env still requires it/);
  });

  it('insertAt default is run.length (append), and run itself is untouched by adding optionalArgs', () => {
    const lane = resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'] }] } } }).lanes.codex;
    assert.equal(lane.optionalArgs[0].insertAt, 4);
    assert.deepEqual(lane.run, baseRun);
  });

  it('rejects insertAt 1 for a node lane: resolveCommand reads command[1] as node\'s own script, so the lowest legal position there is 2, not 1', () => {
    const nodeRun = ['node', 'tools/w.js', '{name}'];
    const make = (insertAt) => () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: nodeRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], insertAt }] } } });
    assert.throws(make(1), /insertAt must be an integer between 2 and 3 \(position 0 is always node, position 1 is always its script\)/);
    assert.throws(make(0), /insertAt must be an integer between 2 and 3/);
    assert.doesNotThrow(make(2));
    assert.doesNotThrow(make(3));
    // A non-node lane keeps the original minimum of 1 — this is a node-specific narrowing, not a global change.
    assert.doesNotThrow(() => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], insertAt: 1 }] } } }));
  });

  it('rejects an optionalArgs group with an unknown field (e.g. a misspelled omitwhen), while a top-level unknown config field is preserved on save', () => {
    assert.throws(
      () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], omitwhen: ['none'] }] } } }),
      /optionalArgs\[0\] has unknown field omitwhen; allowed: when, args, omitWhen, insertAt/,
      'a misspelled key inside a group must be refused, not silently ignored while still sending --effort none',
    );
    assert.throws(
      () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], extra: true }] } } }),
      /optionalArgs\[0\] has unknown field extra/,
    );

    // Preserving a top-level unknown field is the existing, unrelated behaviour (saveProjectConfig writes the
    // raw file back verbatim) — this just confirms adding optionalArgs group validation did not narrow it.
    const root = tmpDir();
    const raw = { name: 'G', someFutureField: { kept: true }, lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'] }] } } };
    saveProjectConfig(root, raw);
    assert.deepEqual(readRawConfig(root).someFutureField, { kept: true });
  });
});

describe('lanes.<id>.optionalArgs — bounded inputs', () => {
  const manyGroups = (count) => Array.from({ length: count }, (_, i) => ({ when: 'variant', args: [`--e${i}`, '{variant}'] }));

  it('rejects more than 20 optionalArgs groups on one lane', () => {
    assert.doesNotThrow(() => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: manyGroups(20) } } }));
    assert.throws(
      () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: manyGroups(21) } } }),
      /optionalArgs must have at most 20 groups/,
    );
  });

  it('rejects more than 20 args elements in one group', () => {
    const args = (count) => ['{variant}', ...Array.from({ length: count - 1 }, (_, i) => `--e${i}`)];
    assert.doesNotThrow(() => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: args(20) }] } } }));
    assert.throws(
      () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: args(21) }] } } }),
      /optionalArgs\[0\]\.args must have at most 20 elements/,
    );
  });

  it('rejects more than 20 omitWhen entries in one group', () => {
    const omitWhen = (count) => Array.from({ length: count }, (_, i) => `v${i}`);
    assert.doesNotThrow(() => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], omitWhen: omitWhen(20) }] } } }));
    assert.throws(
      () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], omitWhen: omitWhen(21) }] } } }),
      /optionalArgs\[0\]\.omitWhen must have at most 20 entries/,
    );
  });

  it('rejects an args element or an omitWhen entry longer than 4096 characters', () => {
    const long = (n) => 'x'.repeat(n);
    assert.doesNotThrow(() => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}', long(4096)] }] } } }));
    assert.throws(
      () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}', long(4097)] }] } } }),
      /optionalArgs\[0\]\.args elements must be at most 4096 characters/,
    );
    assert.throws(
      () => resolveConfig('E:/g', { name: 'G', lanes: { codex: { run: baseRun, outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], omitWhen: [long(4097)] }] } } }),
      /optionalArgs\[0\]\.omitWhen entries must be at most 4096 characters/,
    );
  });
});

describe('fillOptionalArgs — fill/drop semantics', () => {
  const run = ['tools/x.sh', '{name}'];

  it('drops the whole group (flag and value) when the controlling value is absent, undefined, or null', () => {
    const group = { when: 'variant', args: ['--effort', '{variant}'], omitWhen: [], insertAt: 2 };
    for (const variant of ['', undefined, null]) {
      assert.deepEqual(fillOptionalArgs(run, [group], { name: 'n', variant }), run, `variant=${JSON.stringify(variant)}`);
    }
  });

  it('never leaves a bare "" element behind when a group is dropped', () => {
    const group = { when: 'variant', args: ['--effort', '{variant}'], omitWhen: [], insertAt: 2 };
    const out = fillOptionalArgs(run, [group], { name: 'n', variant: '' });
    assert.ok(!out.includes(''), JSON.stringify(out));
  });

  it('a whitespace-only value is a real value, not absent — it is not trimmed and is not silently dropped', () => {
    const group = { when: 'variant', args: ['--effort', '{variant}'], omitWhen: [], insertAt: 2 };
    const out = fillOptionalArgs(run, [group], { name: 'n', variant: '   ' });
    assert.deepEqual(out, ['tools/x.sh', '{name}', '--effort', '{variant}']);
    assert.deepEqual(fillTemplate(out, { name: 'n', variant: '   ' }), ['tools/x.sh', 'n', '--effort', '   '], 'the space-only value survives fillTemplate exactly, uncollapsed');
  });

  it('a literal "none"/"default"/"off"/"minimal" value passes through unchanged unless the lane explicitly lists it in omitWhen', () => {
    const group = { when: 'variant', args: ['--effort', '{variant}'], omitWhen: [], insertAt: 2 };
    for (const variant of ['none', 'default', 'off', 'minimal']) {
      const out = fillTemplate(fillOptionalArgs(run, [group], { name: 'n', variant }), { name: 'n', variant });
      assert.deepEqual(out, ['tools/x.sh', 'n', '--effort', variant], variant);
    }
  });

  it('omitWhen drops the group only on an exact match; unlisted values, even similar ones, pass through', () => {
    const group = { when: 'variant', args: ['--effort', '{variant}'], omitWhen: ['none'], insertAt: 2 };
    assert.deepEqual(fillOptionalArgs(run, [group], { name: 'n', variant: 'none' }), run, 'exact match drops the group');
    assert.deepEqual(
      fillTemplate(fillOptionalArgs(run, [group], { name: 'n', variant: 'off' }), { name: 'n', variant: 'off' }),
      ['tools/x.sh', 'n', '--effort', 'off'],
      'off is not none, so it passes through even though this lane declared an omitWhen list',
    );
  });

  it('inserts filled args at insertAt, and a value with spaces and quotes survives as one exact argv element (no join/split)', () => {
    const group = { when: 'variant', args: ['--effort', '{variant}'], omitWhen: [], insertAt: 1 };
    const withVariant = { name: 'n', variant: 'a b "c"' };
    const out = fillTemplate(fillOptionalArgs(run, [group], withVariant), withVariant);
    assert.deepEqual(out, ['tools/x.sh', '--effort', 'a b "c"', 'n']);
  });

  it('keeps declared order for two groups sharing the same insertAt, each landing after the previous one', () => {
    const groups = [
      { when: 'variant', args: ['--effort', '{variant}'], omitWhen: [], insertAt: 1 },
      { when: 'agent', args: ['--agent', '{agent}'], omitWhen: [], insertAt: 1 },
    ];
    const vals = { name: 'n', variant: 'high', agent: 'build' };
    assert.deepEqual(fillTemplate(fillOptionalArgs(run, groups, vals), vals), ['tools/x.sh', '--effort', 'high', '--agent', 'build', 'n']);
  });

  it('a group whose own value is absent is skipped without disturbing a later group at a higher insertAt', () => {
    const groups = [
      { when: 'variant', args: ['--effort', '{variant}'], omitWhen: [], insertAt: 1 },
      { when: 'agent', args: ['--agent', '{agent}'], omitWhen: [], insertAt: 2 },
    ];
    const vals = { name: 'n', variant: '', agent: 'build' };
    assert.deepEqual(fillTemplate(fillOptionalArgs(run, groups, vals), vals), ['tools/x.sh', 'n', '--agent', 'build']);
  });

  it('other placeholders inside a kept group (e.g. {name}) remain as strictly required as any other template placeholder', () => {
    const group = { when: 'variant', args: ['--effort', '{variant}', '--for', '{name}'], omitWhen: [], insertAt: 1 };
    assert.throws(() => fillTemplate(fillOptionalArgs(run, [group], { variant: 'high' }), { variant: 'high' }), /needs \{name\}/);
  });

  it('a required placeholder missing elsewhere in run is still refused even when optionalArgs groups exist', () => {
    assert.throws(() => fillTemplate(fillOptionalArgs(['x', '{model}'], [{ when: 'variant', args: ['--effort', '{variant}'], omitWhen: [], insertAt: 2 }], { variant: 'high' }), { variant: 'high' }), /needs \{model\}/);
  });
});

describe('planDispatch integration', () => {
  it('fills an optionalArgs lane end to end, appended by default, dropped when variant is absent', () => {
    const config = resolveConfig('E:/g', {
      name: 'G',
      lanes: { codex: { run: ['tools/codex-run.sh', '{name}', '{brief}', '{model}'], outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'] }] } },
    });
    const quest = { id: 'RUN-1', brief: 'docs/briefs/RUN-1-x.md' };
    const withVariant = planDispatch(config, quest, { lane: 'codex', model: 'm1', variant: 'high' }, 'n1');
    assert.deepEqual(withVariant[0].command, ['tools/codex-run.sh', 'n1', quest.brief, 'm1', '--effort', 'high']);
    const withoutVariant = planDispatch(config, quest, { lane: 'codex', model: 'm1' }, 'n1');
    assert.deepEqual(withoutVariant[0].command, ['tools/codex-run.sh', 'n1', quest.brief, 'm1'], 'no card variant, no {variant} required, and the flag+value group is dropped whole');
  });

  it('inserts an optionalArgs group mid-command, not only at the end', () => {
    const lane = laneWithOptionalEffort({ insertAt: 1 });
    const config = { root: 'E:/g', lanes: { codex: lane } };
    const quest = { id: 'RUN-2', brief: 'docs/briefs/RUN-2-x.md' };
    const steps = planDispatch(config, quest, { lane: 'codex', model: 'm1', variant: 'high' }, 'n2');
    assert.deepEqual(steps[0].command, ['tools/codex-run.sh', '--effort', 'high', 'n2', quest.brief, 'm1']);
  });

  it('a node lane keeps its script at command[1] with and without a variant (the fixed node insertAt bug)', () => {
    const config = resolveConfig('E:/g', {
      name: 'G',
      lanes: { codex: { run: ['node', 'tools/w.js', '{name}'], outputDir: '.work/codex', optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], insertAt: 2 }] } },
    });
    const quest = { id: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md' };
    const withVariant = planDispatch(config, quest, { lane: 'codex', model: 'm1', variant: 'high' }, 'n5');
    assert.deepEqual(withVariant[0].command, ['node', 'tools/w.js', '--effort', 'high', 'n5']);
    assert.throws(() => preflight({ root: 'E:/g-does-not-exist' }, withVariant), /缺少派遣脚本 tools\/w\.js/, 'resolveCommand still reads command[1] as the script, not the inserted --effort flag');

    const withoutVariant = planDispatch(config, quest, { lane: 'codex', model: 'm1' }, 'n5');
    assert.deepEqual(withoutVariant[0].command, ['node', 'tools/w.js', 'n5'], 'no card variant: the group is dropped whole, script stays at command[1]');
    assert.throws(() => preflight({ root: 'E:/g-does-not-exist' }, withoutVariant), /缺少派遣脚本 tools\/w\.js/);
  });

  it('preflight and executePlan still work unchanged on a lane with optionalArgs (existing dispatch contract, e.g. neverStarted)', async () => {
    const lane = laneWithOptionalEffort();
    const config = { root: 'E:/g-does-not-exist', lanes: { codex: lane } };
    const quest = { id: 'RUN-3', brief: 'docs/briefs/RUN-3-x.md' };
    const plan = planDispatch(config, quest, { lane: 'codex', model: 'm1', variant: 'high' }, 'n3');
    assert.throws(() => preflight(config, plan), /缺少派遣脚本/, 'preflight still finds the real script name at command[0], not an inserted flag');

    const result = await executePlan({ ...config, paths: { data: 'E:/g-does-not-exist/.questboard-data' } }, plan, { name: 'n3', runners: { run: async () => { throw new Error('boom'); } } });
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'launching');
  });
});
