import type { SettingsReport } from '../../api/types';
import { LOCALE_OPTIONS, setLocale, useLocale, useT, type Locale } from '../../lib/i18n';
import { NotificationsSection } from './NotificationsSection';

interface SettingsLocalSectionProps {
  home: SettingsReport['home'];
  openCodeAuthFile: SettingsReport['openCodeAuthFile'];
  omo: SettingsReport['omo'];
}

export function SettingsLocalSection({
  home,
  openCodeAuthFile,
  omo,
}: SettingsLocalSectionProps) {
  const t = useT();
  const locale = useLocale();
  return (
    <>
      <section className="settings-section">
        <h3 className="settings-sec-title">{t('settingsLocal.title')}</h3>
        <div className="settings-card">
          <dl className="settings-grid-dl">
            <dt>{t('settingsLocal.homeDir')}</dt>
            <dd>
              <code className="path-cell">{home.dir}</code>
            </dd>
            <dt>{t('settingsLocal.roster')}</dt>
            <dd>
              <code className="path-cell">{home.roster}</code>
              {!home.rosterExists ? (
                <span className="file-missing-hint">{t('settingsLocal.rosterMissing')}</span>
              ) : (
                <span className="file-present-hint">{t('settingsLocal.rosterPresent')}</span>
              )}
            </dd>
            <dt>{t('settingsLocal.statusLog')}</dt>
            <dd>
              <code className="path-cell">{home.status}</code>
            </dd>
            <dt>{t('settingsLocal.openCodeAuth')}</dt>
            <dd>
              <code className="path-cell">{openCodeAuthFile.file}</code>
              <span
                className={
                  openCodeAuthFile.exists
                    ? 'file-present-hint'
                    : 'file-missing-hint'
                }
              >
                {openCodeAuthFile.exists ? t('settingsLocal.rosterPresent') : t('settingsLocal.fileMissing')}
              </span>
            </dd>
            <dt>{t('settingsLocal.omoFile')}</dt>
            <dd>
              <code className="path-cell">{omo.file}</code>
              <span
                className={
                  omo.exists ? 'file-present-hint' : 'file-missing-hint'
                }
              >
                {omo.exists ? t('settingsLocal.rosterPresent') : t('settingsLocal.fileMissing')}
              </span>
            </dd>
            <dt>{t('settingsLocal.locale')}</dt>
            <dd>
              <select
                value={locale}
                aria-label={t('settingsLocal.locale')}
                onChange={(e) => setLocale(e.target.value as Locale)}
              >
                {LOCALE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="muted">{t('settingsLocal.localeNote')}</span>
            </dd>
          </dl>
        </div>
      </section>
      <NotificationsSection />
    </>
  );
}
