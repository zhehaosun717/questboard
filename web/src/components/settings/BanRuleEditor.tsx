import { useMemo, useState } from "react";
import {
  matchingBanRuleCards,
  parseBanRule,
  serializeBanRule,
  type BanRule,
  type BanRuleCard,
  type BanRuleMode,
} from "../../lib/banRules";
import { t as tStatic, useT, type I18nKey } from "../../lib/i18n";

type RuleField = "bannedModelPatterns" | "bannedAgents";

type Props = {
  cards: readonly BanRuleCard[];
  field: RuleField;
  label: string;
  hint: string;
  patterns: readonly string[];
  onPatternsChange: (patterns: string[]) => void;
};

const MODES: Array<{ value: BanRuleMode; labelKey: I18nKey }> = [
  { value: "exact", labelKey: "banRule.modeExact" },
  { value: "contains", labelKey: "banRule.modeContains" },
  { value: "startsWith", labelKey: "banRule.modeStartsWith" },
  { value: "regex", labelKey: "banRule.modeRegex" },
];

function cardLabel(card: BanRuleCard): string {
  const name = card.name ?? card.id ?? tStatic("banRule.nameFallback");
  const model = card.model ?? tStatic("banRule.modelFallback");
  const channel = card.channel ?? tStatic("banRule.channelFallback");
  return `${name} · ${model} · ${channel}`;
}

function displayMode(mode: BanRuleMode): string {
  const option = MODES.find((item) => item.value === mode);
  return option ? tStatic(option.labelKey) : tStatic("banRule.modeRegex");
}

export function BanRuleEditor({ cards, field, label, hint, patterns, onPatternsChange }: Props) {
  const t = useT();
  const [mode, setMode] = useState<BanRuleMode>("contains");
  const [value, setValue] = useState("");
  const [search, setSearch] = useState("");
  // One open flag per rule: a single shared boolean expanded every regex rule at once.
  const [advancedOpen, setAdvancedOpen] = useState<readonly number[]>([]);
  const isAdvancedOpen = (index: number) => advancedOpen.includes(index);
  const toggleAdvanced = (index: number) =>
    setAdvancedOpen((open) =>
      open.includes(index) ? open.filter((item) => item !== index) : [...open, index],
    );

  const preview = useMemo(
    () => patterns.map(parseBanRule).map((rule, index) => ({ rule, index, cards: rule.valid ? matchingBanRuleCards(rule, cards, field === "bannedModelPatterns" ? "model" : "agent") : [] })),
    [cards, field, patterns],
  );
  const inputError = value.length > 0 ? parseBanRule(serializeBanRule({ mode, value })).error : undefined;
  const modelNames = useMemo(() => {
    if (field !== "bannedModelPatterns") return [];
    return [...new Set(cards.map((card) => card.model).filter((model): model is string => typeof model === "string" && model.length > 0))];
  }, [cards, field]);
  const visibleModelNames = modelNames.filter((model) => model.toLocaleLowerCase().includes(search.toLocaleLowerCase()));

  const addRule = () => {
    const rule: BanRule = { mode, value };
    if (value.length === 0 || !parseBanRule(serializeBanRule(rule)).valid) return;
    onPatternsChange([...patterns, serializeBanRule(rule)]);
    setValue("");
  };

  const updateRule = (index: number, next: BanRule) => {
    const nextPattern = serializeBanRule(next);
    if (next.value.length === 0 || !parseBanRule(nextPattern).valid) return;
    onPatternsChange(patterns.map((pattern, itemIndex) => (itemIndex === index ? nextPattern : pattern)));
  };

  const toggleModel = (model: string) => {
    const exactPattern = serializeBanRule({ mode: "exact", value: model });
    const isChecked = patterns.some((pattern) => {
      const parsed = parseBanRule(pattern);
      return parsed.valid && parsed.mode === "exact" && parsed.value.toLocaleLowerCase() === model.toLocaleLowerCase();
    });
    onPatternsChange(isChecked ? patterns.filter((pattern) => pattern !== exactPattern) : [...patterns, exactPattern]);
  };

  return (
    <section className="config-policy-group" aria-labelledby={`${field}-title`}>
      <div className="config-policy-heading">
        <div>
          <h3 id={`${field}-title`}>{label}</h3>
          <p>{hint}</p>
        </div>
        <span className="config-policy-scope">{t("banRule.scope")}</span>
      </div>

      <div className="config-policy-add-row">
        <select aria-label={t("banRule.matchAria", { label })} value={mode} onChange={(event) => setMode(event.target.value as BanRuleMode)}>
          {MODES.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
        </select>
        <input aria-label={t("banRule.ruleAria", { label })} value={value} onChange={(event) => setValue(event.target.value)} placeholder={mode === "regex" ? t("banRule.regexPlaceholder") : t("banRule.namePlaceholder")} />
        <button type="button" className="btn" onClick={addRule} disabled={value.length === 0 || inputError !== undefined}>{t("banRule.add")}</button>
      </div>
      {inputError !== undefined && <p className="config-policy-error">{inputError}</p>}
      {field === "bannedModelPatterns" && <div className="config-policy-roster-picker">
        <label htmlFor={`${field}-search`}>{t("banRule.searchLabel")}</label>
        <input id={`${field}-search`} aria-label={t("banRule.searchLabel")} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("banRule.searchPlaceholder")} />
        <div className="config-policy-model-list">
          {visibleModelNames.length === 0 ? <span>{t("banRule.noMatch")}</span> : visibleModelNames.map((model) => {
            const checked = patterns.some((pattern) => {
              const parsed = parseBanRule(pattern);
              return parsed.valid && parsed.mode === "exact" && parsed.value.toLocaleLowerCase() === model.toLocaleLowerCase();
            });
            return <label key={model}><input type="checkbox" checked={checked} onChange={() => toggleModel(model)} />{model}</label>;
          })}
        </div>
      </div>}

      <div className="config-policy-rules">
        {preview.length === 0 && <p className="config-policy-empty">{t("banRule.empty")}</p>}
        {preview.map(({ rule, index, cards: affected }) => (
          <div className="config-policy-rule" key={`${field}-${index}-${patterns[index]}`}>
            <div className="config-policy-rule-main">
              {rule.valid && rule.mode !== "regex" ? (
                <>
                  <select aria-label={t("banRule.ruleMatchAria", { label, index: index + 1 })} value={rule.mode} onChange={(event) => updateRule(index, { mode: event.target.value as BanRuleMode, value: rule.value })}>
                    {MODES.slice(0, 3).map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
                  </select>
                  <input aria-label={t("banRule.ruleValueAria", { label, index: index + 1 })} value={rule.value} onChange={(event) => updateRule(index, { mode: rule.mode, value: event.target.value })} />
                </>
              ) : (
                <>
                  <button type="button" className="config-policy-advanced-toggle" onClick={() => toggleAdvanced(index)} aria-expanded={isAdvancedOpen(index)}>{isAdvancedOpen(index) ? t("banRule.collapse") : t("banRule.expand")}{t("banRule.modeRegex")}</button>
                  {isAdvancedOpen(index) ? <input aria-label={t("banRule.regexAria", { label, index: index + 1 })} value={patterns[index] ?? ""} onChange={(event) => onPatternsChange(patterns.map((pattern, itemIndex) => itemIndex === index ? event.target.value : pattern))} /> : <code>{patterns[index]}</code>}
                </>
              )}
              <button type="button" className="config-policy-remove" onClick={() => onPatternsChange(patterns.filter((_, itemIndex) => itemIndex !== index))}>{t("banRule.remove")}</button>
            </div>
            {rule.valid ? (
              <div className="config-policy-preview"><strong>{t("banRule.banCount", { count: affected.length })}</strong>{affected.length > 0 ? <span>{affected.map(cardLabel).join("；")}</span> : <span>{t("banRule.noneAffected")}</span>}</div>
            ) : <p className="config-policy-error">{rule.error ?? t("banRule.invalidRule")}</p>}
            {rule.valid && rule.mode === "regex" && isAdvancedOpen(index) && <p className="config-policy-advanced-note">{t("banRule.advancedNote", { mode: displayMode(rule.mode) })}</p>}
          </div>
        ))}
      </div>
      <p className="config-policy-footnote">{field === "bannedModelPatterns" ? t("banRule.footnoteModel") : t("banRule.footnoteAgent")}</p>
    </section>
  );
}
