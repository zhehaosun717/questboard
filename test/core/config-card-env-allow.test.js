import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/core/config.js';
import { tmpDir, LANES } from '../helpers.js';

const resolve = (policy) => resolveConfig(tmpDir('qb-cfg-allow-'), { name: 'Allow', lanes: LANES, policy });

describe('policy.cardEnvAllow', () => {
  it('defaults to an empty list, and an unrelated policy resolves the same as before', () => {
    assert.deepEqual(resolve(undefined).policy.cardEnvAllow, []);
    assert.deepEqual(resolve({ bannedAgents: ['X'] }).policy.cardEnvAllow, []);
  });

  it('keeps exact UPPER_SNAKE_CASE names, once each', () => {
    assert.deepEqual(resolve({ cardEnvAllow: ['OC_AGENT', 'MY_GATEWAY_TOKEN_HEADER', 'OC_AGENT'] }).policy.cardEnvAllow, ['OC_AGENT', 'MY_GATEWAY_TOKEN_HEADER']);
    assert.deepEqual(resolve({ cardEnvAllow: [] }).policy.cardEnvAllow, []);
  });

  it('accepts a name the roster deny list refuses: the card write refuses it instead', () => {
    assert.deepEqual(resolve({ cardEnvAllow: ['NODE_OPTIONS'] }).policy.cardEnvAllow, ['NODE_OPTIONS']);
  });

  it('refuses a non-UPPER_SNAKE_CASE entry at load, in Chinese, naming the entry', () => {
    for (const entry of ['oc_agent', 'Oc_Agent', '1ABC', 'A B', '-X', '', 'A-B', 42, null]) {
      assert.throws(
        () => resolve({ cardEnvAllow: [entry] }),
        (err) => err.message.includes('policy.cardEnvAllow')
          && err.message.includes(JSON.stringify(entry))
          && /不是合法的环境变量名：只能用大写字母、数字和下划线，且不能以数字开头 \(UPPER_SNAKE_CASE\)/.test(err.message),
        String(entry),
      );
    }
  });

  it('refuses a value that is not a list, in Chinese', () => {
    for (const value of ['OC_AGENT', { OC_AGENT: true }, null, 1]) {
      assert.throws(() => resolve({ cardEnvAllow: value }), /policy\.cardEnvAllow 必须是环境变量名的列表/, String(value));
    }
  });
});
