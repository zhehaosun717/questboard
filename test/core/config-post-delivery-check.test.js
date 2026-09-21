// FB2-05 item 1: policy.postDeliveryCheck — the self-check a worker's delivery must pass before the
// board writes delivered. Validation is at config load: a broken check fails startup, loudly.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/core/config.js';
import { tmpDir, LANES } from '../helpers.js';

const resolve = (policy) => resolveConfig(tmpDir('qb-cfg-pdc-'), { name: 'Pdc', lanes: LANES, ...(policy !== undefined ? { policy } : {}) });

describe('policy.postDeliveryCheck (FB2-05)', () => {
  it('is absent by default', () => {
    assert.equal(resolve(undefined).policy.postDeliveryCheck, null);
  });

  it('accepts a full valid config and defaults maxRounds to 2', () => {
    const check = resolve({ postDeliveryCheck: { run: ['npm', 'test'], timeoutMs: 60000, failPattern: 'FAIL|Error' } }).policy.postDeliveryCheck;
    assert.deepEqual(check.run, ['npm', 'test']);
    assert.equal(check.timeoutMs, 60000);
    assert.equal(check.failPattern, 'FAIL|Error');
    assert.equal(check.maxRounds, 2);
  });

  it('refuses each missing or broken field and says which', () => {
    assert.throws(() => resolve({ postDeliveryCheck: { timeoutMs: 1000, failPattern: 'x' } }), /postDeliveryCheck\.run/);
    assert.throws(() => resolve({ postDeliveryCheck: { run: [], timeoutMs: 1000, failPattern: 'x' } }), /postDeliveryCheck\.run/);
    assert.throws(() => resolve({ postDeliveryCheck: { run: ['npm', ''], timeoutMs: 1000, failPattern: 'x' } }), /postDeliveryCheck\.run/);
    assert.throws(() => resolve({ postDeliveryCheck: { run: 'npm test', timeoutMs: 1000, failPattern: 'x' } }), /postDeliveryCheck\.run/);
    assert.throws(() => resolve({ postDeliveryCheck: { run: ['npm'], failPattern: 'x' } }), /postDeliveryCheck\.timeoutMs/);
    assert.throws(() => resolve({ postDeliveryCheck: { run: ['npm'], timeoutMs: 0, failPattern: 'x' } }), /postDeliveryCheck\.timeoutMs/);
    assert.throws(() => resolve({ postDeliveryCheck: { run: ['npm'], timeoutMs: 1000 } }), /postDeliveryCheck\.failPattern/);
    assert.throws(() => resolve({ postDeliveryCheck: { run: ['npm'], timeoutMs: 1000, failPattern: '([' } }), /postDeliveryCheck\.failPattern/);
    assert.throws(() => resolve({ postDeliveryCheck: { run: ['npm'], timeoutMs: 1000, failPattern: 'x', maxRounds: 0 } }), /postDeliveryCheck\.maxRounds/);
    assert.throws(() => resolve({ postDeliveryCheck: { run: ['npm'], timeoutMs: 1000, failPattern: 'x', maxRounds: 6 } }), /postDeliveryCheck\.maxRounds/);
  });

  it('refuses unknown keys instead of silently ignoring a typo', () => {
    assert.throws(() => resolve({ postDeliveryCheck: { run: ['npm'], timeoutMs: 1000, failPattern: 'x', timeout: 5 } }), /postDeliveryCheck\.timeout/);
  });
});
