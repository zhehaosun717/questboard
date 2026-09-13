import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { OmoConfig, OmoEntry, OmoSection as SectionType } from '../../api/types';
import {
  changedOmoRows,
  getRoleHint,
  OMO_REASONING_OPTIONS,
} from '../../lib/omo';

interface OmoSectionProps {
  pushToast: (msg: string) => void;
}

export function OmoSection({ pushToast }: OmoSectionProps) {
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
    return <div className="hint omo-loading">正在读取 OMO 配置…</div>;
  }

  if (configError) {
    return <div className="warn-tape">读取 OMO 配置失败：{configError}</div>;
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
      setSaveSuccessMsg('已保存（旧文件已备份）');
      pushToast('已保存 OMO 配置（旧文件已备份）');
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
              <th style={{ width: '220px' }}>名称</th>
              <th>模型 (provider/model)</th>
              <th style={{ width: '180px' }}>思考深度 (reasoning)</th>
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
                      {isRowChanged ? <span className="omo-changed-badge">已改</span> : null}
                    </div>
                  </td>
                  <td>
                    <input
                      className="omo-model-input"
                      list="omo-models-datalist"
                      value={item.model}
                      placeholder="留空或 provider/model"
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
          <span className="eyebrow">OPENCODE AGENT MODEL CONFIG</span>
          <h3>OpenCode 代理模型（OMO）</h3>
          <p className="hint">
            配置文件：<code>{config.file}</code>
          </p>
        </div>
        <div className="omo-header-actions">
          {loadingModels ? (
            <span className="dim-notice">正在读取模型列表…</span>
          ) : (
            <button
              className="btn"
              type="button"
              disabled={refreshingModels}
              onClick={() => fetchModels(true)}
            >
              {refreshingModels ? '正在刷新…' : '刷新模型列表'}
            </button>
          )}
          <button
            className="btn primary"
            type="button"
            disabled={changes.length === 0 || saving}
            onClick={handleSave}
          >
            {saving ? '正在保存…' : `保存修改 (${changes.length})`}
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

      {renderTable('代理 (Agents)', 'agents', editedAgents, changedAgentNames)}
      {renderTable('分类 (Categories)', 'categories', editedCategories, changedCategoryNames)}
    </div>
  );
}
