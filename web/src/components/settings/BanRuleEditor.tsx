import { useMemo, useState } from "react";
import {
  matchingBanRuleCards,
  parseBanRule,
  serializeBanRule,
  type BanRule,
  type BanRuleCard,
  type BanRuleMode,
} from "../../lib/banRules";

type RuleField = "bannedModelPatterns" | "bannedAgents";

type Props = {
  cards: readonly BanRuleCard[];
  field: RuleField;
  label: string;
  hint: string;
  patterns: readonly string[];
  onPatternsChange: (patterns: string[]) => void;
};

const MODES: Array<{ value: BanRuleMode; label: string }> = [
  { value: "exact", label: "名称完全等于" },
  { value: "contains", label: "名称包含" },
  { value: "startsWith", label: "名称以……开头" },
  { value: "regex", label: "高级：正则" },
];

function cardLabel(card: BanRuleCard): string {
  const name = card.name ?? card.id ?? "未命名工牌";
  const model = card.model ?? "未指定模型";
  const channel = card.channel ?? "未指定通道";
  return `${name} · ${model} · ${channel}`;
}

function displayMode(mode: BanRuleMode): string {
  return MODES.find((option) => option.value === mode)?.label ?? "高级：正则";
}

export function BanRuleEditor({ cards, field, label, hint, patterns, onPatternsChange }: Props) {
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
        <span className="config-policy-scope">仅此项目</span>
      </div>

      <div className="config-policy-add-row">
        <select aria-label={`${label}匹配方式`} value={mode} onChange={(event) => setMode(event.target.value as BanRuleMode)}>
          {MODES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <input aria-label={`${label}规则`} value={value} onChange={(event) => setValue(event.target.value)} placeholder={mode === "regex" ? "输入正则表达式" : "输入名称，例如 gpt-4.1"} />
        <button type="button" onClick={addRule} disabled={value.length === 0 || inputError !== undefined}>添加禁用规则</button>
      </div>
      {inputError !== undefined && <p className="config-policy-error">{inputError}</p>}
      {field === "bannedModelPatterns" && <div className="config-policy-roster-picker">
        <label htmlFor={`${field}-search`}>搜索名册里的模型</label>
        <input id={`${field}-search`} aria-label="搜索名册里的模型" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索已入册模型" />
        <div className="config-policy-model-list">
          {visibleModelNames.length === 0 ? <span>没有匹配的已入册模型，可以手动输入。</span> : visibleModelNames.map((model) => {
            const checked = patterns.some((pattern) => {
              const parsed = parseBanRule(pattern);
              return parsed.valid && parsed.mode === "exact" && parsed.value.toLocaleLowerCase() === model.toLocaleLowerCase();
            });
            return <label key={model}><input type="checkbox" checked={checked} onChange={() => toggleModel(model)} />{model}</label>;
          })}
        </div>
      </div>}

      <div className="config-policy-rules">
        {preview.length === 0 && <p className="config-policy-empty">还没有规则。</p>}
        {preview.map(({ rule, index, cards: affected }) => (
          <div className="config-policy-rule" key={`${field}-${index}-${patterns[index]}`}>
            <div className="config-policy-rule-main">
              {rule.valid && rule.mode !== "regex" ? (
                <>
                  <select aria-label={`${label}第${index + 1}条匹配方式`} value={rule.mode} onChange={(event) => updateRule(index, { mode: event.target.value as BanRuleMode, value: rule.value })}>
                    {MODES.slice(0, 3).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <input aria-label={`${label}第${index + 1}条内容`} value={rule.value} onChange={(event) => updateRule(index, { mode: rule.mode, value: event.target.value })} />
                </>
              ) : (
                <>
                  <button type="button" className="config-policy-advanced-toggle" onClick={() => toggleAdvanced(index)} aria-expanded={isAdvancedOpen(index)}>{isAdvancedOpen(index) ? "收起" : "展开"}高级：正则</button>
                  {isAdvancedOpen(index) ? <input aria-label={`${label}第${index + 1}条正则`} value={patterns[index] ?? ""} onChange={(event) => onPatternsChange(patterns.map((pattern, itemIndex) => itemIndex === index ? event.target.value : pattern))} /> : <code>{patterns[index]}</code>}
                </>
              )}
              <button type="button" className="config-policy-remove" onClick={() => onPatternsChange(patterns.filter((_, itemIndex) => itemIndex !== index))}>删除</button>
            </div>
            {rule.valid ? (
              <div className="config-policy-preview"><strong>将禁用 {affected.length} 张工牌</strong>{affected.length > 0 ? <span>{affected.map(cardLabel).join("；")}</span> : <span>当前没有工牌会被影响</span>}</div>
            ) : <p className="config-policy-error">{rule.error ?? "规则无效"}</p>}
            {rule.valid && rule.mode === "regex" && isAdvancedOpen(index) && <p className="config-policy-advanced-note">匹配方式：{displayMode(rule.mode)}。保存时仍按原始正则存储。</p>}
          </div>
        ))}
      </div>
      <p className="config-policy-footnote">这里禁用的是使用该{field === "bannedModelPatterns" ? "模型" : "执行角色"}的全部工牌；想暂停单张工牌，请去公会名册修改它的状态。</p>
    </section>
  );
}
