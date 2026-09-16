export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export const ALLOWED_ACCESS_TYPES = Object.freeze(new Set([
  'official-api',
  'official-cli',
  'official-hook',
  'undocumented-api',
  'local-log',
  'local-app',
  'manual',
]));

export const ALLOWED_VENDOR_HOSTS = Object.freeze([
  'openai.com',
  'chatgpt.com',
  'kimi.com',
  'moonshot.cn',
  'cursor.com',
  'cursor.sh',
  'volcengine.com',
  'deepseek.com',
  'openrouter.ai',
  'google.com',
  'siliconflow.cn',
  'xiaomi.com',
  'aliyun.com',
  'alibabacloud.com',
  'nvidia.com',
  'claude.ai',
  'claude.com',
  'anthropic.com',
]);

export function isAllowedVendorHost(hostname) {
  if (typeof hostname !== 'string' || !hostname.trim()) return false;
  const lower = hostname.trim().toLowerCase();
  return ALLOWED_VENDOR_HOSTS.some((h) => lower === h || lower.endsWith(`.${h}`));
}

export function validateDocsUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString.trim()) return false;
  let url;
  try {
    url = new URL(urlString.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return isAllowedVendorHost(url.hostname);
}

export function validateCatalogEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('Catalog entry must be an object');
  }
  if (typeof entry.id !== 'string' || !PROVIDER_ID_PATTERN.test(entry.id)) {
    throw new Error(`Invalid provider id: ${String(entry && entry.id)}`);
  }
  if (typeof entry.name !== 'string' || !entry.name.trim()) {
    throw new Error(`Invalid provider name for ${entry.id}`);
  }
  if (!ALLOWED_ACCESS_TYPES.has(entry.access)) {
    throw new Error(`Invalid access type '${entry.access}' for ${entry.id}`);
  }
  if (typeof entry.credentialType !== 'string' || !entry.credentialType.trim()) {
    throw new Error(`Invalid credentialType for ${entry.id}`);
  }
  if (/^sk-|^Bearer\s/i.test(entry.credentialType) || entry.credentialType.length > 50) {
    throw new Error(`credentialType looks like a secret value for ${entry.id}`);
  }
  if (!validateDocsUrl(entry.docsUrl)) {
    throw new Error(`Invalid docsUrl '${entry.docsUrl}' for ${entry.id}`);
  }
  if (entry.setupCommand !== undefined && (typeof entry.setupCommand !== 'string' || !entry.setupCommand.trim())) {
    throw new Error(`Invalid setupCommand for ${entry.id}`);
  }
  return true;
}

function makeEntry(raw) {
  validateCatalogEntry(raw);
  return Object.freeze({
    id: raw.id,
    name: raw.name,
    access: raw.access,
    credentialType: raw.credentialType,
    docsUrl: raw.docsUrl,
    ...(raw.setupCommand ? { setupCommand: raw.setupCommand } : {}),
  });
}

export const codexCatalog = makeEntry({
  id: 'codex',
  name: 'OpenAI Codex',
  access: 'local-log',
  credentialType: 'codex-chatgpt-session',
  docsUrl: 'https://learn.chatgpt.com/docs/app-server',
  setupCommand: 'codex login',
});

export const kimiCatalog = makeEntry({
  id: 'kimi',
  name: 'Kimi for Coding',
  access: 'undocumented-api',
  credentialType: 'kimi-code-api-key',
  docsUrl: 'https://www.kimi.com/code/docs/en/kimi-code/membership.html',
});

export const cursorCatalog = makeEntry({
  id: 'cursor',
  name: 'Cursor',
  access: 'undocumented-api',
  credentialType: 'cursor-oauth-session',
  docsUrl: 'https://www.cursor.com',
});

export const volcanoCatalog = makeEntry({
  id: 'volcano',
  name: '火山方舟 Coding Plan',
  access: 'official-cli',
  credentialType: 'arkcli-profile',
  docsUrl: 'https://docs.volcengine.com/docs/82379/1925114',
  setupCommand: 'arkcli auth login',
});

export const deepseekCatalog = makeEntry({
  id: 'deepseek',
  name: 'DeepSeek',
  access: 'official-api',
  credentialType: 'deepseek-api-key',
  docsUrl: 'https://platform.deepseek.com/api-docs',
});

export const openrouterCatalog = makeEntry({
  id: 'openrouter',
  name: 'OpenRouter',
  access: 'official-api',
  credentialType: 'openrouter-api-key',
  docsUrl: 'https://openrouter.ai/docs',
});

export const antigravityCatalog = makeEntry({
  id: 'agy',
  name: 'Antigravity（agy）',
  access: 'local-app',
  credentialType: 'antigravity-local-csrf',
  docsUrl: 'https://developers.google.com',
});

export const siliconflowCatalog = makeEntry({
  id: 'siliconflow',
  name: '硅基流动',
  access: 'official-api',
  credentialType: 'siliconflow-api-key',
  docsUrl: 'https://siliconflow.cn',
});

export const mimoCatalog = makeEntry({
  id: 'mimo',
  name: '小米 MiMo',
  access: 'undocumented-api',
  credentialType: 'browser-cookie',
  docsUrl: 'https://mimo.xiaomi.com',
});

export const alibabaTokenPlanCatalog = makeEntry({
  id: 'alibaba-token-plan',
  name: '阿里云百炼 Token Plan',
  access: 'manual',
  credentialType: 'alibaba-plan-api-key',
  docsUrl: 'https://help.aliyun.com/zh/model-studio/token-plan-overview',
});

export const alibabaCodingPlanCatalog = makeEntry({
  id: 'alibaba-coding-plan',
  name: '阿里云百炼 Coding Plan',
  access: 'manual',
  credentialType: 'alibaba-plan-api-key',
  docsUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
});

export const nvidiaCatalog = makeEntry({
  id: 'nvidia',
  name: 'NVIDIA',
  access: 'manual',
  credentialType: 'nvidia-api-key',
  docsUrl: 'https://docs.api.nvidia.com/nim/docs/product',
});

export const claudeSubscriptionCatalog = makeEntry({
  id: 'claude-subscription',
  name: 'Claude 订阅',
  access: 'manual',
  credentialType: 'claude-ai-subscription',
  docsUrl: 'https://code.claude.com/docs/en/statusline',
});

export const openaiSpendCatalog = makeEntry({
  id: 'openai-spend',
  name: 'OpenAI API 消耗',
  access: 'manual',
  credentialType: 'openai-admin-key',
  docsUrl: 'https://platform.openai.com/usage',
});

export const PROVIDER_CATALOG = Object.freeze({
  codex: codexCatalog,
  kimi: kimiCatalog,
  cursor: cursorCatalog,
  volcano: volcanoCatalog,
  deepseek: deepseekCatalog,
  openrouter: openrouterCatalog,
  agy: antigravityCatalog,
  siliconflow: siliconflowCatalog,
  mimo: mimoCatalog,
  'alibaba-token-plan': alibabaTokenPlanCatalog,
  'alibaba-coding-plan': alibabaCodingPlanCatalog,
  nvidia: nvidiaCatalog,
  'claude-subscription': claudeSubscriptionCatalog,
  'openai-spend': openaiSpendCatalog,
});

export const CATALOG_ENTRIES = Object.freeze(Object.values(PROVIDER_CATALOG));

export function getCatalogEntry(id) {
  if (typeof id !== 'string' || !Object.hasOwn(PROVIDER_CATALOG, id)) return null;
  return PROVIDER_CATALOG[id] || null;
}
