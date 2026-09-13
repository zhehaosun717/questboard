import type { PolicyDraft } from '../../lib/settingsForm';

interface SettingsPolicySectionProps {
  draft: PolicyDraft;
  onChange: (patch: Partial<PolicyDraft>) => void;
}

export function SettingsPolicySection({
  draft,
  onChange,
}: SettingsPolicySectionProps) {
  const updateModelPattern = (idx: number, val: string) => {
    const next = [...draft.bannedModelPatterns];
    next[idx] = val;
    onChange({ bannedModelPatterns: next });
  };

  const removeModelPattern = (idx: number) => {
    onChange({
      bannedModelPatterns: draft.bannedModelPatterns.filter((_, i) => i !== idx),
    });
  };

  const addModelPattern = () => {
    onChange({
      bannedModelPatterns: [...draft.bannedModelPatterns, ''],
    });
  };

  const updateAgent = (idx: number, val: string) => {
    const next = [...draft.bannedAgents];
    next[idx] = val;
    onChange({ bannedAgents: next });
  };

  const removeAgent = (idx: number) => {
    onChange({
      bannedAgents: draft.bannedAgents.filter((_, i) => i !== idx),
    });
  };

  const addAgent = () => {
    onChange({
      bannedAgents: [...draft.bannedAgents, ''],
    });
  };

  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">规则 (Policy)</h3>
      <div className="settings-card">
        <div className="policy-group">
          <label className="policy-group-title">禁止模型模式 (bannedModelPatterns)</label>
          <p className="hint">每项为一个正则表达式，匹配到的模型将被拒绝派单.</p>
          <div className="policy-inputs-list">
            {draft.bannedModelPatterns.map((pattern, idx) => (
              <div key={idx} className="policy-input-row">
                <input
                  className="mono-input flex-grow"
                  value={pattern}
                  placeholder="例如 -fast(\\b|-)"
                  onChange={(e) => updateModelPattern(idx, e.target.value)}
                />
                <button
                  type="button"
                  className="btn ghost sm-btn"
                  onClick={() => removeModelPattern(idx)}
                >
                  删除
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="btn ghost sm-btn"
                onClick={addModelPattern}
              >
                + 添加禁止模型模式
              </button>
            </div>
          </div>
        </div>

        <div className="policy-group" style={{ marginTop: '16px' }}>
          <label className="policy-group-title">禁止代理 (bannedAgents)</label>
          <p className="hint">每项为一个代理名称，禁止的代理将不能被选用.</p>
          <div className="policy-inputs-list">
            {draft.bannedAgents.map((agent, idx) => (
              <div key={idx} className="policy-input-row">
                <input
                  className="flex-grow"
                  value={agent}
                  placeholder="例如 sisyphus"
                  onChange={(e) => updateAgent(idx, e.target.value)}
                />
                <button
                  type="button"
                  className="btn ghost sm-btn"
                  onClick={() => removeAgent(idx)}
                >
                  删除
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="btn ghost sm-btn"
                onClick={addAgent}
              >
                + 添加禁止代理
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
