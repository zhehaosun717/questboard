import { describe, expect, it } from "vitest";
import {
  matchingBanRuleCards,
  parseBanRule,
  parseBanRules,
  serializeBanRule,
  serializeBanRules,
  type BanRule,
} from "./banRules";

describe("ban rules", () => {
  it("serializes each friendly matching mode", () => {
    expect(serializeBanRule({ mode: "exact", value: "gpt-4.1" })).toBe("^gpt\\-4\\.1$");
    expect(serializeBanRule({ mode: "contains", value: "gpt-4.1" })).toBe("gpt\\-4\\.1");
    expect(serializeBanRule({ mode: "startsWith", value: "gpt-4.1" })).toBe("^gpt\\-4\\.1");
    expect(serializeBanRule({ mode: "regex", value: "-fast(\\b|-)" })).toBe("-fast(\\b|-)");
  });

  it("escapes regex metacharacters in ordinary names", () => {
    const rule: BanRule = { mode: "contains", value: "gpt-4.1" };
    expect(serializeBanRule(rule)).not.toBe("gpt-4.1");
    expect(matchingBanRuleCards(rule, [{ model: "gpt-4.1" }, { model: "gptX41" }], "model")).toHaveLength(1);
  });

  it("round trips friendly rules", () => {
    const rules: BanRule[] = [
      { mode: "exact", value: "gpt-4.1" },
      { mode: "contains", value: "Claude [fast]" },
      { mode: "startsWith", value: "o3/" },
    ];
    expect(parseBanRules(serializeBanRules(rules)).map(({ mode, value }) => ({ mode, value }))).toEqual(rules);
  });

  it("keeps non-reversible valid regexes advanced and unchanged", () => {
    for (const pattern of ["-fast(\\b|-)", "^a|b$"]) {
      expect(parseBanRule(pattern)).toMatchObject({ mode: "regex", value: pattern, pattern, valid: true });
    }
  });

  it("rejects empty and invalid regexes", () => {
    expect(parseBanRule("")).toMatchObject({ valid: false });
    expect(parseBanRule("[")).toMatchObject({ valid: false });
  });

  it("previews case-insensitive model matches", () => {
    const cards = [
      { id: "1", name: "A", model: "GPT-4.1", channel: "主通道" },
      { id: "2", name: "B", model: "claude-3", channel: "备用" },
    ];
    expect(matchingBanRuleCards({ mode: "exact", value: "gpt-4.1" }, cards, "model").map((card) => card.id)).toEqual(["1"]);
    expect(matchingBanRuleCards({ mode: "contains", value: "missing" }, cards, "model")).toEqual([]);
  });
});
