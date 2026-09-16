import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/core/config.js';
import { describeProject } from '../../src/server/settingsRoutes.js';
import { tmpDir } from '../helpers.js';

function rawProject(usage) {
  return {
    name: 'Usage settings',
    lanes: { files: { run: ['node', 'worker.js'], outputDir: 'out' } },
    usage,
  };
}

describe('usage settings validation', () => {
  it('normalizes enabled manual ids and Alibaba choices through resolveConfig', () => {
    const config = resolveConfig(tmpDir('qb-config-usage-'), rawProject({
      manualProviders: ['nvidia', 'alibaba-token-plan', 'nvidia'],
      alibaba: { edition: ' Enterprise ', region: ' CN-BEIJING ' },
    }));
    assert.deepEqual(config.usage, {
      manualProviders: ['nvidia', 'alibaba-token-plan'],
      alibaba: { edition: 'enterprise', region: 'cn-beijing' },
    });
    assert.deepEqual(describeProject(config).usage, config.usage);
  });

  it('rejects unknown manual ids by name and invalid Alibaba choices by field, in Chinese', () => {
    assert.throws(
      () => resolveConfig(tmpDir('qb-config-usage-bad-id-'), rawProject({ manualProviders: ['ghost-provider'] })),
      (error) => /ghost-provider/.test(String(error && error.message)) && /用量来源/.test(String(error && error.message)),
    );
    // An invalid choice is refused at the settings boundary instead of being silently normalized to "unknown".
    // The message names the field (with its Chinese label) so the settings page can point at it, and it never
    // repeats the rejected value back.
    assert.throws(
      () => resolveConfig(tmpDir('qb-config-usage-bad-edition-'), rawProject({
        manualProviders: ['alibaba-coding-plan'],
        alibaba: { edition: {}, region: 'cn-beijing' },
      })),
      (error) => /usage\.alibaba\.edition/.test(String(error && error.message)) && /阿里云版本/.test(String(error && error.message)),
    );
    assert.throws(
      () => resolveConfig(tmpDir('qb-config-usage-bad-region-'), rawProject({
        manualProviders: ['alibaba-coding-plan'],
        alibaba: { edition: 'team', region: 'not-allowlisted' },
      })),
      (error) => /usage\.alibaba\.region/.test(String(error && error.message)) && /阿里云区域/.test(String(error && error.message)),
    );
    assert.throws(
      () => resolveConfig(tmpDir('qb-config-usage-missing-edition-'), rawProject({
        manualProviders: ['alibaba-coding-plan'],
        alibaba: { region: 'cn-beijing' },
      })),
      (error) => /usage\.alibaba\.edition/.test(String(error && error.message)),
      'a missing half of the choice fails loudly instead of silently becoming unknown',
    );
  });

  it('defaults the validated usage setting to no manual providers', () => {
    const config = resolveConfig(tmpDir('qb-config-usage-default-'), rawProject(undefined));
    assert.deepEqual(config.usage, { manualProviders: [] });
    assert.deepEqual(describeProject(config).usage, { manualProviders: [] });
  });
});
