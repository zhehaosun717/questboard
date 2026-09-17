import type { ProjectDraft } from '../../lib/settingsForm';
import { useT } from '../../lib/i18n';

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
  const t = useT();
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">{t('settingsProject.title')}</h3>
      <div className="settings-card">
        <div className="settings-fields-grid">
          <div className="form-field">
            <label htmlFor="cfg-proj-name">
              {t('settingsProject.name')}
              {errors['project.name'] ? (
                <span className="field-error"> · {errors['project.name']}</span>
              ) : null}
            </label>
            <input
              id="cfg-proj-name"
              value={draft.name}
              placeholder={t('settingsProject.namePlaceholder')}
              onChange={(e) => onChange({ name: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label htmlFor="cfg-proj-port">
              {t('settingsProject.port')}
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
            <label htmlFor="cfg-proj-datadir">{t('settingsProject.dataDir')}</label>
            <input
              id="cfg-proj-datadir"
              value={draft.dataDir}
              placeholder=".questboard-data"
              onChange={(e) => onChange({ dataDir: e.target.value })}
            />
            <span className="path-resolved-help">
              {t('settingsProject.resolved')}<code>{paths.data}</code>
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="cfg-proj-events">{t('settingsProject.events')}</label>
            <input
              id="cfg-proj-events"
              value={draft.events}
              placeholder=".questboard-data/events.jsonl"
              onChange={(e) => onChange({ events: e.target.value })}
            />
            <span className="path-resolved-help">
              {t('settingsProject.resolved')}<code>{paths.events}</code>
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="cfg-proj-registry">{t('settingsProject.registry')}</label>
            <input
              id="cfg-proj-registry"
              value={draft.registry}
              placeholder=".questboard-data/registry.jsonl"
              onChange={(e) => onChange({ registry: e.target.value })}
            />
            <span className="path-resolved-help">
              {t('settingsProject.resolved')}<code>{paths.registry}</code>
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="cfg-proj-lockfile">{t('settingsProject.lockFile')}</label>
            <input
              id="cfg-proj-lockfile"
              value={draft.lockFile}
              placeholder=".questboard-data/dispatch.lock"
              onChange={(e) => onChange({ lockFile: e.target.value })}
            />
            <span className="path-resolved-help">
              {t('settingsProject.resolved')}<code>{paths.lock}</code>
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="cfg-proj-bash">{t('settingsProject.bash')}</label>
            <input
              id="cfg-proj-bash"
              value={draft.bash}
              placeholder={t('settingsProject.bashPlaceholder')}
              onChange={(e) => onChange({ bash: e.target.value })}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
