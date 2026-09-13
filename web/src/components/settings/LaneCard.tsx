import type { LaneDraft } from '../../lib/settingsForm';

interface LaneCardProps {
  lane: LaneDraft;
  index: number;
  errors: Record<string, string>;
  onUpdate: (patch: Partial<LaneDraft>) => void;
  onRemove: () => void;
}

export function LaneCard({
  lane,
  index,
  errors,
  onUpdate,
  onRemove,
}: LaneCardProps) {
  const idErr = errors[`lanes.${index}.id`] || errors[`lanes.${lane.id}.id`];
  const runErr = errors[`lanes.${index}.run`] || errors[`lanes.${lane.id}.run`];
  const spacingErr = errors[`lanes.${index}.spacingMs`] || errors[`lanes.${lane.id}.spacingMs`];
  const counterErr = errors[`lanes.${index}.editCounter`] || errors[`lanes.${lane.id}.editCounter`];
  const envErr = errors[`lanes.${index}.env`] || errors[`lanes.${lane.id}.env`];

  const updateRunArg = (argIdx: number, val: string) => {
    const nextRun = [...lane.run];
    nextRun[argIdx] = val;
    onUpdate({ run: nextRun });
  };

  const removeRunArg = (argIdx: number) => {
    onUpdate({ run: lane.run.filter((_, i) => i !== argIdx) });
  };

  const addRunArg = () => {
    onUpdate({ run: [...lane.run, ''] });
  };

  const updateSessionArg = (argIdx: number, val: string) => {
    const nextSessionRun = [...lane.sessionRun];
    nextSessionRun[argIdx] = val;
    onUpdate({ sessionRun: nextSessionRun });
  };

  const removeSessionArg = (argIdx: number) => {
    onUpdate({ sessionRun: lane.sessionRun.filter((_, i) => i !== argIdx) });
  };

  const addSessionArg = () => {
    onUpdate({ sessionRun: [...lane.sessionRun, ''] });
  };

  return (
    <div className="settings-lane-block">
      <div className="settings-lane-header">
        <div className="form-field flex-grow">
          <label htmlFor={`cfg-lane-id-${index}`}>
            通道 ID
            {idErr ? <span className="field-error"> · {idErr}</span> : null}
          </label>
          <input
            id={`cfg-lane-id-${index}`}
            value={lane.id}
            placeholder="例如 codex"
            className="lane-id-input"
            onChange={(e) => onUpdate({ id: e.target.value })}
          />
        </div>
        <button type="button" className="btn ghost danger-text" onClick={onRemove}>
          删除这条通道
        </button>
      </div>

      <div className="form-field">
        <label>
          执行命令参数 (Run Arguments)
          {runErr ? <span className="field-error"> · {runErr}</span> : null}
        </label>
        <div className="lane-placeholders-hint">
          可用占位符：<code>{'{name}'}</code> <code>{'{brief}'}</code> <code>{'{model}'}</code>{' '}
          <code>{'{variant}'}</code> <code>{'{agent}'}</code> <code>{'{package}'}</code>
        </div>
        <div className="lane-args-list">
          {lane.run.map((arg, argIdx) => (
            <div key={argIdx} className="lane-arg-row">
              <span className="arg-index">#{argIdx + 1}</span>
              <input
                className="mono-input flex-grow"
                value={arg}
                placeholder="参数内容"
                onChange={(e) => updateRunArg(argIdx, e.target.value)}
              />
              <button type="button" className="btn ghost sm-btn" onClick={() => removeRunArg(argIdx)}>
                删除
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn ghost sm-btn" onClick={addRunArg}>
              + 添加参数
            </button>
          </div>
        </div>
      </div>

      <div className="form-grid-2">
        <div className="form-field">
          <label htmlFor={`cfg-lane-out-${index}`}>输出目录 (outputDir)</label>
          <input
            id={`cfg-lane-out-${index}`}
            value={lane.outputDir}
            placeholder=".questboard-data/workers/..."
            onChange={(e) => onUpdate({ outputDir: e.target.value })}
          />
        </div>
        <div className="form-field">
          <label htmlFor={`cfg-lane-api-${index}`}>接口服务 (api)</label>
          <input
            id={`cfg-lane-api-${index}`}
            value={lane.api}
            placeholder="例如 http://localhost:8000"
            onChange={(e) => onUpdate({ api: e.target.value })}
          />
        </div>
      </div>

      <div className="form-grid-2">
        <div className="form-field">
          <label htmlFor={`cfg-lane-deliv-${index}`}>交付目录 (deliveryDir - 可选)</label>
          <input
            id={`cfg-lane-deliv-${index}`}
            value={lane.deliveryDir}
            placeholder="例如 delivery/..."
            onChange={(e) => onUpdate({ deliveryDir: e.target.value })}
          />
        </div>
        <div className="form-field">
          <label htmlFor={`cfg-lane-model-${index}`}>默认模型 (defaultModel - 可选)</label>
          <input
            id={`cfg-lane-model-${index}`}
            value={lane.defaultModel}
            placeholder="例如 claude-3-5-sonnet"
            onChange={(e) => onUpdate({ defaultModel: e.target.value })}
          />
        </div>
      </div>

      <div className="form-grid-3">
        <div className="form-field">
          <label htmlFor={`cfg-lane-counter-${index}`}>
            编辑计数器 (editCounter)
            {counterErr ? <span className="field-error"> · {counterErr}</span> : null}
          </label>
          <select
            id={`cfg-lane-counter-${index}`}
            value={lane.editCounter}
            onChange={(e) => onUpdate({ editCounter: e.target.value })}
          >
            <option value="">默认 (patch)</option>
            <option value="patch">patch</option>
            <option value="stream-json">stream-json</option>
          </select>
        </div>

        <div className="form-field">
          <label htmlFor={`cfg-lane-spacing-${index}`}>
            间隔时间 (spacingMs - 毫秒)
            {spacingErr ? <span className="field-error"> · {spacingErr}</span> : null}
          </label>
          <input
            id={`cfg-lane-spacing-${index}`}
            type="number"
            min={0}
            value={lane.spacingMs}
            placeholder="0"
            onChange={(e) => onUpdate({ spacingMs: e.target.value })}
          />
        </div>

        <div className="form-field flex-center-bottom">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={lane.serialize}
              onChange={(e) => onUpdate({ serialize: e.target.checked })}
            />
            <span>并发策略：排队执行</span>
          </label>
        </div>
      </div>

      <div className="form-field">
        <label htmlFor={`cfg-lane-env-${index}`}>
          环境变量（可选，每行 NAME=值；不要放密钥）
          {envErr ? <span className="field-error"> · {envErr}</span> : null}
        </label>
        <textarea
          id={`cfg-lane-env-${index}`}
          rows={2}
          value={lane.env}
          placeholder="FOO=bar"
          onChange={(e) => onUpdate({ env: e.target.value })}
        />
      </div>

      <div className="lane-session-block">
        <h4 className="lane-sub-title">会话记录步骤 (Session - 可选)</h4>
        <div className="form-field">
          <label htmlFor={`cfg-lane-sess-save-${index}`}>会话保存路径 (saveTo)</label>
          <input
            id={`cfg-lane-sess-save-${index}`}
            value={lane.sessionSaveTo}
            placeholder=".questboard-data/sessions/{package}.json"
            onChange={(e) => onUpdate({ sessionSaveTo: e.target.value })}
          />
        </div>
        <div className="form-field">
          <label>会话执行参数 (Session Run Arguments)</label>
          <div className="lane-args-list">
            {lane.sessionRun.map((arg, sIdx) => (
              <div key={sIdx} className="lane-arg-row">
                <span className="arg-index">#{sIdx + 1}</span>
                <input
                  className="mono-input flex-grow"
                  value={arg}
                  placeholder="会话参数"
                  onChange={(e) => updateSessionArg(sIdx, e.target.value)}
                />
                <button type="button" className="btn ghost sm-btn" onClick={() => removeSessionArg(sIdx)}>
                  删除
                </button>
              </div>
            ))}
            <div>
              <button type="button" className="btn ghost sm-btn" onClick={addSessionArg}>
                + 添加会话参数
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
