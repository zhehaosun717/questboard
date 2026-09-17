import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, loadProjectConfig, saveProjectConfig, CONFIG_FILE } from '../../src/core/config.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const lanes = { files: { run: ['node', 'worker.js'], outputDir: 'out' } };
const rawWith = (overrides) => ({ name: 'Config leftovers', lanes, ...overrides });
const writeConfig = (root, raw) => fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(raw));

describe('config leftovers: an invalid usage.alibaba on disk does not stop the load path', () => {
  it('drops an invalid edition with a Chinese diagnostic instead of refusing to start', () => {
    const root = tmp('qb-config-alibaba-');
    writeConfig(root, rawWith({ usage: { manualProviders: ['alibaba-token-plan'], alibaba: { edition: 'hacked-edition', region: 'cn-beijing' } } }));
    const config = loadProjectConfig(root);
    assert.equal(config.usage.alibaba, undefined);
    assert.match(config.usage.alibabaIssue, /^usage\.alibaba\.edition 不是有效的阿里云版本，可选：/);
    assert.ok(!JSON.stringify(config.usage).includes('hacked-edition'));
  });

  it('drops a missing region and names usage.alibaba.region', () => {
    const root = tmp('qb-config-alibaba-region-');
    writeConfig(root, rawWith({ usage: { alibaba: { edition: 'team' } } }));
    const config = loadProjectConfig(root);
    assert.equal(config.usage.alibaba, undefined);
    assert.match(config.usage.alibabaIssue, /^usage\.alibaba\.region 不是有效的阿里云区域，可选：/);
  });

  it('drops a non-object usage.alibaba with a Chinese diagnostic', () => {
    const root = tmp('qb-config-alibaba-shape-');
    writeConfig(root, rawWith({ usage: { alibaba: 'team' } }));
    const config = loadProjectConfig(root);
    assert.equal(config.usage.alibaba, undefined);
    assert.equal(config.usage.alibabaIssue, 'usage.alibaba 必须是对象');
  });

  it('keeps a valid usage.alibaba unchanged and adds no diagnostic', () => {
    const root = tmp('qb-config-alibaba-ok-');
    writeConfig(root, rawWith({ usage: { manualProviders: ['alibaba-token-plan'], alibaba: { edition: 'TEAM', region: 'cn-beijing' } } }));
    const config = loadProjectConfig(root);
    assert.deepEqual(config.usage.alibaba, { edition: 'team', region: 'cn-beijing' });
    assert.ok(!('alibabaIssue' in config.usage));
  });

  it('keeps the strict refusal for the settings save and for every other load error', () => {
    const root = tmp('qb-config-alibaba-strict-');
    const raw = rawWith({ usage: { alibaba: { edition: 'hacked-edition', region: 'cn-beijing' } } });
    writeConfig(root, raw);
    const message = /usage\.alibaba\.edition 不是有效的阿里云版本/;
    assert.throws(() => resolveConfig(root, raw), message);
    assert.throws(() => saveProjectConfig(root, raw), message);

    const badManual = rawWith({ usage: { manualProviders: ['ghost'] } });
    writeConfig(root, badManual);
    assert.throws(() => loadProjectConfig(root), /未知的用量来源：ghost/);
  });
});

describe('config leftovers: experimentalProviders refusals are Chinese and name the accepted ids', () => {
  it('names the unknown id and the accepted ids through resolveConfig', () => {
    const root = tmp('qb-config-experimental-');
    const raw = rawWith({ usage: { experimentalProviders: ['future-provider'] } });
    assert.throws(() => resolveConfig(root, raw), /未知的用量来源：future-provider（可选：codex-app-server）/);
  });

  it('names the unknown id and the accepted ids through the settings save validator', () => {
    const root = tmp('qb-config-experimental-save-');
    const raw = rawWith({ usage: { experimentalProviders: ['future-provider'] } });
    assert.throws(() => saveProjectConfig(root, raw), /未知的用量来源：future-provider（可选：codex-app-server）/);
  });

  it('still accepts and normalizes the documented id', () => {
    const root = tmp('qb-config-experimental-ok-');
    const config = resolveConfig(root, rawWith({ usage: { experimentalProviders: [' codex-app-server '] } }));
    assert.deepEqual(config.usage.experimentalProviders, ['codex-app-server']);
  });
});

describe('config leftovers: a present but non-object policy is refused in Chinese', () => {
  const message = /policy 必须是对象；要使用默认值请省略该字段（null 会被拒绝）/;

  it('refuses null, a string and an array with the same specific message', () => {
    const root = tmp('qb-config-policy-');
    assert.throws(() => resolveConfig(root, rawWith({ policy: null })), message);
    assert.throws(() => resolveConfig(root, rawWith({ policy: 'defaults' })), message);
    assert.throws(() => resolveConfig(root, rawWith({ policy: [] })), message);
  });

  it('is refused at the settings save validator too', () => {
    const root = tmp('qb-config-policy-save-');
    assert.throws(() => saveProjectConfig(root, rawWith({ policy: null })), message);
  });

  it('still hands out defaults when the field is omitted', () => {
    const config = resolveConfig(tmp('qb-config-policy-default-'), rawWith({}));
    assert.equal(config.policy.stallAfterMinutes, 20);
    assert.equal(config.policy.defaultLane, null);
    assert.deepEqual({ ...config.policy.laneConcurrency }, {});
    assert.deepEqual(config.policy.bouncePatterns, []);
    assert.deepEqual(config.policy.reviewRequires, []);
  });
});
