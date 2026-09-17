import {
  eventKindLabel,
  historyFiltersActive,
  STATUS_KIND_FILTER,
  type HistoryFilters,
} from '../../lib/history';
import { useT } from '../../lib/i18n';

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
  const t = useT();
  const set = (patch: Partial<HistoryFilters>) => onChange({ ...value, ...patch });
  const active = historyFiltersActive(value);
  const kindLabel = (kind: string) =>
    kind === STATUS_KIND_FILTER ? t('historyFilters.statusKind') : eventKindLabel(kind);
  const timeErrorId = `${idPrefix}-time-error`;
  const invalidNoteId = `${idPrefix}-invalid-note`;

  return (
    <div className="hist-filters" role="group" aria-label={t('historyFilters.groupLabel')}>
      <div className="hist-filter-field hist-filter-search">
        <label htmlFor={`${idPrefix}-pkg`}>{t('historyFilters.quest')}</label>
        <input
          id={`${idPrefix}-pkg`}
          type="search"
          value={value.packageText}
          placeholder={t('historyFilters.questPlaceholder')}
          onChange={(e) => set({ packageText: e.target.value })}
        />
      </div>
      <div className="hist-filter-field">
        <label htmlFor={`${idPrefix}-lane`}>{t('historyFilters.lane')}</label>
        <select id={`${idPrefix}-lane`} value={value.lane} onChange={(e) => set({ lane: e.target.value })}>
          <option value="">{t('historyFilters.allLanes')}</option>
          {options.lanes.map((lane) => (
            <option key={lane} value={lane}>{lane}</option>
          ))}
        </select>
      </div>
      <div className="hist-filter-field">
        <label htmlFor={`${idPrefix}-model`}>{t('historyFilters.model')}</label>
        <select id={`${idPrefix}-model`} value={value.model} onChange={(e) => set({ model: e.target.value })}>
          <option value="">{t('historyFilters.allModels')}</option>
          {options.models.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
      </div>
      <div className="hist-filter-field">
        <label htmlFor={`${idPrefix}-kind`}>{t('historyFilters.kind')}</label>
        <select
          id={`${idPrefix}-kind`}
          value={value.eventKind}
          onChange={(e) => set({ eventKind: e.target.value })}
        >
          <option value="">{t('historyFilters.allKinds')}</option>
          {options.kinds.map((kind) => (
            <option key={kind} value={kind}>{kindLabel(kind)}</option>
          ))}
        </select>
      </div>
      <div className="hist-filter-field">
        <label htmlFor={`${idPrefix}-from`}>{t('historyFilters.from')}</label>
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
        <label htmlFor={`${idPrefix}-to`}>{t('historyFilters.to')}</label>
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
            ? t('historyFilters.matched', { matched, loaded })
            : t('historyFilters.loaded', { loaded })}
        </span>
        {timeError && <span id={timeErrorId} className="hist-filter-error" role="alert">{timeError}</span>}
        {invalidAtCount > 0 && (
          <span className="hist-filter-note-group">
            <span id={invalidNoteId} className="hist-filter-note">
              {value.onlyInvalidAt
                ? t('historyFilters.onlyInvalidOn', { count: invalidAtCount })
                : t('historyFilters.invalidNote', { count: invalidAtCount })}
            </span>
            <button
              type="button"
              className="hist-filter-inspect"
              aria-pressed={value.onlyInvalidAt}
              aria-describedby={invalidNoteId}
              onClick={() => set({ onlyInvalidAt: !value.onlyInvalidAt })}
            >
              {value.onlyInvalidAt ? t('historyFilters.showAll') : t('historyFilters.showOnlyInvalid')}
            </button>
          </span>
        )}
        {active && (
          <button type="button" className="hist-filter-clear" onClick={onClear}>
            {t('history.clearFilters')}
          </button>
        )}
      </div>
    </div>
  );
}
