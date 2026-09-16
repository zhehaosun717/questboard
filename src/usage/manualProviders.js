export const MANUAL_NOTE = '暂未确认公开的用量查询接口，当前通过控制台查看';
export const ALIBABA_MANUAL_NOTE = '阿里云暂未确认公开的用量查询接口 · 当前通过控制台查看';
export const NVIDIA_MANUAL_NOTE = 'NVIDIA 暂未确认公开的用量查询接口；当前通过控制台查看（在 build.nvidia.com 右上角账户菜单看限速）';
export const CLAUDE_MANUAL_NOTE = '看板还没接入 Claude Code 状态栏数据；当前在 Claude Code 里运行 /usage 查看';
export const OPENAI_SPEND_MANUAL_NOTE = 'OpenAI API 消耗需要组织管理员 key，看板不读取；当前通过控制台查看';

export const ALIBABA_EDITIONS = Object.freeze(new Set([
  'personal',
  'team',
  'enterprise',
  'free',
  'standard',
  'pro',
  'lite',
]));

export const ALIBABA_REGIONS = Object.freeze(new Set([
  'cn-beijing',
  'cn-shanghai',
  'cn-hangzhou',
  'cn-shenzhen',
  'ap-southeast-1',
]));

function safeChoice(value, allowlist) {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (allowlist.has(trimmed)) return trimmed;
  }
  return 'unknown';
}

export function createManualResult({ plan = '', note = MANUAL_NOTE } = {}) {
  return {
    windows: [],
    balances: [],
    plan,
    note,
    manual_only: true,
    state: 'manual_only',
    asOf: null,
  };
}

export function createAlibabaTokenPlan({ edition = 'unknown', region = 'unknown' } = {}) {
  const validEdition = safeChoice(edition, ALIBABA_EDITIONS);
  const validRegion = safeChoice(region, ALIBABA_REGIONS);
  const parts = [];
  if (validEdition !== 'unknown') parts.push(validEdition);
  if (validRegion !== 'unknown') parts.push(validRegion);
  const plan = parts.join(' · ');
  return Object.freeze({
    id: 'alibaba-token-plan',
    name: '阿里云百炼 Token Plan',
    source: 'manual',
    access: 'manual',
    credentialType: 'alibaba-plan-api-key',
    edition: validEdition,
    region: validRegion,
    manual_only: true,
    async fetch() {
      return createManualResult({ plan, note: ALIBABA_MANUAL_NOTE });
    },
  });
}

export function createAlibabaCodingPlan({ edition = 'unknown', region = 'unknown' } = {}) {
  const validEdition = safeChoice(edition, ALIBABA_EDITIONS);
  const validRegion = safeChoice(region, ALIBABA_REGIONS);
  const parts = [];
  if (validEdition !== 'unknown') parts.push(validEdition);
  if (validRegion !== 'unknown') parts.push(validRegion);
  const plan = parts.join(' · ');
  return Object.freeze({
    id: 'alibaba-coding-plan',
    name: '阿里云百炼 Coding Plan',
    source: 'manual',
    access: 'manual',
    credentialType: 'alibaba-plan-api-key',
    edition: validEdition,
    region: validRegion,
    manual_only: true,
    async fetch() {
      return createManualResult({ plan, note: ALIBABA_MANUAL_NOTE });
    },
  });
}

export const alibabaTokenPlan = createAlibabaTokenPlan();
export const alibabaCodingPlan = createAlibabaCodingPlan();

export const nvidia = Object.freeze({
  id: 'nvidia',
  name: 'NVIDIA',
  source: 'manual',
  access: 'manual',
  credentialType: 'nvidia-api-key',
  manual_only: true,
  async fetch() {
    return createManualResult({ note: NVIDIA_MANUAL_NOTE });
  },
});

export const claudeSubscription = Object.freeze({
  id: 'claude-subscription',
  name: 'Claude 订阅',
  source: 'manual',
  access: 'manual',
  credentialType: 'claude-ai-subscription',
  manual_only: true,
  async fetch() {
    return createManualResult({ note: CLAUDE_MANUAL_NOTE });
  },
});

export const openaiSpend = Object.freeze({
  id: 'openai-spend',
  name: 'OpenAI API 消耗',
  source: 'manual',
  access: 'manual',
  credentialType: 'openai-admin-key',
  manual_only: true,
  async fetch() {
    return createManualResult({ note: OPENAI_SPEND_MANUAL_NOTE });
  },
});

export const MANUAL_PROVIDERS = Object.freeze([
  alibabaTokenPlan,
  alibabaCodingPlan,
  nvidia,
  claudeSubscription,
  openaiSpend,
]);

export function mapBrandToPlan(brand) {
  if (brand && String(brand).toLowerCase().includes('qwen')) {
    return null;
  }
  return null;
}

