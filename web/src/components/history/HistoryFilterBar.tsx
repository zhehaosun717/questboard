import {
  eventKindLabel,
  historyFiltersActive,
  STATUS_KIND_FILTER,
  type HistoryFilters,
} from '../../lib/history';

/**
 * The history filter bar (QB-FB-HISTORY): task text + lane + model + event kind + time window combine
 * (AND). Choices come from what is LOADED, so an option never promises records that were never read;
 * the count row states matches over loaded, and a bad time window refuses loudly.
 */
export interface HistoryFilterBarProps {
  value: HistoryFilters;
  options: { lanes: string[]; models: string[]; kinds: string[] };
  /** matches / loaded — honest result count over what was actually read. */
  matched: number;
  loaded: number;
  /** Set while a date input holds an unusable value; the time filter must not be applied silently. */
  timeError: string | null;
  /**
   * How many of the matched records (before the "only these" toggle narrows anything further) have a
   * time no window can judge (unparseable `at`). They stay in the results below regardless of a time
   * filter — this says so, and offers a way to inspect exactly them (review 73f4bd71 B2/revision4).
   */
  invalidAtCount: number;
  onChange: (next: HistoryFilters) => void;
  onClear: () => void;
  idPrefix: string;
}

export function HistoryFilterBar({
  value, options, matched, loaded, timeError, invalidAtCount, onChange, onClear, idPrefix,
}: HistoryFilterBarProps) {
  const set = (patch: Partial<HistoryFilters>) => onChange({ ...value, ...patch });
  const active = historyFiltersActive(value);
  const kindLabel = (kind: string) =>
    kind === STATUS_KIND_FILTER ? '委托状态记录（系统）' : eventKindLabel(kind);
  const timeErrorId = `${idPrefix}-time-error`;
  const invalidNoteId = `${idPrefix}-invalid-note`;

  return (
    <div className="hist-filters" role="group" aria-label="筛选事件记录">
      <div className="hist-filter-field hist-filter-search">
        <label htmlFor={`${idPrefix}-pkg`}>委托</label>
        <input
          id={`${idPrefix}-pkg`}
          type="search"
          value={value.packageText}
          placeholder="委托编号包含的文字"
          onChange={(e) => set({ packageText: e.target.value })}
        />
      </div>
      <div className="hist-filter-field">
        <label htmlFor={`${idPrefix}-lane`}>接入方式</label>
        <select id={`${idPrefix}-lane`} value={value.lane} onChange={(e) => set({ lane: e.target.value })}>
          <option value="">全部接入方式</option>
          {options.lanes.map((lane) => (
            <option key={lane} value={lane}>{lane}</option>
          ))}
        </select>
      </div>
      <div className="hist-filter-field">
        <label htmlFor={`${idPrefix}-model`}>模型</label>
        <select id={`${idPrefix}-model`} value={value.model} onChange={(e) => set({ model: e.target.value })}>
          <option value="">全部模型</option>
          {options.models.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
      </div>
      <div className="hist-filter-field">
        <label htmlFor={`${idPrefix}-kind`}>事件类型</label>
        <select
          id={`${idPrefix}-kind`}
          value={value.eventKind}
          onChange={(e) => set({ eventKind: e.target.value })}
        >
          <option value="">全部类型</option>
          {options.kinds.map((kind) => (
            <option key={kind} value={kind}>{kindLabel(kind)}</option>
          ))}
        </select>
      </div>
      <div className="hist-filter-field">
        <label htmlFor={`${idPrefix}-from`}>开始时间</label>
        <input
          id={`${idPrefix}-from`}
          type="datetime-local"
          value={value.from}
          aria-invalid={timeError ? true : undefined}
          aria-describedby={timeError ? timeErrorId : undefined}
          onChange={(e) => set({ from: e.target.value })}
        />
      </div>
      <div className="hist-filter-field">
        <label htmlFor={`${idPrefix}-to`}>结束时间（含该分钟）</label>
        <input
          id={`${idPrefix}-to`}
          type="datetime-local"
          value={value.to}
          aria-invalid={timeError ? true : undefined}
          aria-describedby={timeError ? timeErrorId : undefined}
          onChange={(e) => set({ to: e.target.value })}
        />
      </div>
      <div className="hist-filter-foot">
        <span className="hist-filter-count" aria-live="polite">
          {active || timeError
            ? `符合条件 ${matched} / 已加载 ${loaded} 条`
            : `已加载 ${loaded} 条事件`}
        </span>
        {timeError && <span id={timeErrorId} className="hist-filter-error" role="alert">{timeError}</span>}
        {invalidAtCount > 0 && (
          <span className="hist-filter-note-group">
            <span id={invalidNoteId} className="hist-filter-note">
              {value.onlyInvalidAt
                ? `只看时间无法识别的记录（共 ${invalidAtCount} 条）`
                : `其中 ${invalidAtCount} 条时间无法识别，不参与时间筛选判断，仍在下方列表中`}
            </span>
            <button
              type="button"
              className="hist-filter-inspect"
              aria-pressed={value.onlyInvalidAt}
              aria-describedby={invalidNoteId}
              onClick={() => set({ onlyInvalidAt: !value.onlyInvalidAt })}
            >
              {value.onlyInvalidAt ? '显示全部记录' : '只看这些记录'}
            </button>
          </span>
        )}
        {active && (
          <button type="button" className="hist-filter-clear" onClick={onClear}>
            清除筛选
          </button>
        )}
      </div>
    </div>
  );
}
