import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { OmoConfig, OmoEntry, OmoSection as SectionType } from '../../api/types';
import { useT } from '../../lib/i18n';
import {
  changedOmoRows,
  getRoleHint,
  OMO_REASONING_OPTIONS,
} from '../../lib/omo';

interface OmoSectionProps {
  pushToast: (msg: string) => void;
}

export function OmoSection({ pushToast }: OmoSectionProps) {
  const t = useT();
  const [config, setConfig] = useState<OmoConfig | null>(null);
  const [editedAgents, setEditedAgents] = useState<OmoEntry[]>([]);
  const [editedCategories, setEditedCategories] = useState<OmoEntry[]>([]);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);

  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchConfig = async () => {
    setLoadingConfig(true);
    try {
      const data = await api.omo();
      setConfig(data);
      setEditedAgents(data.agents.map((a) => ({ ...a })));
      setEditedCategories(data.categories.map((c) => ({ ...c })));
      setConfigError(null);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingConfig(false);
    }
  };

  const fetchModels = async (refresh = false) => {
    if (refresh) setRefreshingModels(true);
    else setLoadingModels(true);

    try {
      const res = await api.omoModels(refresh);
      setModels(res.models || []);
    } catch {
      // ignore models fetch failure, user can still type manually
    } finally {
      setLoadingModels(false);
      setRefreshingModels(false);
    }
  };

  useEffect(() => {
    fetchConfig();
    fetchModels(false);
  }, []);

  const handleModelChange = (
    section: SectionType,
    index: number,
    value: string,
  ) => {
    if (section === 'agents') {
      setEditedAgents((prev) => {
        const next = [...prev];
        const item = next[index];
        if (item) {
          next[index] = { ...item, model: value };
        }
        return next;
      });
    } else {
      setEditedCategories((prev) => {
        const next = [...prev];
        const item = next[index];
        if (item) {
          next[index] = { ...item, model: value };
        }
        return next;
      });
    }
  };

  const handleReasoningChange = (
    section: SectionType,
    index: number,
    value: string,
  ) => {
    if (section === 'agents') {
      setEditedAgents((prev) => {
        const next = [...prev];
        const item = next[index];
        if (item) {
          next[index] = { ...item, reasoning: value };
        }
        return next;
      });
    } else {
      setEditedCategories((prev) => {
        const next = [...prev];
        const item = next[index];
        if (item) {
          next[index] = { ...item, reasoning: value };
        }
        return next;
      });
    }
  };

  if (loadingConfig) {
    return <div className="hint omo-loading">{t('omo.loading')}</div>;
  }

  if (configError) {
    return <div className="warn-tape">{t('omo.loadFailed', { error: configError })}</div>;
  }

  // OMO is oh-my-openagent's own config, which most people do not have. Without it this section says nothing
  // useful, so it disappears entirely; the 设置 page still reports where it was looked for.
  if (!config || !config.available) return null;

  const changes = changedOmoRows(
    { agents: config.agents, categories: config.categories },
    { agents: editedAgents, categories: editedCategories },
  );

  const changedAgentNames = new Set(
    changes.filter((c) => c.section === 'agents').map((c) => c.name),
  );
  const changedCategoryNames = new Set(
    changes.filter((c) => c.section === 'categories').map((c) => c.name),
  );

  const handleSave = async () => {
    if (changes.length === 0) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccessMsg(null);
    try {
      const updated = await api.saveOmo(changes);
      setConfig(updated);
      setEditedAgents(updated.agents.map((a) => ({ ...a })));
      setEditedCategories(updated.categories.map((c) => ({ ...c })));
      setSaveSuccessMsg(t('omo.saved'));
      pushToast(t('omo.savedToast'));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const renderTable = (
    title: string,
    section: SectionType,
    items: OmoEntry[],
    changedNames: Set<string>,
  ) => (
    <div className="omo-sub-section">
      <h4 className="omo-table-title">{title}</h4>
      <div className="roster-table-wrap">
        <table className="roster-table omo-table">
          <thead>
            <tr>
              <th style={{ width: '220px' }}>{t('omo.colName')}</th>
              <th>{t('omo.colModel')}</th>
              <th style={{ width: '180px' }}>{t('omo.colReasoning')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => {
              const hint = getRoleHint(item.name);
              const isRowChanged = changedNames.has(item.name);

              return (
                <tr key={item.name} className={isRowChanged ? 'row-changed' : ''}>
                  <td>
                    <div className="omo-name-cell">
                      <strong className="omo-name">{item.name}</strong>
                      {hint ? <span className="omo-hint">{hint}</span> : null}
                      {isRowChanged ? <span className="omo-changed-badge">{t('omo.edited')}</span> : null}
                    </div>
                  </td>
                  <td>
                    <input
                      className="omo-model-input"
                      list="omo-models-datalist"
                      value={item.model}
                      placeholder={t('omo.modelPlaceholder')}
                      onChange={(e) =>
                        handleModelChange(section, idx, e.target.value)
                      }
                    />
                  </td>
                  <td>
                    <select
                      className="omo-reasoning-select"
                      value={item.reasoning}
                      onChange={(e) =>
                        handleReasoningChange(section, idx, e.target.value)
                      }
                    >
                      {OMO_REASONING_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="omo-section">
      <header className="omo-header">
        <div>
          <span className="eyebrow">{t('omo.eyebrow')}</span>
          <h3>{t('omo.title')}</h3>
          <p className="hint">
            {t('omo.configFile')}<code>{config.file}</code>
          </p>
        </div>
        <div className="omo-header-actions">
          {loadingModels ? (
            <span className="dim-notice">{t('omo.readingModels')}</span>
          ) : (
            <button
              className="btn"
              type="button"
              disabled={refreshingModels}
              onClick={() => fetchModels(true)}
            >
              {refreshingModels ? t('omo.refreshing') : t('omo.refreshModels')}
            </button>
          )}
          <button
            className="btn primary"
            type="button"
            disabled={changes.length === 0 || saving}
            onClick={handleSave}
          >
            {saving ? t('common.saving') : t('omo.saveChanges', { count: changes.length })}
          </button>
        </div>
      </header>

      {saveSuccessMsg ? (
        <div className="omo-save-msg ok">{saveSuccessMsg}</div>
      ) : null}
      {saveError ? (
        <div className="warn-tape omo-save-msg">{saveError}</div>
      ) : null}

      <datalist id="omo-models-datalist">
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      {renderTable(t('omo.tableAgents'), 'agents', editedAgents, changedAgentNames)}
      {renderTable(t('omo.tableCategories'), 'categories', editedCategories, changedCategoryNames)}
    </div>
  );
}
