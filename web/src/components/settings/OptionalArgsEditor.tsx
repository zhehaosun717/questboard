import type { OptionalArgGroupDraft } from '../../lib/settingsForm';
import '../../styles/optional-args.css';

export interface OptionalArgsEditorProps {
  laneId: string;
  laneIndex?: number;
  run: string[];
  optionalArgs: OptionalArgGroupDraft[];
  malformed?: unknown;
  onChange: (optionalArgs: OptionalArgGroupDraft[]) => void;
  errors?: Record<string, string>;
}

const STANDARD_KEYS = new Set(['when', 'args', 'omitWhen', 'insertAt', 'parseError', 'rawOptionalArg']);

export function getUnknownFields(group: OptionalArgGroupDraft): Record<string, unknown> {
  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(group)) {
    if (!STANDARD_KEYS.has(k)) {
      unknown[k] = v;
    }
  }
  return unknown;
}

export function describeGroup(group: OptionalArgGroupDraft, runLength: number): string {
  const whenLabel = group.when === 'agent' ? 'agent' : 'variant';
  const pos = typeof group.insertAt === 'number' ? group.insertAt + 1 : runLength + 1;
  const argsStr = group.args.length > 0 ? group.args.join(' ') : '(未填写参数)';
  let omitStr = '未填写时整组省略';
  if (group.omitWhen && group.omitWhen.length > 0) {
    omitStr = `值为 ${group.omitWhen.join('、')} 时整组省略`;
  }
  return `当卡片填了 ${whenLabel} 时，在第 ${pos} 个位置插入 ${argsStr}；${omitStr}`;
}

export function OptionalArgsEditor({
  laneId,
  laneIndex,
  run,
  optionalArgs,
  malformed,
  onChange,
  errors = {},
}: OptionalArgsEditorProps) {
  const minInsertAt = run[0] === 'node' ? 2 : 1;
  const maxInsertAt = run.length;

  const getGroupError = (gIdx: number, subfield?: string): string | null => {
    const candidates = [
      laneIndex !== undefined ? `lanes.${laneIndex}.optionalArgs[${gIdx}]` : null,
      laneIndex !== undefined ? `lanes.${laneIndex}.optionalArgs.${gIdx}` : null,
      `lanes.${laneId}.optionalArgs[${gIdx}]`,
      `lanes.${laneId}.optionalArgs.${gIdx}`,
      `optionalArgs[${gIdx}]`,
    ].filter(Boolean) as string[];

    for (const base of candidates) {
      const full = subfield ? `${base}.${subfield}` : base;
      if (errors[full]) return errors[full];
    }
    return null;
  };

  const updateGroup = (gIdx: number, patch: Partial<OptionalArgGroupDraft>) => {
    const next = optionalArgs.map((g, i) => {
      if (i !== gIdx) return g;
      return { ...g, ...patch };
    });
    onChange(next);
  };

  const removeGroup = (gIdx: number) => {
    onChange(optionalArgs.filter((_, i) => i !== gIdx));
  };

  const addGroup = () => {
    const defaultInsert = run.length >= minInsertAt ? run.length : minInsertAt;
    const newGroup: OptionalArgGroupDraft = {
      when: 'variant',
      args: ['--effort', '{variant}'],
      omitWhen: ['none'],
      insertAt: defaultInsert,
    };
    onChange([...optionalArgs, newGroup]);
  };

  const updateArg = (gIdx: number, aIdx: number, val: string) => {
    const group = optionalArgs[gIdx];
    if (!group) return;
    const nextArgs = [...group.args];
    nextArgs[aIdx] = val;
    updateGroup(gIdx, { args: nextArgs });
  };

  const removeArg = (gIdx: number, aIdx: number) => {
    const group = optionalArgs[gIdx];
    if (!group) return;
    updateGroup(gIdx, { args: group.args.filter((_, i) => i !== aIdx) });
  };

  const addArg = (gIdx: number) => {
    const group = optionalArgs[gIdx];
    if (!group) return;
    updateGroup(gIdx, { args: [...group.args, ''] });
  };

  const updateOmitWhen = (gIdx: number, oIdx: number, val: string) => {
    const group = optionalArgs[gIdx];
    if (!group) return;
    const nextOmit = [...group.omitWhen];
    nextOmit[oIdx] = val;
    updateGroup(gIdx, { omitWhen: nextOmit });
  };

  const removeOmitWhen = (gIdx: number, oIdx: number) => {
    const group = optionalArgs[gIdx];
    if (!group) return;
    updateGroup(gIdx, { omitWhen: group.omitWhen.filter((_, i) => i !== oIdx) });
  };

  const addOmitWhen = (gIdx: number) => {
    const group = optionalArgs[gIdx];
    if (!group) return;
    updateGroup(gIdx, { omitWhen: [...group.omitWhen, ''] });
  };

  return (
    <div className="optional-args-editor">
      <div className="optional-args-header">
        <div className="optional-args-intro">
          配置特定卡片属性（如变体或智能体）存在时才插入的参数组。未填写对应属性或值匹配省略规则时整组自动忽略。
        </div>
      </div>

      {optionalArgs.length === 0 ? (
        <div className="optional-args-empty">
          暂未配置可选参数组。点击下方按钮添加。
        </div>
      ) : (
        <div className="optional-args-groups-list">
          {optionalArgs.map((group, gIdx) => {
            if (group.parseError) {
              const rawText = JSON.stringify(group.rawOptionalArg);
              return (
                <div key={gIdx} className="optional-arg-group-card optional-arg-malformed-card">
                  <div className="group-card-header">
                    <div className="group-card-title">
                      <span className="group-badge">组 #{gIdx + 1}</span>
                      <span className="group-summary-plain">无法解析，已原样保留</span>
                    </div>
                    <button
                      type="button"
                      className="btn ghost sm-btn danger-text"
                      onClick={() => removeGroup(gIdx)}
                    >
                      删除此组
                    </button>
                  </div>
                  <div className="warn-tape group-error-banner">{group.parseError}</div>
                  {rawText ? <pre className="optional-arg-raw-value">{rawText}</pre> : null}
                </div>
              );
            }
            const unknownFields = getUnknownFields(group);
            const unknownKeys = Object.keys(unknownFields);
            const summaryText = describeGroup(group, run.length);
            const groupGeneralErr = getGroupError(gIdx);
            const argsErr = getGroupError(gIdx, 'args');
            const whenErr = getGroupError(gIdx, 'when');
            const insertAtErr = getGroupError(gIdx, 'insertAt');
            const omitWhenErr = getGroupError(gIdx, 'omitWhen');

            const hasPlaceholder = group.args.some((a) => a.includes(`{${group.when}}`));
            const placeholderWarning = !hasPlaceholder
              ? `参数中建议包含 {${group.when}} 占位符，否则无法将对应属性值传给命令`
              : null;

            const isInsertAtOutOfRange =
              typeof group.insertAt === 'number' &&
              (group.insertAt < minInsertAt || group.insertAt > maxInsertAt);

            return (
              <div key={gIdx} className="optional-arg-group-card">
                <div className="group-card-header">
                  <div className="group-card-title">
                    <span className="group-badge">组 #{gIdx + 1}</span>
                    <span className="group-summary-plain">{summaryText}</span>
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm-btn danger-text"
                    onClick={() => removeGroup(gIdx)}
                  >
                    删除组
                  </button>
                </div>

                {groupGeneralErr ? (
                  <div className="warn-tape group-error-banner">{groupGeneralErr}</div>
                ) : null}

                {unknownKeys.length > 0 ? (
                  <div className="group-unknown-fields-badge">
                    <span className="badge-label">未知字段，已保留：</span>
                    <code>{unknownKeys.join(', ')}</code>
                  </div>
                ) : null}

                <div className="form-grid-2 group-controls-row">
                  <div className="form-field">
                    <label htmlFor={`cfg-opt-when-${laneId}-${gIdx}`}>
                      触发条件 (when)
                      {whenErr ? <span className="field-error"> · {whenErr}</span> : null}
                    </label>
                    <select
                      id={`cfg-opt-when-${laneId}-${gIdx}`}
                      value={group.when}
                      onChange={(e) => updateGroup(gIdx, { when: e.target.value as 'variant' | 'agent' })}
                    >
                      <option value="variant">variant（卡片填了变体时）</option>
                      <option value="agent">agent（卡片填了智能体时）</option>
                    </select>
                    <span className="field-hint">仅当所选卡片属性非空且未匹配省略列表时生效</span>
                  </div>

                  <div className="form-field">
                    <label htmlFor={`cfg-opt-insert-${laneId}-${gIdx}`}>
                      插入位置 (insertAt)
                      {insertAtErr ? <span className="field-error"> · {insertAtErr}</span> : null}
                    </label>
                    <input
                      id={`cfg-opt-insert-${laneId}-${gIdx}`}
                      type="number"
                      min={minInsertAt}
                      max={maxInsertAt}
                      value={group.insertAt ?? run.length}
                      onChange={(e) => updateGroup(gIdx, { insertAt: parseInt(e.target.value, 10) || minInsertAt })}
                    />
                    <span className="field-hint">
                      允许范围：{minInsertAt} ～ {maxInsertAt}
                      {run[0] === 'node'
                        ? '（第 0 位是 node，第 1 位是脚本文件）'
                        : '（第 0 位是执行程序）'}
                    </span>
                    {isInsertAtOutOfRange ? (
                      <span className="field-error">
                        插入位置超出范围（必须在 {minInsertAt} 到 {maxInsertAt} 之间）
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="form-field">
                  <label>
                    插入参数列表 (args - 每格一个参数，保留空格与引号)
                    {argsErr ? <span className="field-error"> · {argsErr}</span> : null}
                  </label>
                  {placeholderWarning ? (
                    <div className="field-hint warning-text">{placeholderWarning}</div>
                  ) : null}
                  <div className="group-args-list">
                    {group.args.map((arg, aIdx) => {
                      const isWhitespaceOnly = !arg.trim();
                      return (
                        <div key={aIdx} className="group-arg-row">
                          <span className="arg-index">#{aIdx + 1}</span>
                          <div className="arg-input-wrap flex-grow">
                            <input
                              className="mono-input full-width"
                              value={arg}
                              placeholder={`例如 --effort 或 {${group.when}}`}
                              onChange={(e) => updateArg(gIdx, aIdx, e.target.value)}
                            />
                            {isWhitespaceOnly ? (
                              <span className="field-error">参数不能仅为空白字符</span>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className="btn ghost sm-btn"
                            onClick={() => removeArg(gIdx, aIdx)}
                          >
                            删除
                          </button>
                        </div>
                      );
                    })}
                    <div>
                      <button
                        type="button"
                        className="btn ghost sm-btn"
                        onClick={() => addArg(gIdx)}
                      >
                        + 添加参数
                      </button>
                    </div>
                  </div>
                </div>

                <div className="form-field">
                  <label>
                    省略值列表 (omitWhen - 值为以下内容时整组忽略)
                    {omitWhenErr ? <span className="field-error"> · {omitWhenErr}</span> : null}
                  </label>
                  <div className="field-hint">
                    卡片属性未填、null 或空字符串时已默认省略整组；若填写了以下值（如 none、off），也整组省略。
                  </div>
                  <div className="group-omit-list">
                    {group.omitWhen.map((omitVal, oIdx) => {
                      const isOmitWhitespace = !omitVal.trim();
                      return (
                        <div key={oIdx} className="group-omit-row">
                          <span className="arg-index">#{oIdx + 1}</span>
                          <div className="arg-input-wrap flex-grow">
                            <input
                              className="mono-input full-width"
                              value={omitVal}
                              placeholder="例如 none 或 off"
                              onChange={(e) => updateOmitWhen(gIdx, oIdx, e.target.value)}
                            />
                            {isOmitWhitespace ? (
                              <span className="field-error">省略值不能仅为空白字符</span>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className="btn ghost sm-btn"
                            onClick={() => removeOmitWhen(gIdx, oIdx)}
                          >
                            删除
                          </button>
                        </div>
                      );
                    })}
                    <div>
                      <button
                        type="button"
                        className="btn ghost sm-btn"
                        onClick={() => addOmitWhen(gIdx)}
                      >
                        + 添加省略值
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {malformed !== undefined ? (
        <div className="optional-arg-malformed-card">
          <div className="warn-tape group-error-banner">无法解析，已原样保留：可选参数组必须是列表</div>
          <pre className="optional-arg-raw-value">{JSON.stringify(malformed)}</pre>
          <button type="button" className="btn ghost sm-btn danger-text" onClick={() => onChange([])}>
            删除无法解析的配置
          </button>
        </div>
      ) : null}

      <div className="optional-args-footer">
        <button
          type="button"
          className="btn ghost sm-btn"
          onClick={addGroup}
        >
          + 添加可选参数组
        </button>
      </div>
    </div>
  );
}
