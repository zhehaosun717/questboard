import type { Card } from "../../api/types";
import type { BanRuleCard } from "../../lib/banRules";
import type { LaneDraft, PolicyDraft } from "../../lib/settingsForm";
import { BanRuleEditor } from "./BanRuleEditor";
import { useT } from "../../lib/i18n";

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
  const t = useT();
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
        <h2>{t("settingsPolicy.introTitle")}</h2>
        <p>{t("settingsPolicy.intro")}</p>
      </div>
      <BanRuleEditor
        cards={cards}
        field="bannedModelPatterns"
        label={t("settingsPolicy.banModelsLabel")}
        hint={t("settingsPolicy.banModelsHint")}
        patterns={models}
        onPatternsChange={(patterns) => update("bannedModelPatterns", patterns)}
      />
      <BanRuleEditor
        cards={cards}
        field="bannedAgents"
        label={t("settingsPolicy.banAgentsLabel")}
        hint={t("settingsPolicy.banAgentsHint")}
        patterns={agents}
        onPatternsChange={(patterns) => update("bannedAgents", patterns)}
      />

      <section className="config-policy-group" aria-labelledby="policy-stall-title">
        <div className="config-policy-heading">
          <div>
            <h3 id="policy-stall-title">{t("settingsPolicy.stallTitle")}</h3>
            <p>{t("settingsPolicy.stallHint")}</p>
          </div>
          <span className="config-policy-scope">{t("settingsPolicy.stallUnit")}</span>
        </div>
        <div className="config-policy-rule-main">
          <span>{t("settingsPolicy.stallLabel")}</span>
          <input
            aria-label={t("settingsPolicy.stallLabel")}
            type="number"
            min={1}
            step={1}
            value={draft.stallAfterMinutes}
            placeholder={t("settingsPolicy.stallPlaceholder")}
            onChange={(event) => onChange({ stallAfterMinutes: event.target.value })}
          />
        </div>
        {errors["policy.stallAfterMinutes"] !== undefined && <p className="config-policy-error">{errors["policy.stallAfterMinutes"]}</p>}
      </section>

      <section className="config-policy-group" aria-labelledby="policy-lane-limit-title">
        <div className="config-policy-heading">
          <div>
            <h3 id="policy-lane-limit-title">{t("settingsPolicy.laneLimitTitle")}</h3>
            <p>{t("settingsPolicy.laneLimitHint")}</p>
          </div>
          <span className="config-policy-scope">{t("settingsPolicy.scope")}</span>
        </div>
        <div className="config-policy-rules">
          {draft.laneConcurrency.length === 0 && <p className="config-policy-empty">{t("settingsPolicy.laneLimitEmpty")}</p>}
          {draft.laneConcurrency.map((row, index) => (
            <div className="config-policy-rule" key={`policy-lane-${index}`}>
              <div className="config-policy-rule-main">
                <select aria-label={t("settingsPolicy.laneAria", { index: index + 1 })} value={row.lane} onChange={(event) => updateLaneRow(index, { lane: event.target.value })}>
                  <option value="">{t("settingsPolicy.selectLane")}</option>
                  {laneIds.map((id) => <option key={id} value={id}>{id}</option>)}
                  {row.lane !== "" && !laneIds.includes(row.lane) && <option value={row.lane}>{t("settingsPolicy.unconfigured", { lane: row.lane })}</option>}
                </select>
                <input
                  aria-label={t("settingsPolicy.limitAria", { index: index + 1 })}
                  type="number"
                  min={1}
                  step={1}
                  value={row.limit}
                  placeholder={t("settingsPolicy.limitPlaceholder")}
                  onChange={(event) => updateLaneRow(index, { limit: event.target.value })}
                />
                <button type="button" className="config-policy-remove" onClick={() => removeLaneRow(index)}>{t("settingsPolicy.remove")}</button>
              </div>
              {errors[`policy.laneConcurrency.${index}.lane`] !== undefined && <p className="config-policy-error">{errors[`policy.laneConcurrency.${index}.lane`]}</p>}
              {errors[`policy.laneConcurrency.${index}.limit`] !== undefined && <p className="config-policy-error">{errors[`policy.laneConcurrency.${index}.limit`]}</p>}
            </div>
          ))}
        </div>
        <div className="config-policy-add-row">
          <button type="button" className="btn" onClick={addLaneRow}>{t("settingsPolicy.addLaneLimit")}</button>
        </div>
      </section>

      <section className="config-policy-group" aria-labelledby="policy-defaults-title">
        <div className="config-policy-heading">
          <div>
            <h3 id="policy-defaults-title">{t("settingsPolicy.defaultsTitle")}</h3>
            <p>{t("settingsPolicy.defaultsHint")}</p>
          </div>
          <span className="config-policy-scope">{t("settingsPolicy.scope")}</span>
        </div>
        <div className="config-policy-rule-main">
          <span>{t("settingsPolicy.defaultLane")}</span>
          <select aria-label={t("settingsPolicy.defaultLane")} value={draft.defaultLane} onChange={(event) => onChange({ defaultLane: event.target.value })}>
            <option value="">{t("settingsPolicy.noDefault")}</option>
            {laneIds.map((id) => <option key={id} value={id}>{id}</option>)}
            {draft.defaultLane !== "" && !laneIds.includes(draft.defaultLane) && <option value={draft.defaultLane}>{t("settingsPolicy.unconfigured", { lane: draft.defaultLane })}</option>}
          </select>
        </div>
        {errors["policy.defaultLane"] !== undefined && <p className="config-policy-error">{errors["policy.defaultLane"]}</p>}
        <div className="config-policy-rule-main">
          <span>{t("settingsPolicy.defaultCard")}</span>
          <input
            aria-label={t("settingsPolicy.defaultCardAria")}
            value={draft.defaultCard}
            placeholder={t("settingsPolicy.defaultCardPlaceholder")}
            onChange={(event) => onChange({ defaultCard: event.target.value })}
          />
        </div>
        {errors["policy.defaultCard"] !== undefined && <p className="config-policy-error">{errors["policy.defaultCard"]}</p>}
        {cardMissing && <p className="config-policy-advanced-note">{t("settingsPolicy.cardMissing", { id: wantedCard })}</p>}
        <p className="config-policy-footnote">{t("settingsPolicy.defaultsNote")}</p>
      </section>

      <section className="config-policy-group" aria-labelledby="policy-bounce-title">
        <div className="config-policy-heading">
          <div>
            <h3 id="policy-bounce-title">{t("settingsPolicy.bounceTitle")}</h3>
            <p>{t("settingsPolicy.bounceHint")}</p>
          </div>
          <span className="config-policy-scope">{t("settingsPolicy.scope")}</span>
        </div>
        <div className="config-policy-rules">
          {draft.bouncePatterns.length === 0 && <p className="config-policy-empty">{t("settingsPolicy.bounceEmpty")}</p>}
          {draft.bouncePatterns.map((row, index) => (
            <div className="config-policy-rule" key={`policy-bounce-${index}`}>
              <div className="config-policy-rule-main">
                <input
                  aria-label={t("settingsPolicy.codeAria", { index: index + 1 })}
                  value={row.code}
                  placeholder={t("settingsPolicy.codePlaceholder")}
                  onChange={(event) => updateBounceRow(index, { code: event.target.value })}
                />
                <input
                  aria-label={t("settingsPolicy.patternAria", { index: index + 1 })}
                  value={row.pattern}
                  placeholder={t("settingsPolicy.patternPlaceholder")}
                  onChange={(event) => updateBounceRow(index, { pattern: event.target.value })}
                />
                <input
                  aria-label={t("settingsPolicy.labelAria", { index: index + 1 })}
                  value={row.label}
                  placeholder={t("settingsPolicy.labelPlaceholder")}
                  onChange={(event) => updateBounceRow(index, { label: event.target.value })}
                />
                <button type="button" className="config-policy-remove" onClick={() => removeBounceRow(index)}>{t("settingsPolicy.remove")}</button>
              </div>
              {errors[`policy.bouncePatterns.${index}.code`] !== undefined && <p className="config-policy-error">{errors[`policy.bouncePatterns.${index}.code`]}</p>}
              {errors[`policy.bouncePatterns.${index}.pattern`] !== undefined && <p className="config-policy-error">{errors[`policy.bouncePatterns.${index}.pattern`]}</p>}
              {errors[`policy.bouncePatterns.${index}.label`] !== undefined && <p className="config-policy-error">{errors[`policy.bouncePatterns.${index}.label`]}</p>}
            </div>
          ))}
        </div>
        <div className="config-policy-add-row">
          <button type="button" className="btn" onClick={addBounceRow}>{t("settingsPolicy.addBounce")}</button>
        </div>
      </section>

      <p className="config-policy-footnote">{t("settingsPolicy.restartNote")}</p>
    </div>
  );
}

export default SettingsPolicySection;
