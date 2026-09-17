import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CARD_ENV_ALLOWED_NAMES,
  CARD_ENV_ALLOWED_SUFFIXES,
  envPolicyViolation,
  isAllowedCardEnvShape,
  loadRoster,
  saveRoster,
  upsertAdventurer,
  validateAdventurer,
  validateRoster,
} from '../../src/core/roster.js';

const base = {
  id: 'test-card',
  name: '测试卡',
  provider: '测试服务商',
  lane: 'codex',
  model: 'test-model',
  family: 'test-family',
};

const tmpRoster = (adventurers) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-roster-')), 'roster.json');
  fs.writeFileSync(file, JSON.stringify({ adventurers }));
  return file;
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

describe('roster env deny policy round 3', () => {
  const denied = ['COR_ENABLE_PROFILING', 'CORECLR_PROFILER', 'COMPLUS_X', 'PHPRC', 'QT_PLUGIN_PATH', 'EDITOR', 'SSLKEYLOGFILE'];

  it('refuses the round-3 prefixes and mixed case, in Chinese naming the variable', () => {
    for (const name of denied) {
      assert.throws(
        () => validateAdventurer({ ...base, env: { [name]: 'x' } }),
        (err) => err.message.includes(name) && err.message.includes('加载方式'),
        name,
      );
    }
    // Mixed case still matches the prefix policy.
    assert.throws(() => validateAdventurer({ ...base, env: { corECLR_PROFILER: 'x' } }), /加载方式/);
  });

  it('still accepts the existing positive-list names', () => {
    for (const [name, value] of [['OPENAI_BASE_URL', 'https://api.example.test/v1'], ['ANTHROPIC_MODEL', 'claude-test'], ['DEEPSEEK_MODEL', 'deepseek-test']]) {
      assert.deepEqual(validateAdventurer({ ...base, env: { [name]: value } }).env, { [name]: value });
    }
  });
});

describe('roster env deny policy round 4', () => {
  const blockingFromReview = [
    'RUSTC_WRAPPER', 'RUSTC', 'RUSTUP_TOOLCHAIN', 'RUSTUP_HOME', 'RUSTFLAGS', 'RUSTDOC', 'GOENV', 'CC', 'CXX',
  ];
  const suffixRuleNames = ['X_PATH', 'MY_HOME', 'TOOL_FLAGS', 'FOO_OPTS', 'BARRC'];
  const exactNameMixedCase = ['cc', 'Cxx'];
  const positiveList = [
    ['OPENAI_BASE_URL', 'https://api.example.test/v1'],
    ['ANTHROPIC_MODEL', 'claude-test'],
    // Round 5: MY_TOOL_FLAG, FOO_BAR_2 and DEEPSEEK_API_KEY left this list (not a provider-setting shape).
    ['MY_TOOL_MODEL', 'tool-model'],
    ['FOO_REGION', 'eu-west'],
    ['MODEL_NAME', 'gpt'],
    ['MAX_TOKENS', '4096'],
    ['API_TIMEOUT_MS', '30000'],
    ['PROVIDER_REGION', 'us-east'],
  ];

  it('refuses the round-4 blocking names from the review, in Chinese naming the variable', () => {
    for (const name of [...blockingFromReview, ...suffixRuleNames, ...exactNameMixedCase]) {
      assert.throws(
        () => validateAdventurer({ ...base, env: { [name]: 'x' } }),
        (err) => err.message.includes(name) && /[一-鿿]/u.test(err.message) && err.message.includes('这张卡不能设置它'),
        name,
      );
    }
  });

  it('refuses CODEX_HOME and CLAUDE_CONFIG_DIR by the suffix rule', () => {
    for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
      assert.throws(
        () => validateAdventurer({ ...base, env: { [name]: 'x' } }),
        (err) => err.message.includes(name) && /读配置或加载代码/.test(err.message),
        name,
      );
    }
  });

  it('still accepts the round-4 positive list', () => {
    for (const [name, value] of positiveList) {
      assert.deepEqual(validateAdventurer({ ...base, env: { [name]: value } }).env, { [name]: value });
    }
  });

  it('gives a plain Chinese message naming the variable for invalid names, keeping the UPPER_SNAKE_CASE token', () => {
    for (const name of ['1ABC', 'A B']) {
      assert.throws(
        () => validateAdventurer({ ...base, env: { [name]: 'x' } }),
        (err) => err.message.includes(name) && /[一-鿿]/u.test(err.message) && err.message.includes('UPPER_SNAKE_CASE'),
        name,
      );
    }
  });
});

describe('a legacy card must not brick the board (round 3)', () => {
  it('loads a roster.json fixture whose card carries a now-refused variable, without throwing', () => {
    const file = tmpRoster([{ ...base, id: 'legacy-ld', env: { LD_AUDIT: 'legacy-loader.so' } }]);
    const roster = loadRoster(file);
    assert.equal(roster.adventurers[0].env.LD_AUDIT, 'legacy-loader.so');
  });

  it('envPolicyViolation names the variable in Chinese for a legacy card, and is null for a clean one', () => {
    const violation = envPolicyViolation({ env: { LD_AUDIT: 'x' } });
    assert.equal(violation.variable, 'LD_AUDIT');
    assert.match(violation.reason, /LD_AUDIT/);
    assert.match(violation.reason, /加载方式/);
    assert.equal(envPolicyViolation({ env: { OPENAI_BASE_URL: 'https://api.example.test' } }), null);
    assert.equal(envPolicyViolation({}), null);
  });

  it('a single save that keeps the offending variable is refused; one that drops it succeeds', () => {
    const file = tmpRoster([{ ...base, id: 'legacy-ld', env: { LD_AUDIT: 'legacy-loader.so' } }]);
    const roster = loadRoster(file);
    assert.throws(
      () => saveRoster(file, upsertAdventurer(roster, { ...base, id: 'legacy-ld', env: { LD_AUDIT: 'legacy-loader.so' } }), { lenientEnv: true }),
      /LD_AUDIT/,
    );
    const repaired = saveRoster(file, upsertAdventurer(roster, { ...base, id: 'legacy-ld' }), { lenientEnv: true });
    assert.equal(repaired.adventurers[0].env, undefined);
    assert.equal(loadRoster(file).adventurers[0].env, undefined);
  });

  it('another untouched legacy card does not block saving a different, compliant card', () => {
    const file = tmpRoster([
      { ...base, id: 'legacy-ld', env: { LD_AUDIT: 'legacy-loader.so' } },
      { ...base, id: 'clean-card' },
    ]);
    const roster = loadRoster(file);
    const next = upsertAdventurer(roster, { ...base, id: 'clean-card', notes: 'updated' });
    saveRoster(file, next, { lenientEnv: true });
    const reloaded = loadRoster(file);
    assert.equal(reloaded.adventurers.find((a) => a.id === 'clean-card').notes, 'updated');
    assert.equal(reloaded.adventurers.find((a) => a.id === 'legacy-ld').env.LD_AUDIT, 'legacy-loader.so');
  });
});

describe('roster env allow shapes (round 5)', () => {
  const notAllowed = /不是卡片可以设置的：卡片只能带模型服务的设置，名字要以 _BASE_URL、_MODEL、_REGION 等结尾，或写进项目设置 policy\.cardEnvAllow/;

  it('accepts every allowed ending and exact name, and nothing close to them', () => {
    for (const suffix of CARD_ENV_ALLOWED_SUFFIXES) assert.equal(isAllowedCardEnvShape(`ACME${suffix}`), true, suffix);
    for (const name of CARD_ENV_ALLOWED_NAMES) assert.equal(isAllowedCardEnvShape(name), true, name);
    // A bare ending is not a name, the match is case-sensitive, and a near miss is not an ending.
    for (const name of ['_MODEL', 'acme_model', 'Acme_Model', 'BASE_URL', 'ACME_MODELS', 'ACME_MODEL_PATH', 'ACME_API_KEY', 'OC_AGENT']) {
      assert.equal(isAllowedCardEnvShape(name), false, name);
    }
  });

  it('refuses a name outside the shapes with the one Chinese sentence, unless the project lists it', () => {
    assert.throws(
      () => validateAdventurer({ ...base, env: { OC_AGENT: 'build' } }),
      (err) => err.message.includes('环境变量 OC_AGENT') && notAllowed.test(err.message),
    );
    assert.deepEqual(validateAdventurer({ ...base, env: { OC_AGENT: 'build' } }, 'adventurer', { cardEnvAllow: ['OC_AGENT'] }).env, { OC_AGENT: 'build' });
    const roster = { adventurers: [] };
    assert.throws(() => upsertAdventurer(roster, { ...base, env: { OC_AGENT: 'build' } }), notAllowed);
    assert.equal(upsertAdventurer(roster, { ...base, env: { OC_AGENT: 'build' } }, { cardEnvAllow: ['OC_AGENT'] }).adventurers.length, 1);
  });

  it('lets a deny hit win over an allowed shape and over the project list', () => {
    for (const name of ['PYTHON_MODEL', 'NODE_BASE_URL', 'GOOGLE_CLOUD_REGION']) {
      assert.throws(() => validateAdventurer({ ...base, env: { [name]: 'x' } }), /这张卡不能设置它/, name);
    }
    for (const name of ['NODE_OPTIONS', 'CODEX_HOME', 'LD_PRELOAD']) {
      assert.throws(() => validateAdventurer({ ...base, env: { [name]: 'x' } }, 'adventurer', { cardEnvAllow: [name] }), /这张卡不能设置它/, name);
      assert.equal(envPolicyViolation({ env: { [name]: 'x' } }, { cardEnvAllow: [name] }).variable, name);
    }
  });

  it('notes a legacy card outside the shapes without throwing on load, and honours the project list', () => {
    const file = tmpRoster([{ ...base, id: 'legacy-flag', env: { MY_TOOL_FLAG: 'enabled' } }]);
    assert.equal(loadRoster(file).adventurers[0].env.MY_TOOL_FLAG, 'enabled');
    const violation = envPolicyViolation({ env: { OPENAI_BASE_URL: 'https://api.example.test', MY_TOOL_FLAG: 'enabled' } });
    assert.equal(violation.variable, 'MY_TOOL_FLAG');
    assert.match(violation.reason, notAllowed);
    assert.equal(envPolicyViolation({ env: { MY_TOOL_FLAG: 'enabled' } }, { cardEnvAllow: ['MY_TOOL_FLAG'] }), null);
    assert.throws(() => saveRoster(file, loadRoster(file)), /MY_TOOL_FLAG/);
    assert.doesNotThrow(() => saveRoster(file, loadRoster(file), { cardEnvAllow: ['MY_TOOL_FLAG'] }));
  });

  it('gives Chinese refusals for the env shape, the variable cap, the value length and a key-shaped value', () => {
    const chinese = /[一-鿿]/u;
    const cases = [
      [{ env: ['OPENAI_BASE_URL'] }, /env 必须是「变量名: 值」这样的对象/],
      [{ env: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`P${i}_MODEL`, 'x'])) }, /最多只能设置 10 个环境变量，现在有 11 个/],
      [{ env: { ACME_MODEL: 'x'.repeat(201) } }, /环境变量 ACME_MODEL 的值必须是文字，最长 200 个字符/],
      [{ env: { ACME_MODEL: 42 } }, /环境变量 ACME_MODEL 的值必须是文字/],
      [{ env: { ACME_MODEL: 'ghp_synthetic' } }, /环境变量 ACME_MODEL 的值看起来像密钥：密钥请放在本机环境变量里/],
    ];
    for (const [extra, expected] of cases) {
      assert.throws(() => validateAdventurer({ ...base, ...extra }), (err) => chinese.test(err.message) && expected.test(err.message) && !err.message.includes('ghp_synthetic'));
    }
  });
});

describe('roster env deny policy round 6 (browser download mirrors)', () => {
  it('refuses the download-mirror families with the deny reason, in Chinese naming the variable', () => {
    for (const name of ['PUPPETEER_DOWNLOAD_BASE_URL', 'PLAYWRIGHT_DOWNLOAD_HOST', 'CYPRESS_DOWNLOAD_MIRROR', 'ELECTRON_MIRROR']) {
      assert.throws(
        () => validateAdventurer({ ...base, env: { [name]: 'https://evil.example' } }),
        (err) => err.message.includes(name) && err.message.includes('这张卡不能设置它') && /[一-鿿]/u.test(err.message),
        name,
      );
    }
  });
});
