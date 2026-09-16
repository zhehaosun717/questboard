import { useState } from 'react';
import type { Card, LaneServerStatus } from '../../api/types';
import { describeMalformedHealth, OPENCODE_HEALTH_PRESET, type LaneDraft } from '../../lib/settingsForm';
import { LaneServerPanel, type LaneServerMessage } from './LaneServerPanel';
import { OptionalArgsEditor } from './OptionalArgsEditor';
import { ArgvPreview } from './ArgvPreview';

interface LaneCardProps {
  lane: LaneDraft;
  index: number;
  errors: Record<string, string>;
  server: LaneServerStatus | undefined;
  serverStarting: boolean;
  serverMessage: LaneServerMessage | undefined;
  onStartServer: () => void;
  onUpdate: (patch: Partial<LaneDraft>) => void;
  onRemove: () => void;
  roster?: readonly Card[];
}

export function LaneCard({
  lane,
  index,
  errors,
  server,
  serverStarting,
  serverMessage,
  onStartServer,
  onUpdate,
  onRemove,
  roster,
}: LaneCardProps) {
  const serveErr = errors[`lanes.${index}.serve`] || errors[`lanes.${lane.id}.serve`];
  const idErr = errors[`lanes.${index}.id`] || errors[`lanes.${lane.id}.id`];
  const runErr = errors[`lanes.${index}.run`] || errors[`lanes.${lane.id}.run`];
  const spacingErr = errors[`lanes.${index}.spacingMs`] || errors[`lanes.${lane.id}.spacingMs`];
  const counterErr = errors[`lanes.${index}.editCounter`] || errors[`lanes.${lane.id}.editCounter`];
  const envErr = errors[`lanes.${index}.env`] || errors[`lanes.${lane.id}.env`];
  const apiErr = errors[`lanes.${index}.api`] || errors[`lanes.${lane.id}.api`];
  const healthPathErr = errors[`lanes.${index}.healthPath`] || errors[`lanes.${lane.id}.healthPath`];
  const healthJsonErr = errors[`lanes.${index}.healthJson`] || errors[`lanes.${lane.id}.healthJson`];
  const hasOptionalArgsErr = Object.keys(errors).some(
    (k) =>
      k.startsWith(`lanes.${index}.optionalArgs`) ||
      k.startsWith(`lanes.${lane.id}.optionalArgs`) ||
      k.startsWith('optionalArgs'),
  );

  // "Opened, not filled yet": lets a freshly checked box keep showing its (still empty) fields. Deliberately
  // NOT combined with `errors` below — those come from the last save attempt, are keyed by index/id, and do
  // not get cleared or recomputed on every edit, so a lane that shifted position (a delete above it) or was
  // simply corrected could otherwise inherit a stale error and end up checked/open (or stuck) for the wrong
  // reason. Whether the box is checked and open is decided purely by what is actually in this lane's own draft.
  const [healthOpen, setHealthOpen] = useState(false);
  const hasHealthValue = lane.healthPath.trim() !== '' || lane.healthJson.trim() !== '' || lane.healthMalformed !== undefined;
  const showHealthFields = healthOpen || hasHealthValue;
  // The stale-value banner only makes sense while the path is still whatever the file had (blank, since a
  // malformed value never parses into healthPath). Once the owner types a repair, `healthPathErr` — the
  // format error for what they actually typed, e.g. "abc" — takes over instead of hiding behind this message.
  const showMalformedBanner = lane.healthMalformed !== undefined && !lane.healthPath.trim();
  // The block itself stays hidden for a plain lane with no api and no health, same as before; it only has to
  // stay reachable once there is something to see (a configured or invalid health left over after api was
  // cleared), so clearing it is never a dead end.
  const showHealthBlock = lane.api.trim() !== '' || showHealthFields;

  const toggleHealth = (checked: boolean) => {
    setHealthOpen(checked);
    // Unchecking is the explicit disable: it also drops a preserved malformed value, since keeping health
    // hidden-but-remembered would defeat the point of a checkbox the owner just turned off.
    if (!checked) onUpdate({ healthPath: '', healthJson: '', healthMalformed: undefined });
  };

  const applyOpenCodeHealthPreset = () => {
    setHealthOpen(true);
    onUpdate({ healthPath: OPENCODE_HEALTH_PRESET.path, healthJson: OPENCODE_HEALTH_PRESET.json });
  };

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
            接入方式 ID
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
          删除这种接入方式
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

      <details
        className="lane-optional-args-section"
        open={hasOptionalArgsErr ? true : undefined}
      >
        <summary className="lane-optional-args-summary">
          <span className="optional-args-summary-title">可选参数 (Optional Arguments)</span>
          {lane.optionalArgs && lane.optionalArgs.length > 0 ? (
            <span className="optional-args-count-badge">已配置 {lane.optionalArgs.length} 组</span>
          ) : (
            <span className="optional-args-empty-badge">未配置</span>
          )}
        </summary>
        <div className="lane-optional-args-content">
          <OptionalArgsEditor
            laneId={lane.id}
            laneIndex={index}
            run={lane.run}
            optionalArgs={lane.optionalArgs || []}
            malformed={lane.optionalArgsMalformed}
            onChange={(optionalArgs) => onUpdate({ optionalArgs, optionalArgsMalformed: undefined })}
            errors={errors}
          />
          <ArgvPreview lane={lane} roster={roster} />
        </div>
      </details>

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
          <label htmlFor={`cfg-lane-api-${index}`}>
            接口服务 (api)
            {apiErr ? <span className="field-error"> · {apiErr}</span> : null}
          </label>
          <input
            id={`cfg-lane-api-${index}`}
            value={lane.api}
            placeholder="例如 http://localhost:8000"
            onChange={(e) => onUpdate({ api: e.target.value })}
          />
        </div>
      </div>

      {lane.api.trim() ? (
        <div className="form-field">
          <LaneServerPanel server={server} starting={serverStarting} message={serverMessage} onStart={onStartServer} />
          <label>
            启动服务的命令 (serve - 可选)
            {serveErr ? <span className="field-error"> · {serveErr}</span> : null}
          </label>
          <div className="lane-placeholders-hint">
            例如 <code>opencode</code> <code>serve</code> <code>--port</code> <code>6096</code>，每格一个参数；整个接入方式只跑一次，不能用占位符
          </div>
          <div className="lane-args-list">
            {lane.serve.map((arg, argIdx) => (
              <div key={argIdx} className="lane-arg-row">
                <span className="arg-index">#{argIdx + 1}</span>
                <input
                  className="mono-input flex-grow"
                  value={arg}
                  placeholder="参数内容"
                  onChange={(e) => onUpdate({ serve: lane.serve.map((old, i) => (i === argIdx ? e.target.value : old)) })}
                />
                <button type="button" className="btn ghost sm-btn" onClick={() => onUpdate({ serve: lane.serve.filter((_, i) => i !== argIdx) })}>
                  删除
                </button>
              </div>
            ))}
            <div>
              <button type="button" className="btn ghost sm-btn" onClick={() => onUpdate({ serve: [...lane.serve, ''] })}>
                + 添加参数
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showHealthBlock ? (
        <div className="form-field lane-health-block">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={showHealthFields}
              onChange={(e) => toggleHealth(e.target.checked)}
            />
            <span>健康检查 (health - 可选，不开启就沿用旧规则：接口有响应即算正常)</span>
          </label>

          {showHealthFields ? (
            <div className="lane-health-fields">
              {showMalformedBanner ? (
                <div className="lane-health-hint lane-health-malformed">
                  从文件读到的健康检查写法不对：{describeMalformedHealth(lane.healthMalformed)}。填一个有效路径可以修复，或者取消勾选来关闭健康检查（关闭前不会丢掉原来的写法）。
                </div>
              ) : null}
              <div className="form-field">
                <label htmlFor={`cfg-lane-health-path-${index}`}>
                  检查路径（相对于上面的 api，例如 /global/health）
                  {healthPathErr && !showMalformedBanner ? <span className="field-error"> · {healthPathErr}</span> : null}
                </label>
                <div className="lane-health-path-row">
                  <input
                    id={`cfg-lane-health-path-${index}`}
                    className="mono-input flex-grow"
                    value={lane.healthPath}
                    placeholder="/global/health"
                    onChange={(e) => onUpdate({ healthPath: e.target.value })}
                  />
                  <button type="button" className="btn ghost sm-btn" onClick={applyOpenCodeHealthPreset}>
                    套用 OpenCode 预设
                  </button>
                </div>
                {!lane.healthPath.trim() && !lane.healthJson.trim() && !healthPathErr && !healthJsonErr && lane.healthMalformed === undefined ? (
                  <div className="lane-health-hint">路径留空保存 = 不做健康检查</div>
                ) : null}
              </div>
              <div className="form-field">
                <label htmlFor={`cfg-lane-health-json-${index}`}>
                  期望字段（可选，JSON 对象，例如 {'{"healthy":true}'}；不填就只看有没有响应）
                  {healthJsonErr ? <span className="field-error"> · {healthJsonErr}</span> : null}
                </label>
                <textarea
                  id={`cfg-lane-health-json-${index}`}
                  rows={2}
                  className="mono-input"
                  value={lane.healthJson}
                  placeholder='{"healthy":true}'
                  onChange={(e) => onUpdate({ healthJson: e.target.value })}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="form-grid-2">
        <div className="form-field">
          <label htmlFor={`cfg-lane-deliv-${index}`}>交差目录 (deliveryDir - 可选)</label>
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
