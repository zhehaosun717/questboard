import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import module from 'node:module';
import { tmpDir } from '../helpers.js';
import { createUsageService } from '../../src/usage/service.js';
import { CLAUDE_SETUP_NOTE } from '../../src/usage/claudeStatusline.js';
import {
  MANUAL_NOTE,
  MANUAL_PROVIDERS,
  alibabaCodingPlan,
  alibabaTokenPlan,
  claudeSubscription,
  createAlibabaCodingPlan,
  createAlibabaTokenPlan,
  mapBrandToPlan,
  nvidia,
  openaiSpend,
} from '../../src/usage/manualProviders.js';

const SECRET_CANARY = 'sk-live-secret-test-canary-0123456789abcdef';

describe('manual-only providers', () => {
  it('defines Alibaba Token Plan and Coding Plan as two separate entries with optional edition/region', async () => {
    assert.notEqual(alibabaTokenPlan.id, alibabaCodingPlan.id);
    assert.equal(alibabaTokenPlan.id, 'alibaba-token-plan');
    assert.equal(alibabaCodingPlan.id, 'alibaba-coding-plan');

    // Default unknown
    assert.equal(alibabaTokenPlan.edition, 'unknown');
    assert.equal(alibabaTokenPlan.region, 'unknown');
    assert.equal(alibabaCodingPlan.edition, 'unknown');
    assert.equal(alibabaCodingPlan.region, 'unknown');

    // Custom edition and region
    const customToken = createAlibabaTokenPlan({ edition: 'enterprise', region: 'cn-beijing' });
    assert.equal(customToken.edition, 'enterprise');
    assert.equal(customToken.region, 'cn-beijing');

    const customCoding = createAlibabaCodingPlan({ edition: 'personal', region: 'cn-shanghai' });
    assert.equal(customCoding.edition, 'personal');
    assert.equal(customCoding.region, 'cn-shanghai');
    assert.equal((await customToken.fetch()).plan, '企业版 · 北京');
    assert.equal((await customCoding.fetch()).plan, '个人版 · 上海');
    assert.doesNotMatch((await customToken.fetch()).plan, /enterprise|cn-beijing/);

    // Invalid/arbitrary choices collapse to 'unknown'
    const invalidToken = createAlibabaTokenPlan({ edition: {}, region: 'malicious-string' });
    assert.equal(invalidToken.edition, 'unknown');
    assert.equal(invalidToken.region, 'unknown');

    const invalidCoding = createAlibabaCodingPlan({ edition: 'hacked-edition', region: null });
    assert.equal(invalidCoding.edition, 'unknown');
    assert.equal(invalidCoding.region, 'unknown');
  });

  it('contains NVIDIA, Claude subscription, and OpenAI API spend entries', () => {
    assert.equal(nvidia.id, 'nvidia');
    assert.equal(nvidia.source, 'manual');
    assert.equal(nvidia.access, 'manual');

    assert.equal(claudeSubscription.id, 'claude-subscription');
    assert.equal(claudeSubscription.source, 'manual');
    assert.equal(claudeSubscription.access, 'manual');

    assert.equal(openaiSpend.id, 'openai-spend');
    assert.equal(openaiSpend.source, 'manual');
    assert.equal(openaiSpend.access, 'manual');
  });

  it('yields a manual_only result with no numbers (empty windows and balances)', async () => {
    // Hermetic home: claudeSubscription reads a snapshot file when one exists, so the
    // fetch must be pinned to an empty directory instead of the developer's real home.
    const homedir = tmpDir('qb-manual-empty-');
    for (const provider of MANUAL_PROVIDERS) {
      const res = await provider.fetch({ homedir, env: {} });
      assert.equal(res.manual_only, true, `${provider.id} should have manual_only: true`);
      assert.equal(res.state, 'manual_only', `${provider.id} should have state: 'manual_only'`);
      assert.deepEqual(res.windows, [], `${provider.id} must have no windows (no numbers)`);
      assert.deepEqual(res.balances, [], `${provider.id} must have no balances (no numbers)`);
      assert.ok(typeof res.note === 'string' && res.note.length > 0);
    }
  });

  it('never performs key lookup, network calls, or child process execution', async () => {
    let networkCalls = 0;
    let childProcessCalls = 0;

    const fakeFetchImpl = async () => {
      networkCalls += 1;
      throw new Error('Network call attempted!');
    };

    const originalGlobalFetch = globalThis.fetch;
    const originalExecFile = child_process.execFile;
    const originalSpawn = child_process.spawn;
    const originalExec = child_process.exec;
    try {
      globalThis.fetch = async () => {
        networkCalls += 1;
        throw new Error('globalThis.fetch called!');
      };
      child_process.execFile = () => { childProcessCalls += 1; throw new Error('child_process.execFile called!'); };
      child_process.spawn = () => { childProcessCalls += 1; throw new Error('child_process.spawn called!'); };
      child_process.exec = () => { childProcessCalls += 1; throw new Error('child_process.exec called!'); };
      module.syncBuiltinESMExports();

      for (const provider of MANUAL_PROVIDERS) {
        // Must not declare keys or oauth config that would trigger key lookup
        assert.equal(provider.keys, undefined, `${provider.id} must not configure keys`);
        assert.equal(provider.oauth, undefined, `${provider.id} must not configure oauth`);

        // Direct fetch (hermetic home; never reads the developer's real snapshot)
        const homedir = tmpDir('qb-manual-test-');
        await provider.fetch({ fetchImpl: fakeFetchImpl, key: SECRET_CANARY, homedir, env: {} });

        // Service report integration
        const service = createUsageService({
          homedir,
          env: { OPENAI_API_KEY: SECRET_CANARY, ALIBABA_API_KEY: SECRET_CANARY },
          fetchImpl: fakeFetchImpl,
          providers: [provider],
        });
        const report = await service.report();
        const [entry] = report.providers;
        assert.equal(entry.ok, false, 'manual-only readings are not successful quota readings');
        assert.equal(entry.providerState, 'manual_only');
        assert.equal(entry.state, 'unconfigured', 'a manual card has no automatic reading to call fresh');
        assert.deepEqual(entry.windows, []);
        assert.deepEqual(entry.balances, []);
        assert.equal(entry.keyFrom, undefined, 'No keyFrom should be looked up');
        assert.ok(!JSON.stringify(report).includes(SECRET_CANARY));
      }

      assert.equal(networkCalls, 0, 'No network fetch calls should be made');
      assert.equal(childProcessCalls, 0, 'No child_process calls should be made');
    } finally {
      globalThis.fetch = originalGlobalFetch;
      child_process.execFile = originalExecFile;
      child_process.spawn = originalSpawn;
      child_process.exec = originalExec;
      module.syncBuiltinESMExports();
    }
  });

  it('uses truthful copy (暂未确认公开的用量查询接口, 当前通过控制台查看, 看板还没接入, or the Claude setup step) and never claims "供应商没有接口"', async () => {
    const homedir = tmpDir('qb-manual-copy-');
    for (const provider of MANUAL_PROVIDERS) {
      const res = await provider.fetch({ homedir, env: {} });
      const text = res.note;
      assert.ok(
        text.includes('暂未确认公开的用量查询接口') || text.includes('当前通过控制台查看') || text.includes('看板还没接入 Claude Code 状态栏数据') || text.includes('在 Claude Code 里运行 /usage'),
        `Copy must use truthful wording for ${provider.id}, got: ${text}`
      );
      assert.ok(
        !text.includes('供应商没有接口'),
        `Copy must never say "供应商没有接口" for ${provider.id}`
      );
    }
    const claudeRes = await claudeSubscription.fetch({ homedir: tmpDir('qb-manual-claude-'), env: {} });
    assert.equal(claudeRes.note, CLAUDE_SETUP_NOTE);
  });

  it('never copies fixed quotas from pricing articles as account usage', async () => {
    const homedir = tmpDir('qb-manual-quotas-');
    for (const provider of MANUAL_PROVIDERS) {
      const res = await provider.fetch({ homedir, env: {} });
      // Verify no numeric quota or balance fields are fabricated
      assert.equal(res.windows.length, 0);
      assert.equal(res.balances.length, 0);
      assert.equal(res.asOf, null);
    }
  });

  it('never maps Qwen brand to a plan automatically', () => {
    assert.equal(mapBrandToPlan('qwen'), null);
    assert.equal(mapBrandToPlan('Qwen-2.5-Coder'), null);
    assert.equal(mapBrandToPlan('qwen-max'), null);
    assert.equal(mapBrandToPlan('alibaba/qwen'), null);
  });

  it('ensures no secrets or env values appear in manual provider outputs', async () => {
    const homedir = tmpDir('qb-manual-secrets-');
    for (const provider of MANUAL_PROVIDERS) {
      const serialized = JSON.stringify(provider);
      assert.ok(!serialized.includes(SECRET_CANARY));
      const res = await provider.fetch({ homedir, env: {} });
      assert.ok(!JSON.stringify(res).includes(SECRET_CANARY));
    }
  });

  it('assigns credentialType names matching vendor evidence to manual providers', () => {
    assert.equal(alibabaTokenPlan.credentialType, 'alibaba-plan-api-key');
    assert.equal(alibabaCodingPlan.credentialType, 'alibaba-plan-api-key');
    assert.equal(nvidia.credentialType, 'nvidia-api-key');
    assert.equal(claudeSubscription.credentialType, 'claude-ai-subscription');
    assert.equal(openaiSpend.credentialType, 'openai-admin-key');
  });
});
