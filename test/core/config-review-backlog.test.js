// FB2-04 item 4: policy.reviewBacklogRedAfterHours — the check column's red-line wait threshold.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/core/config.js';
import { tmpDir, LANES } from '../helpers.js';

const resolve = (policy) => resolveConfig(tmpDir('qb-cfg-backlog-'), { name: 'Backlog', lanes: LANES, ...(policy !== undefined ? { policy } : {}) });

describe('policy.reviewBacklogRedAfterHours (FB2-04)', () => {
  it('defaults to 12 hours', () => {
    assert.equal(resolve(undefined).policy.reviewBacklogRedAfterHours, 12);
    assert.equal(resolve({}).policy.reviewBacklogRedAfterHours, 12);
  });
  it('accepts a positive integer', () => {
    assert.equal(resolve({ reviewBacklogRedAfterHours: 48 }).policy.reviewBacklogRedAfterHours, 48);
  });
  it('refuses zero, negatives, fractions and non-numbers, saying why', () => {
    for (const bad of [0, -1, 1.5, '12']) {
      assert.throws(() => resolve({ reviewBacklogRedAfterHours: bad }), /policy\.reviewBacklogRedAfterHours must be a positive integer/, JSON.stringify(bad));
    }
  });
});
