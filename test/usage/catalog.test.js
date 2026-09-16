import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_ACCESS_TYPES,
  ALLOWED_VENDOR_HOSTS,
  CATALOG_ENTRIES,
  PROVIDER_CATALOG,
  PROVIDER_ID_PATTERN,
  getCatalogEntry,
  isAllowedVendorHost,
  validateCatalogEntry,
  validateDocsUrl,
} from '../../src/usage/catalog.js';
import { PROVIDERS } from '../../src/usage/providers.js';

const SECRET_CANARY = 'sk-live-secret-test-canary-0123456789abcdef';

describe('provider catalog metadata', () => {
  it('gives honest access labels to existing providers', () => {
    const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
    assert.equal(byId.kimi.access, 'undocumented-api');
    assert.equal(byId.kimi.source, 'undocumented-api');
    assert.equal(byId.cursor.access, 'undocumented-api');
    assert.equal(byId.cursor.source, 'undocumented-api');
    assert.equal(byId.volcano.access, 'official-cli');
    assert.equal(byId.volcano.source, 'official-cli');
    assert.equal(byId.deepseek.access, 'official-api');
    assert.equal(byId.deepseek.source, 'official-api');
    assert.equal(byId.codex.access, 'local-log');
    assert.equal(byId.codex.source, 'local-log');
    assert.equal(byId.agy.access, 'local-app');
    assert.equal(byId.agy.source, 'local-app');
    assert.equal(byId.openrouter.access, 'official-api');
    assert.equal(byId.siliconflow.access, 'official-api');
    assert.equal(byId.mimo.access, 'undocumented-api');
  });

  it('matches catalog access labels with provider definitions', () => {
    for (const p of PROVIDERS) {
      const entry = getCatalogEntry(p.id);
      assert.ok(entry, `Catalog must have entry for provider ${p.id}`);
      assert.equal(entry.access, p.access || p.source, `Access mismatch for provider ${p.id}`);
    }
  });

  it('contains valid, bounded metadata for every catalog entry', () => {
    assert.ok(CATALOG_ENTRIES.length >= 9, 'Catalog contains all required providers');
    for (const entry of CATALOG_ENTRIES) {
      assert.doesNotThrow(() => validateCatalogEntry(entry), `Entry for ${entry.id} should be valid`);
      assert.ok(ALLOWED_ACCESS_TYPES.has(entry.access), `Invalid access ${entry.access} for ${entry.id}`);
      assert.ok(typeof entry.credentialType === 'string' && entry.credentialType.length > 0);
      assert.ok(!entry.credentialType.startsWith('sk-'), `credentialType must be a type name, not secret for ${entry.id}`);
      assert.ok(entry.docsUrl.startsWith('https://'), `docsUrl must use https: for ${entry.id}`);
    }
  });

  it('asserts every docsUrl is https and on an allowlisted vendor host', () => {
    for (const entry of CATALOG_ENTRIES) {
      assert.equal(validateDocsUrl(entry.docsUrl), true, `docsUrl for ${entry.id} (${entry.docsUrl}) must be valid`);
    }
  });

  it('rejects suffix spoofing of allowlisted vendor hosts', () => {
    assert.equal(isAllowedVendorHost('openai.com'), true);
    assert.equal(isAllowedVendorHost('platform.openai.com'), true);
    assert.equal(isAllowedVendorHost('api.kimi.com'), true);
    assert.equal(isAllowedVendorHost('build.nvidia.com'), true);
    assert.equal(isAllowedVendorHost('code.claude.com'), true);
    assert.equal(isAllowedVendorHost('learn.chatgpt.com'), true);
    assert.equal(isAllowedVendorHost('help.aliyun.com'), true);
    assert.equal(isAllowedVendorHost('www.alibabacloud.com'), true);

    // Suffix spoofing: vendor.com.evil
    assert.equal(isAllowedVendorHost('openai.com.evil'), false);
    assert.equal(isAllowedVendorHost('openai.com.evil.com'), false);
    assert.equal(isAllowedVendorHost('volcengine.com.fake.org'), false);
    assert.equal(isAllowedVendorHost('deepseek.com.attacker.com'), false);
    assert.equal(isAllowedVendorHost('aliyun.com.phishing.net'), false);
    assert.equal(isAllowedVendorHost('claude.com.evil'), false);
    assert.equal(isAllowedVendorHost('chatgpt.com.attacker.com'), false);
    assert.equal(isAllowedVendorHost('alibabacloud.com.phishing.net'), false);
    assert.equal(isAllowedVendorHost('evilopenai.com'), false);
    assert.equal(isAllowedVendorHost('notgoogle.com'), false);
    assert.equal(isAllowedVendorHost('fakekimi.com'), false);
  });

  it('rejects non-https, userinfo, and opaque schemes in docsUrl', () => {
    assert.equal(validateDocsUrl('http://platform.openai.com/docs'), false);
    assert.equal(validateDocsUrl('ftp://platform.openai.com/docs'), false);
    assert.equal(validateDocsUrl('javascript:alert(1)'), false);
    assert.equal(validateDocsUrl('https://user:pass@platform.openai.com/docs'), false);
    assert.equal(validateDocsUrl('https://untrusted-host.example.com/docs'), false);
    assert.equal(validateDocsUrl('https://openai.com.evil/docs'), false);
    assert.equal(validateDocsUrl('not a url'), false);
    assert.equal(validateDocsUrl(''), false);
    assert.equal(validateDocsUrl(null), false);
  });

  it('validates catalog entries strictly and rejects corrupted fields', () => {
    assert.throws(() => validateCatalogEntry(null), TypeError);
    assert.throws(() => validateCatalogEntry({ id: 'INVALID_ID', name: 'Test', access: 'official-api', credentialType: 'api-key', docsUrl: 'https://openai.com' }), /Invalid provider id/);
    assert.throws(() => validateCatalogEntry({ id: 'test', name: '', access: 'official-api', credentialType: 'api-key', docsUrl: 'https://openai.com' }), /Invalid provider name/);
    assert.throws(() => validateCatalogEntry({ id: 'test', name: 'Test', access: 'invalid-access', credentialType: 'api-key', docsUrl: 'https://openai.com' }), /Invalid access type/);
    assert.throws(() => validateCatalogEntry({ id: 'test', name: 'Test', access: 'official-api', credentialType: '', docsUrl: 'https://openai.com' }), /Invalid credentialType/);
    assert.throws(() => validateCatalogEntry({ id: 'test', name: 'Test', access: 'official-api', credentialType: 'sk-secret-token', docsUrl: 'https://openai.com' }), /looks like a secret/);
    assert.throws(() => validateCatalogEntry({ id: 'test', name: 'Test', access: 'official-api', credentialType: 'api-key', docsUrl: 'http://insecure.openai.com' }), /Invalid docsUrl/);
    assert.throws(() => validateCatalogEntry({ id: 'test', name: 'Test', access: 'official-api', credentialType: 'api-key', docsUrl: 'https://openai.com', setupCommand: '' }), /Invalid setupCommand/);
  });

  it('returns null for unknown provider ids and inherited properties in getCatalogEntry', () => {
    assert.equal(getCatalogEntry('unknown-provider'), null);
    assert.equal(getCatalogEntry('constructor'), null);
    assert.equal(getCatalogEntry('__proto__'), null);
    assert.equal(getCatalogEntry('toString'), null);
    assert.ok(getCatalogEntry('codex'));
    assert.ok(getCatalogEntry('kimi'));
    assert.ok(getCatalogEntry('volcano'));
    assert.ok(getCatalogEntry('deepseek'));
    assert.ok(getCatalogEntry('alibaba-token-plan'));
  });

  it('defines PROVIDER_ID_PATTERN matching service.js export', async () => {
    const { PROVIDER_ID_PATTERN: servicePattern } = await import('../../src/usage/service.js');
    assert.equal(PROVIDER_ID_PATTERN.source, servicePattern.source);
    assert.equal(PROVIDER_ID_PATTERN.flags, servicePattern.flags);
  });

  it('ensures no credential value or secret ever appears in the catalog', () => {
    const serialized = JSON.stringify(PROVIDER_CATALOG);
    assert.ok(!serialized.includes(SECRET_CANARY));
    assert.ok(!serialized.includes('Bearer '));
    assert.ok(!serialized.includes('sk-'));
  });

  it('assigns truthful credentialType names matching Report 885 and Report eb72', () => {
    assert.equal(getCatalogEntry('codex').credentialType, 'codex-chatgpt-session');
    assert.equal(getCatalogEntry('kimi').credentialType, 'kimi-code-api-key');
    assert.equal(getCatalogEntry('cursor').credentialType, 'cursor-oauth-session');
    assert.equal(getCatalogEntry('volcano').credentialType, 'arkcli-profile');
    assert.equal(getCatalogEntry('deepseek').credentialType, 'deepseek-api-key');
    assert.equal(getCatalogEntry('openrouter').credentialType, 'openrouter-api-key');
    assert.equal(getCatalogEntry('agy').credentialType, 'antigravity-local-csrf');
    assert.equal(getCatalogEntry('alibaba-token-plan').credentialType, 'alibaba-plan-api-key');
    assert.equal(getCatalogEntry('alibaba-coding-plan').credentialType, 'alibaba-plan-api-key');
    assert.equal(getCatalogEntry('nvidia').credentialType, 'nvidia-api-key');
    assert.equal(getCatalogEntry('claude-subscription').credentialType, 'claude-ai-subscription');
    assert.equal(getCatalogEntry('openai-spend').credentialType, 'openai-admin-key');
  });
});
