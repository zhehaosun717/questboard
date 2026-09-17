import type { OptionalArgGroupDraft } from '../../lib/settingsForm';
import { t as tStatic, useT } from '../../lib/i18n';
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
  const argsStr = group.args.length > 0 ? group.args.join(' ') : tStatic('optionalArgs.emptyArgs');
  let omitStr = tStatic('optionalArgs.omitDefault');
  if (group.omitWhen && group.omitWhen.length > 0) {
    omitStr = tStatic('optionalArgs.omitList', { values: group.omitWhen.join(tStatic('common.listSeparator')) });
  }
  return tStatic('optionalArgs.summary', { when: whenLabel, pos, args: argsStr, omit: omitStr });
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
  const t = useT();
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
        <div className="optional-args-intro">{t('optionalArgs.intro')}</div>
      </div>

      {optionalArgs.length === 0 ? (
        <div className="optional-args-empty">{t('optionalArgs.empty')}</div>
      ) : (
        <div className="optional-args-groups-list">
          {optionalArgs.map((group, gIdx) => {
            if (group.parseError) {
              const rawText = JSON.stringify(group.rawOptionalArg);
              return (
                <div key={gIdx} className="optional-arg-group-card optional-arg-malformed-card">
                  <div className="group-card-header">
                    <div className="group-card-title">
                      <span className="group-badge">{t('optionalArgs.groupBadge', { index: gIdx + 1 })}</span>
                      <span className="group-summary-plain">{t('optionalArgs.malformedKept')}</span>
                    </div>
                    <button
                      type="button"
                      className="btn ghost sm-btn danger-text"
                      onClick={() => removeGroup(gIdx)}
                    >
                      {t('optionalArgs.removeGroupMalformed')}
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
              ? t('optionalArgs.placeholderWarning', { placeholder: `{${group.when}}` })
              : null;

            const isInsertAtOutOfRange =
              typeof group.insertAt === 'number' &&
              (group.insertAt < minInsertAt || group.insertAt > maxInsertAt);

            return (
              <div key={gIdx} className="optional-arg-group-card">
                <div className="group-card-header">
                  <div className="group-card-title">
                    <span className="group-badge">{t('optionalArgs.groupBadge', { index: gIdx + 1 })}</span>
                    <span className="group-summary-plain">{summaryText}</span>
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm-btn danger-text"
                    onClick={() => removeGroup(gIdx)}
                  >
                    {t('optionalArgs.removeGroup')}
                  </button>
                </div>

                {groupGeneralErr ? (
                  <div className="warn-tape group-error-banner">{groupGeneralErr}</div>
                ) : null}

                {unknownKeys.length > 0 ? (
                  <div className="group-unknown-fields-badge">
                    <span className="badge-label">{t('optionalArgs.unknownFields')}</span>
                    <code>{unknownKeys.join(', ')}</code>
                  </div>
                ) : null}

                <div className="form-grid-2 group-controls-row">
                  <div className="form-field">
                    <label htmlFor={`cfg-opt-when-${laneId}-${gIdx}`}>
                      {t('optionalArgs.whenLabel')}
                      {whenErr ? <span className="field-error"> · {whenErr}</span> : null}
                    </label>
                    <select
                      id={`cfg-opt-when-${laneId}-${gIdx}`}
                      value={group.when}
                      onChange={(e) => updateGroup(gIdx, { when: e.target.value as 'variant' | 'agent' })}
                    >
                      <option value="variant">{t('optionalArgs.whenVariant')}</option>
                      <option value="agent">{t('optionalArgs.whenAgent')}</option>
                    </select>
                    <span className="field-hint">{t('optionalArgs.whenHint')}</span>
                  </div>

                  <div className="form-field">
                    <label htmlFor={`cfg-opt-insert-${laneId}-${gIdx}`}>
                      {t('optionalArgs.insertLabel')}
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
                      {t('optionalArgs.range', { min: minInsertAt, max: maxInsertAt })}
                      {run[0] === 'node' ? t('optionalArgs.rangeNodeNote') : t('optionalArgs.rangeNote')}
                    </span>
                    {isInsertAtOutOfRange ? (
                      <span className="field-error">
                        {t('optionalArgs.rangeError', { min: minInsertAt, max: maxInsertAt })}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="form-field">
                  <label>
                    {t('optionalArgs.argsLabel')}
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
                              placeholder={t('optionalArgs.argPlaceholder', { placeholder: `{${group.when}}` })}
                              onChange={(e) => updateArg(gIdx, aIdx, e.target.value)}
                            />
                            {isWhitespaceOnly ? (
                              <span className="field-error">{t('optionalArgs.argWhitespace')}</span>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className="btn ghost sm-btn"
                            onClick={() => removeArg(gIdx, aIdx)}
                          >
                            {t('optionalArgs.remove')}
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
                        {t('optionalArgs.addArg')}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="form-field">
                  <label>
                    {t('optionalArgs.omitLabel')}
                    {omitWhenErr ? <span className="field-error"> · {omitWhenErr}</span> : null}
                  </label>
                  <div className="field-hint">
                    {t('optionalArgs.omitHint')}
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
                              placeholder={t('optionalArgs.omitPlaceholder')}
                              onChange={(e) => updateOmitWhen(gIdx, oIdx, e.target.value)}
                            />
                            {isOmitWhitespace ? (
                              <span className="field-error">{t('optionalArgs.omitWhitespace')}</span>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className="btn ghost sm-btn"
                            onClick={() => removeOmitWhen(gIdx, oIdx)}
                          >
                            {t('optionalArgs.remove')}
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
                        {t('optionalArgs.addOmit')}
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
          <div className="warn-tape group-error-banner">{t('optionalArgs.malformedList')}</div>
          <pre className="optional-arg-raw-value">{JSON.stringify(malformed)}</pre>
          <button type="button" className="btn ghost sm-btn danger-text" onClick={() => onChange([])}>
            {t('optionalArgs.removeMalformed')}
          </button>
        </div>
      ) : null}

      <div className="optional-args-footer">
        <button
          type="button"
          className="btn ghost sm-btn"
          onClick={addGroup}
        >
          {t('optionalArgs.addGroup')}
        </button>
      </div>
    </div>
  );
}
