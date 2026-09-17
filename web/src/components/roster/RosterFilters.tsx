import { useT } from '../../lib/i18n';
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
  const t = useT();
  const active = rosterFilterActive(value);
  const set = (patch: Partial<RosterFilterState>) => onChange({ ...value, ...patch });
  const classes = ['roster-filters', compact ? 'roster-filters--compact' : ''].filter(Boolean).join(' ');

  return (
    <div className={classes} role="group" aria-label={t('rosterFilters.groupLabel')}>
      <div className="roster-filter-field roster-filter-search">
        <label htmlFor={`${idPrefix}-search`}>{t('rosterFilters.search')}</label>
        <input
          id={`${idPrefix}-search`}
          type="search"
          value={value.search}
          placeholder={t('rosterFilters.searchPlaceholder')}
          aria-label={t('rosterFilters.searchLabel')}
          onChange={(e) => set({ search: e.target.value })}
        />
      </div>
      <div className="roster-filter-field">
        <label htmlFor={`${idPrefix}-provider`}>{t('rosterFilters.provider')}</label>
        <select
          id={`${idPrefix}-provider`}
          value={value.provider}
          onChange={(e) => set({ provider: e.target.value })}
        >
          <option value="">{t('rosterFilters.allProviders')}</option>
          {options.providers.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>
      <div className="roster-filter-field">
        <label htmlFor={`${idPrefix}-lane`}>{t('rosterFilters.lane')}</label>
        <select id={`${idPrefix}-lane`} value={value.lane} onChange={(e) => set({ lane: e.target.value })}>
          <option value="">{t('rosterFilters.allLanes')}</option>
          {options.lanes.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </div>
      <div className="roster-filter-field">
        <label htmlFor={`${idPrefix}-status`}>{t('rosterFilters.status')}</label>
        <select
          id={`${idPrefix}-status`}
          value={value.status}
          onChange={(e) => set({ status: e.target.value as RosterFilterState['status'] })}
        >
          <option value="">{t('rosterFilters.allStatuses')}</option>
          {ROSTER_STATUSES.map((s) => (
            <option key={s} value={s}>{CARD_STATUS[s]}</option>
          ))}
        </select>
      </div>
      <div className="roster-filter-foot">
        <span className="roster-filter-count" aria-live="polite">
          {active
            ? t('rosterFilters.countFiltered', { visible, total })
            : t('rosterFilters.count', { total })}
        </span>
        {active && (
          <button type="button" className="roster-filter-clear" onClick={() => onChange({ ...value, search: '', provider: '', lane: '', status: '' })}>
            {t('rosterFilters.clear')}
          </button>
        )}
      </div>
    </div>
  );
}
