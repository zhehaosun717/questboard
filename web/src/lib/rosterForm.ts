import type { AdventurerInput } from '../api/types';

export interface CardFormValues {
  id?: string;
  name?: string;
  provider?: string;
  lane?: string;
  model?: string;
  family?: string;
  variant?: string;
  agent?: string;
  billing?: string;
  maxParallel?: number | string;
  strengths?: string | string[];
  notes?: string;
}

export interface ValidationResult {
  errors: Record<string, string>;
  value: AdventurerInput | null;
}

const VALID_BILLINGS = new Set(['subscription', 'plan', 'payg', 'free']);
const ID_PATTERN = /^[a-z0-9-]+$/;

export function validateCardForm(
  values: CardFormValues,
  lanes: string[],
): ValidationResult {
  const errors: Record<string, string> = {};

  // id: required, lowercase letters, digits, hyphens, max 48
  const rawId = values.id?.trim() ?? '';
  if (!rawId) {
    errors.id = 'ID 不能为空';
  } else if (rawId.length > 48 || !ID_PATTERN.test(rawId)) {
    errors.id = 'ID 只能包含小写字母、数字和连字符，且不超过48个字符';
  }

  // name: required
  const rawName = values.name?.trim() ?? '';
  if (!rawName) {
    errors.name = '名称不能为空';
  }

  // provider: required
  const rawProvider = values.provider?.trim() ?? '';
  if (!rawProvider) {
    errors.provider = '服务商不能为空';
  }

  // lane: required, must be one of lanes
  const rawLane = values.lane?.trim() ?? '';
  if (!rawLane) {
    errors.lane = '通道不能为空';
  } else if (!lanes.includes(rawLane)) {
    errors.lane = '通道不在允许的通道列表中';
  }

  // model: required
  const rawModel = values.model?.trim() ?? '';
  if (!rawModel) {
    errors.model = '模型不能为空';
  }

  // family: required
  const rawFamily = values.family?.trim() ?? '';
  if (!rawFamily) {
    errors.family = '系列不能为空';
  }

  // notes: optional, max 300 chars
  const rawNotes = values.notes?.trim() ?? '';
  if (values.notes && values.notes.length > 300) {
    errors.notes = '备注不能超过300个字符';
  }

  // maxParallel: optional, positive integer
  let parsedMaxParallel: number | undefined;
  if (
    values.maxParallel !== undefined &&
    values.maxParallel !== null &&
    String(values.maxParallel).trim() !== ''
  ) {
    const num = Number(values.maxParallel);
    if (!Number.isInteger(num) || num <= 0) {
      errors.maxParallel = '最大并发数必须是正整数';
    } else {
      parsedMaxParallel = num;
    }
  }

  // billing: optional, one of subscription | plan | payg | free
  const rawBilling = values.billing?.trim() ?? '';
  if (rawBilling && !VALID_BILLINGS.has(rawBilling)) {
    errors.billing = '计费类型无效';
  }

  // strengths: comma-separated string or array
  let strengthsList: string[] = [];
  if (typeof values.strengths === 'string') {
    strengthsList = values.strengths
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(values.strengths)) {
    strengthsList = values.strengths
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (Object.keys(errors).length > 0) {
    return { errors, value: null };
  }

  const value: AdventurerInput = {
    id: rawId,
    name: rawName,
    provider: rawProvider,
    lane: rawLane,
    model: rawModel,
    family: rawFamily,
  };

  const rawVariant = values.variant?.trim();
  if (rawVariant) {
    value.variant = rawVariant;
  }

  const rawAgent = values.agent?.trim();
  if (rawAgent) {
    value.agent = rawAgent;
  }

  if (rawBilling) {
    value.billing = rawBilling as 'subscription' | 'plan' | 'payg' | 'free';
  }

  if (parsedMaxParallel !== undefined) {
    value.maxParallel = parsedMaxParallel;
  }

  if (strengthsList.length > 0) {
    value.strengths = strengthsList;
  }

  if (rawNotes) {
    value.notes = rawNotes;
  }

  return { errors: {}, value };
}
