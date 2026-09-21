// FB2-07 item 2: opencode models --verbose import — capability filter, EOL marking, nothing silently dropped.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpencodeModelsVerbose, planOpencodeImport } from '../../src/core/rosterImport.js';

const rec = (over = {}) => ({
  id: 'm1', providerID: 'opencode', name: 'M One', family: 'm',
  api: { id: 'm1', url: 'https://example.test/v1' },
  status: 'active',
  cost: { input: 0, output: 0 },
  capabilities: { toolcall: true, input: { text: true }, output: { text: true } },
  ...over,
});
const verbose = (records) => records.map((r) => `${r.providerID}/${r.id}\n${JSON.stringify(r, null, 2)}`).join('\n');

describe('parseOpencodeModelsVerbose (FB2-07)', () => {
  it('parses header+JSON blocks into model records', () => {
    const models = parseOpencodeModelsVerbose(verbose([rec(), rec({ id: 'm2', name: 'M Two' })]));
    assert.equal(models.length, 2);
    assert.equal(models[1].id, 'm2');
  });
  it('fails loudly on text that holds no model records instead of importing nothing quietly', () => {
    assert.throws(() => parseOpencodeModelsVerbose('not json at all'), /没有解析到任何模型/);
  });
});

describe('planOpencodeImport (FB2-07)', () => {
  it('keeps text-in/text-out tool-call models as verified ok; zero-cost reads free, priced reads metered', () => {
    const plan = planOpencodeImport({ models: [rec(), rec({ id: 'paid', cost: { input: 2, output: 8 } })], lane: 'oc' });
    assert.equal(plan.kept.length, 2);
    assert.equal(plan.kept[0].verified, 'ok');
    assert.equal(plan.kept[0].billing, 'free');
    assert.equal(plan.kept[1].billing, 'metered');
    assert.equal(plan.kept[0].lane, 'oc');
    assert.equal(plan.filteredOut.length, 0);
  });

  it('with the filter on, a non-tool model is dropped and counted, never silently', () => {
    const imageOnly = rec({ id: 'img', capabilities: { toolcall: false, input: { text: true }, output: { image: true } } });
    const plan = planOpencodeImport({ models: [rec(), imageOnly], lane: 'oc' });
    assert.equal(plan.kept.length, 1);
    assert.deepEqual(plan.filteredOut, ['img']);
    const noFilter = planOpencodeImport({ models: [rec(), imageOnly], lane: 'oc', filter: false });
    assert.equal(noFilter.kept.length, 2, '--no-filter keeps it');
  });

  it('unparseable capabilities keep the card but mark it unverified', () => {
    const capsGone = rec({ id: 'mystery' });
    delete capsGone.capabilities;
    const plan = planOpencodeImport({ models: [capsGone], lane: 'oc' });
    assert.equal(plan.kept.length, 1, 'not dropped');
    assert.equal(plan.kept[0].verified, 'unverified');
  });

  it('a retired model imports as broken, not as a healthy card', () => {
    const eol = rec({ id: 'old', status: 'deprecated' });
    const plan = planOpencodeImport({ models: [eol], lane: 'oc' });
    assert.equal(plan.kept[0].verified, 'broken');
  });

  it('card ids sanitize to the roster pattern and carry name/family/model', () => {
    const weird = rec({ id: 'Kimi K2.5 (Turbo)', name: 'Kimi K2.5', family: 'kimi' });
    const plan = planOpencodeImport({ models: [weird], lane: 'oc' });
    assert.match(plan.kept[0].id, /^[a-z0-9-]{1,48}$/);
    assert.equal(plan.kept[0].model, 'Kimi K2.5 (Turbo)');
    assert.equal(plan.kept[0].family, 'kimi');
    assert.equal(plan.kept[0].name, 'Kimi K2.5');
  });
});
