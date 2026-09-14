export type BanRuleMode = "exact" | "contains" | "startsWith" | "regex";

export type BanRule = {
  mode: BanRuleMode;
  value: string;
};

export type BanRuleCard = {
  id?: string;
  name?: string | null;
  model?: string | null;
  agent?: string | null;
  channel?: string | null;
};

export type BanRuleMatch = {
  mode: BanRuleMode;
  value: string;
  pattern: string;
  valid: boolean;
  error?: string;
};

const REGEX_META = /[.*+?^${}()|[\]\\/-]/g;
const ESCAPABLE_LITERAL = new Set(".*+?^${}()|[]\\/-");
const REGEX_META_CHARACTERS = new Set(".*+?^${}()|[]\\/");

export function escapeRegexText(value: string): string {
  return value.replace(REGEX_META, "\\$&");
}

function unescapeRegexText(value: string): string | undefined {
  let escaped = false;
  let result = "";

  for (const character of value) {
    if (escaped) {
      if (!ESCAPABLE_LITERAL.has(character)) return undefined;
      result += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (REGEX_META_CHARACTERS.has(character)) return undefined;
    result += character;
  }

  return escaped ? undefined : result;
}

function friendlyCandidate(mode: BanRuleMode, pattern: string): BanRule | undefined {
  if (mode === "exact" && !(pattern.startsWith("^") && pattern.endsWith("$"))) {
    return undefined;
  }
  if (mode === "startsWith" && !pattern.startsWith("^")) return undefined;
  if (mode === "contains" && (pattern.startsWith("^") || pattern.endsWith("$"))) {
    return undefined;
  }

  const offset = mode === "exact" || mode === "startsWith" ? 1 : 0;
  const end = mode === "exact" ? pattern.length - 1 : pattern.length;
  const value = unescapeRegexText(pattern.slice(offset, end));
  if (value === undefined || value.length === 0) return undefined;

  const candidate = { mode, value };
  return serializeBanRule(candidate) === pattern ? candidate : undefined;
}

export function serializeBanRule(rule: BanRule): string {
  if (rule.mode === "regex") return rule.value;
  const value = escapeRegexText(rule.value);
  if (rule.mode === "exact") return `^${value}$`;
  if (rule.mode === "startsWith") return `^${value}`;
  return value;
}

export function serializeBanRules(rules: readonly BanRule[]): string[] {
  return rules.map(serializeBanRule);
}

export function parseBanRule(pattern: string): BanRuleMatch {
  if (pattern.length === 0) {
    return { mode: "regex", value: pattern, pattern, valid: false, error: "规则不能为空" };
  }

  try {
    new RegExp(pattern, "i");
  } catch {
    return { mode: "regex", value: pattern, pattern, valid: false, error: "不是合法的正则表达式" };
  }

  for (const mode of ["exact", "startsWith", "contains"] as const) {
    const candidate = friendlyCandidate(mode, pattern);
    if (candidate !== undefined) return { ...candidate, pattern, valid: true };
  }

  return { mode: "regex", value: pattern, pattern, valid: true };
}

export function parseBanRules(patterns: readonly string[]): BanRuleMatch[] {
  return patterns.map(parseBanRule);
}

export function validateBanRule(rule: BanRule): string | undefined {
  if (rule.value.length === 0) return "规则不能为空";
  try {
    new RegExp(serializeBanRule(rule), "i");
  } catch {
    return "不是合法的正则表达式";
  }
  return undefined;
}

export function matchesBanRule(rule: BanRule, value: string): boolean {
  const pattern = serializeBanRule(rule);
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return false;
  }
}

export function matchingBanRuleCards(
  rule: BanRule,
  cards: readonly BanRuleCard[],
  field: "model" | "agent",
): BanRuleCard[] {
  return cards.filter((card) => {
    const value = card[field];
    return typeof value === "string" && matchesBanRule(rule, value);
  });
}
