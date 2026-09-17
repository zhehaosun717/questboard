import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdventurer, validateRoster } from '../../src/core/roster.js';

const base = {
  id: 'test-card',
  name: '测试卡',
  provider: '测试服务商',
  lane: 'codex',
  model: 'test-model',
  family: 'test-family',
};

describe('roster variants', () => {
  it('keeps the optional field absent, accepts an empty declaration, and accepts unique values', () => {
    assert.equal(validateAdventurer({ ...base }).variants, undefined);
    assert.deepEqual(validateAdventurer({ ...base, variants: [] }).variants, []);
    assert.deepEqual(validateRoster({ adventurers: [{ ...base, variants: ['low', 'high'] }] }).adventurers[0].variants, ['low', 'high']);
  });

  it('fails loudly with variants named for malformed declarations', () => {
    for (const variants of ['high', [1], [''], ['  '], [' high'], ['high '], ['high', 'high']]) {
      assert.throws(() => validateAdventurer({ ...base, variants }), /variants/);
    }
  });

  it('rejects variant entries whose trimmed form differs from the value', () => {
    assert.throws(
      () => validateAdventurer({ ...base, variants: [' high'] }),
      (err) => err.message.includes('variants') && /leading or trailing whitespace/.test(err.message),
    );
    assert.throws(
      () => validateAdventurer({ ...base, variants: ['low', 'high '] }),
      (err) => err.message.includes('variants') && /leading or trailing whitespace/.test(err.message),
    );
  });
});
