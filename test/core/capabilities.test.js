import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/core/config.js';
import { validateAdventurer } from '../../src/core/roster.js';
import { tmpDir, LANES } from '../helpers.js';

// FB2-03 items 30/31: cards and lanes declare what they can run; quests may demand capabilities.
const card = {
  id: 'cap-card', name: '能力卡', provider: 'test', model: 'm1', family: 'fam', lane: 'codex',
};

describe('capabilities (FB2-03)', () => {
  it('accepts a card capabilities list and refuses junk', () => {
    validateAdventurer({ ...card, capabilities: ['runs-node', 'web'] });
    for (const bad of ['runs-node', [42], '']) {
      assert.throws(() => validateAdventurer({ ...card, capabilities: bad }), /capabilities/);
    }
  });

  it('resolves lane capabilities and probes; refuses junk shapes', () => {
    const root = tmpDir('qb-cfg-caps-');
    const lane = { ...LANES.codex, capabilities: ['runs-node'], probes: { 'runs-node': ['node', '--version'] } };
    const good = resolveConfig(root, { name: 'Caps', lanes: { codex: lane } });
    assert.deepEqual(good.lanes.codex.capabilities, ['runs-node']);
    assert.deepEqual(good.lanes.codex.probes, { 'runs-node': ['node', '--version'] });
    assert.throws(() => resolveConfig(root, { name: 'Caps', lanes: { codex: { ...lane, capabilities: 'runs-node' } } }), /capabilities/);
    assert.throws(() => resolveConfig(root, { name: 'Caps', lanes: { codex: { ...lane, probes: { 'runs-node': 'node --version' } } } }), /probes/);
    assert.throws(() => resolveConfig(root, { name: 'Caps', lanes: { codex: { ...lane, probes: { 'runs-node': [] } } } }), /probes/);
  });

  it('a lane without the new fields resolves exactly as before', () => {
    const root = tmpDir('qb-cfg-nocaps-');
    const plain = resolveConfig(root, { name: 'Caps', lanes: LANES });
    assert.equal(plain.lanes.codex.capabilities, undefined);
    assert.equal(plain.lanes.codex.probes, undefined);
  });
});
