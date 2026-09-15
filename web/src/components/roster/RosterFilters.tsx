import { CARD_STATUS } from '../../lib/labels';
import { rosterFilterActive, ROSTER_STATUSES, type RosterFilterOptions, type RosterFilterState } from '../../lib/rosterFilter';
import '../../styles/roster-discovery.css';

export interface RosterFiltersProps {
  value: RosterFilterState;
  options: RosterFilterOptions;
  total: number;
  visible: number;
  onChange: (next: RosterFilterState) => void;
  idPrefix: string;
  compact?: boolean;
}

/** One search + filter bar shared by the guild sidebar and the 冒险者（模型） page (QB-FB-B). */
export function RosterFilters({ value, options, total, visible, onChange, idPrefix, compact }: RosterFiltersProps) {
  const active = rosterFilterActive(value);
  const set = (patch: Partial<RosterFilterState>) => onChange({ ...value, ...patch });
  const classes = ['roster-filters', compact ? 'roster-filters--compact' : ''].filter(Boolean).join(' ');

  return (
    <div className={classes} role="group" aria-label="筛选冒险者">
      <div className="roster-filter-field roster-filter-search">
        <label htmlFor={`${idPrefix}-search`}>搜索</label>
        <input
          id={`${idPrefix}-search`}
          type="search"
          value={value.search}
          placeholder="编号 / 名字 / 模型标识"
          aria-label="按编号、名字或模型标识搜索冒险者"
          onChange={(e) => set({ search: e.target.value })}
        />
      </div>
      <div className="roster-filter-field">
        <label htmlFor={`${idPrefix}-provider`}>服务商</label>
        <select
          id={`${idPrefix}-provider`}
          value={value.provider}
          onChange={(e) => set({ provider: e.target.value })}
        >
          <option value="">全部服务商</option>
          {options.providers.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>
      <div className="roster-filter-field">
        <label htmlFor={`${idPrefix}-lane`}>接入方式</label>
        <select id={`${idPrefix}-lane`} value={value.lane} onChange={(e) => set({ lane: e.target.value })}>
          <option value="">全部接入方式</option>
          {options.lanes.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </div>
      <div className="roster-filter-field">
        <label htmlFor={`${idPrefix}-status`}>状态</label>
        <select
          id={`${idPrefix}-status`}
          value={value.status}
          onChange={(e) => set({ status: e.target.value as RosterFilterState['status'] })}
        >
          <option value="">全部状态</option>
          {ROSTER_STATUSES.map((s) => (
            <option key={s} value={s}>{CARD_STATUS[s]}</option>
          ))}
        </select>
      </div>
      <div className="roster-filter-foot">
        <span className="roster-filter-count" aria-live="polite">
          {active ? `显示 ${visible} / ${total} 位` : `共 ${total} 位`}
        </span>
        {active && (
          <button type="button" className="roster-filter-clear" onClick={() => onChange({ ...value, search: '', provider: '', lane: '', status: '' })}>
            清除筛选
          </button>
        )}
      </div>
    </div>
  );
}
