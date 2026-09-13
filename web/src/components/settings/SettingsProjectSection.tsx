import type { ProjectDraft } from '../../lib/settingsForm';

interface SettingsProjectSectionProps {
  draft: ProjectDraft;
  paths: { data: string; events: string; registry: string; lock: string };
  errors: Record<string, string>;
  onChange: (patch: Partial<ProjectDraft>) => void;
}

export function SettingsProjectSection({
  draft,
  paths,
  errors,
  onChange,
}: SettingsProjectSectionProps) {
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">项目 (Project)</h3>
      <div className="settings-card">
        <div className="settings-fields-grid">
          <div className="form-field">
            <label htmlFor="cfg-proj-name">
              项目名称
              {errors['project.name'] ? (
                <span className="field-error"> · {errors['project.name']}</span>
              ) : null}
            </label>
            <input
              id="cfg-proj-name"
              value={draft.name}
              placeholder="例如 My Game"
              onChange={(e) => onChange({ name: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label htmlFor="cfg-proj-port">
              服务端口
              {errors['project.port'] ? (
                <span className="field-error"> · {errors['project.port']}</span>
              ) : null}
            </label>
            <input
              id="cfg-proj-port"
              value={draft.port}
              placeholder="6097"
              onChange={(e) => onChange({ port: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label htmlFor="cfg-proj-datadir">数据目录 (dataDir)</label>
            <input
              id="cfg-proj-datadir"
              value={draft.dataDir}
              placeholder=".questboard-data"
              onChange={(e) => onChange({ dataDir: e.target.value })}
            />
            <span className="path-resolved-help">
              解析绝对路径：<code>{paths.data}</code>
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="cfg-proj-events">事件日志 (events)</label>
            <input
              id="cfg-proj-events"
              value={draft.events}
              placeholder=".questboard-data/events.jsonl"
              onChange={(e) => onChange({ events: e.target.value })}
            />
            <span className="path-resolved-help">
              解析绝对路径：<code>{paths.events}</code>
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="cfg-proj-registry">注册表 (registry)</label>
            <input
              id="cfg-proj-registry"
              value={draft.registry}
              placeholder=".questboard-data/registry.jsonl"
              onChange={(e) => onChange({ registry: e.target.value })}
            />
            <span className="path-resolved-help">
              解析绝对路径：<code>{paths.registry}</code>
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="cfg-proj-lockfile">文件锁 (lockFile)</label>
            <input
              id="cfg-proj-lockfile"
              value={draft.lockFile}
              placeholder=".questboard-data/dispatch.lock"
              onChange={(e) => onChange({ lockFile: e.target.value })}
            />
            <span className="path-resolved-help">
              解析绝对路径：<code>{paths.lock}</code>
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="cfg-proj-bash">Shell 路径 (bash - 可选)</label>
            <input
              id="cfg-proj-bash"
              value={draft.bash}
              placeholder="例如 C:\Program Files\Git\bin\bash.exe 或 /bin/bash"
              onChange={(e) => onChange({ bash: e.target.value })}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
