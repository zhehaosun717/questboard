import type { Card } from "../../api/types";
import type { BanRuleCard } from "../../lib/banRules";
import type { PolicyDraft } from "../../lib/settingsForm";
import { BanRuleEditor } from "./BanRuleEditor";

interface SettingsPolicySectionProps {
  draft: PolicyDraft;
  roster: readonly Card[];
  onChange: (patch: Partial<PolicyDraft>) => void;
}

// A roster card calls its lane `lane`; the ban-rule editor shows it as the card's channel.
function toBanRuleCards(roster: readonly Card[]): BanRuleCard[] {
  return roster.map((card) => ({
    id: card.id,
    name: card.name,
    model: card.model,
    agent: card.agent ?? null,
    channel: card.lane,
  }));
}

export function SettingsPolicySection({ draft, roster, onChange }: SettingsPolicySectionProps) {
  const cards = toBanRuleCards(roster);

  const update = (field: "bannedModelPatterns" | "bannedAgents", patterns: string[]) => {
    onChange({ [field]: patterns });
  };

  const models = draft.bannedModelPatterns;
  const agents = draft.bannedAgents;

  return (
    <div className="config-policy-section">
      <div className="config-policy-intro">
        <h2>派出禁令</h2>
        <p>禁令只作用于当前项目，不会全局禁止派出模型或执行角色。</p>
      </div>
      <BanRuleEditor
        cards={cards}
        field="bannedModelPatterns"
        label="禁止派出模型"
        hint="搜索名册中的模型，也可以手动输入尚未入册的模型名。"
        patterns={models}
        onPatternsChange={(patterns) => update("bannedModelPatterns", patterns)}
      />
      <BanRuleEditor
        cards={cards}
        field="bannedAgents"
        label="禁止派出执行角色"
        hint="匹配冒险者的 agent 字段，例如 Sisyphus；这不是冒险者名册。"
        patterns={agents}
        onPatternsChange={(patterns) => update("bannedAgents", patterns)}
      />
    </div>
  );
}

export default SettingsPolicySection;
