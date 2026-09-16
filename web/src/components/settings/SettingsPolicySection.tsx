import type { Card } from "../../api/types";
import type { BanRuleCard } from "../../lib/banRules";
import type { LaneDraft, PolicyDraft } from "../../lib/settingsForm";
import { BanRuleEditor } from "./BanRuleEditor";

interface SettingsPolicySectionProps {
  draft: PolicyDraft;
  roster: readonly Card[];
  lanes: readonly LaneDraft[];
  errors: Record<string, string>;
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

export function SettingsPolicySection({ draft, roster, lanes, errors, onChange }: SettingsPolicySectionProps) {
  const cards = toBanRuleCards(roster);
  const laneIds = lanes.map((lane) => lane.id.trim()).filter((id) => id !== "");

  const update = (field: "bannedModelPatterns" | "bannedAgents", patterns: string[]) => {
    onChange({ [field]: patterns });
  };

  const updateLaneRow = (index: number, patch: Partial<{ lane: string; limit: string }>) => {
    onChange({ laneConcurrency: draft.laneConcurrency.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  };
  const removeLaneRow = (index: number) => {
    onChange({ laneConcurrency: draft.laneConcurrency.filter((_, i) => i !== index) });
  };
  const addLaneRow = () => {
    onChange({ laneConcurrency: [...draft.laneConcurrency, { lane: "", limit: "" }] });
  };

  const updateBounceRow = (index: number, patch: Partial<{ code: string; pattern: string; label: string }>) => {
    onChange({ bouncePatterns: draft.bouncePatterns.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  };
  const removeBounceRow = (index: number) => {
    onChange({ bouncePatterns: draft.bouncePatterns.filter((_, i) => i !== index) });
  };
  const addBounceRow = () => {
    onChange({ bouncePatterns: [...draft.bouncePatterns, { code: "", pattern: "", label: "" }] });
  };

  const models = draft.bannedModelPatterns;
  const agents = draft.bannedAgents;
  // The roster is machine-level; when the preferred card is not in it the setting stays, visibly, and is
  // never replaced or imported silently.
  const wantedCard = draft.defaultCard.trim();
  const cardMissing = wantedCard !== "" && !roster.some((card) => card.id === wantedCard);

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

      <section className="config-policy-group" aria-labelledby="policy-stall-title">
        <div className="config-policy-heading">
          <div>
            <h3 id="policy-stall-title">停摆判定</h3>
            <p>.out 超过这么多分钟没动静、又拿不到有效的 .exit 时，看板把这个 worker 标成停摆。停摆只是提醒，不会取消任务。</p>
          </div>
          <span className="config-policy-scope">单位：分钟</span>
        </div>
        <div className="config-policy-rule-main">
          <span>停摆阈值（分钟）</span>
          <input
            aria-label="停摆阈值（分钟）"
            type="number"
            min={1}
            step={1}
            value={draft.stallAfterMinutes}
            placeholder="默认 20"
            onChange={(event) => onChange({ stallAfterMinutes: event.target.value })}
          />
        </div>
        {errors["policy.stallAfterMinutes"] !== undefined && <p className="config-policy-error">{errors["policy.stallAfterMinutes"]}</p>}
      </section>

      <section className="config-policy-group" aria-labelledby="policy-lane-limit-title">
        <div className="config-policy-heading">
          <div>
            <h3 id="policy-lane-limit-title">通道并发上限</h3>
            <p>每条通道最多同时跑几个 worker。改小不会停掉已经在跑的 worker，只会挡住新的派遣；默认不限制。</p>
          </div>
          <span className="config-policy-scope">仅此项目</span>
        </div>
        <div className="config-policy-rules">
          {draft.laneConcurrency.length === 0 && <p className="config-policy-empty">还没有设置上限。</p>}
          {draft.laneConcurrency.map((row, index) => (
            <div className="config-policy-rule" key={`policy-lane-${index}`}>
              <div className="config-policy-rule-main">
                <select aria-label={`第${index + 1}条通道`} value={row.lane} onChange={(event) => updateLaneRow(index, { lane: event.target.value })}>
                  <option value="">选择通道</option>
                  {laneIds.map((id) => <option key={id} value={id}>{id}</option>)}
                  {row.lane !== "" && !laneIds.includes(row.lane) && <option value={row.lane}>{row.lane}（未配置）</option>}
                </select>
                <input
                  aria-label={`第${index + 1}条并发上限`}
                  type="number"
                  min={1}
                  step={1}
                  value={row.limit}
                  placeholder="比如 2"
                  onChange={(event) => updateLaneRow(index, { limit: event.target.value })}
                />
                <button type="button" className="config-policy-remove" onClick={() => removeLaneRow(index)}>删除</button>
              </div>
              {errors[`policy.laneConcurrency.${index}.lane`] !== undefined && <p className="config-policy-error">{errors[`policy.laneConcurrency.${index}.lane`]}</p>}
              {errors[`policy.laneConcurrency.${index}.limit`] !== undefined && <p className="config-policy-error">{errors[`policy.laneConcurrency.${index}.limit`]}</p>}
            </div>
          ))}
        </div>
        <div className="config-policy-add-row">
          <button type="button" className="btn" onClick={addLaneRow}>添加通道上限</button>
        </div>
      </section>

      <section className="config-policy-group" aria-labelledby="policy-defaults-title">
        <div className="config-policy-heading">
          <div>
            <h3 id="policy-defaults-title">默认通道与默认卡</h3>
            <p>没指定时用哪条通道、哪张卡。你手动指定的永远优先；这里不会自动替你派活、也不会悄悄换卡。</p>
          </div>
          <span className="config-policy-scope">仅此项目</span>
        </div>
        <div className="config-policy-rule-main">
          <span>默认通道</span>
          <select aria-label="默认通道" value={draft.defaultLane} onChange={(event) => onChange({ defaultLane: event.target.value })}>
            <option value="">不指定</option>
            {laneIds.map((id) => <option key={id} value={id}>{id}</option>)}
            {draft.defaultLane !== "" && !laneIds.includes(draft.defaultLane) && <option value={draft.defaultLane}>{draft.defaultLane}（未配置）</option>}
          </select>
        </div>
        {errors["policy.defaultLane"] !== undefined && <p className="config-policy-error">{errors["policy.defaultLane"]}</p>}
        <div className="config-policy-rule-main">
          <span>默认卡 ID</span>
          <input
            aria-label="默认卡 ID"
            value={draft.defaultCard}
            placeholder="例如 my-codex"
            onChange={(event) => onChange({ defaultCard: event.target.value })}
          />
        </div>
        {errors["policy.defaultCard"] !== undefined && <p className="config-policy-error">{errors["policy.defaultCard"]}</p>}
        {cardMissing && <p className="config-policy-advanced-note">首选卡「{wantedCard}」不在名册里（设置会保留，不会自动换卡；补上这张卡或改掉 ID 即可）</p>}
        <p className="config-policy-footnote">questboard assign 不带 --adventurer 时会用它；卡本身在公会名册里维护，这里只记偏好。</p>
      </section>

      <section className="config-policy-group" aria-labelledby="policy-bounce-title">
        <div className="config-policy-heading">
          <div>
            <h3 id="policy-bounce-title">结构化退避</h3>
            <p>worker 的退出行匹配到正则时，退避原因显示成你的标签，并带上 code。只匹配最后一行，不扫描整个日志；内置的用量限额识别先跑。</p>
          </div>
          <span className="config-policy-scope">仅此项目</span>
        </div>
        <div className="config-policy-rules">
          {draft.bouncePatterns.length === 0 && <p className="config-policy-empty">还没有规则，先走内置的用量限额识别。</p>}
          {draft.bouncePatterns.map((row, index) => (
            <div className="config-policy-rule" key={`policy-bounce-${index}`}>
              <div className="config-policy-rule-main">
                <input
                  aria-label={`第${index + 1}条 code`}
                  value={row.code}
                  placeholder="code，例如 quota_5h"
                  onChange={(event) => updateBounceRow(index, { code: event.target.value })}
                />
                <input
                  aria-label={`第${index + 1}条正则`}
                  value={row.pattern}
                  placeholder="正则，例如 resets (at|in)"
                  onChange={(event) => updateBounceRow(index, { pattern: event.target.value })}
                />
                <input
                  aria-label={`第${index + 1}条标签`}
                  value={row.label}
                  placeholder="标签，例如 额度用尽"
                  onChange={(event) => updateBounceRow(index, { label: event.target.value })}
                />
                <button type="button" className="config-policy-remove" onClick={() => removeBounceRow(index)}>删除</button>
              </div>
              {errors[`policy.bouncePatterns.${index}.code`] !== undefined && <p className="config-policy-error">{errors[`policy.bouncePatterns.${index}.code`]}</p>}
              {errors[`policy.bouncePatterns.${index}.pattern`] !== undefined && <p className="config-policy-error">{errors[`policy.bouncePatterns.${index}.pattern`]}</p>}
              {errors[`policy.bouncePatterns.${index}.label`] !== undefined && <p className="config-policy-error">{errors[`policy.bouncePatterns.${index}.label`]}</p>}
            </div>
          ))}
        </div>
        <div className="config-policy-add-row">
          <button type="button" className="btn" onClick={addBounceRow}>添加退避规则</button>
        </div>
      </section>

      <p className="config-policy-footnote">保存后需要重启看板才会生效。</p>
    </div>
  );
}

export default SettingsPolicySection;
