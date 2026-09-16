import type { SettingsReport } from '../../api/types';
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
  return (
    <>
      <section className="settings-section">
        <h3 className="settings-sec-title">本机 (Local Environment)</h3>
        <div className="settings-card">
          <dl className="settings-grid-dl">
            <dt>Questboard 主目录</dt>
            <dd>
              <code className="path-cell">{home.dir}</code>
            </dd>
            <dt>名册文件</dt>
            <dd>
              <code className="path-cell">{home.roster}</code>
              {!home.rosterExists ? (
                <span className="file-missing-hint">（还没有名册）</span>
              ) : (
                <span className="file-present-hint">（已存在）</span>
              )}
            </dd>
            <dt>状态日志</dt>
            <dd>
              <code className="path-cell">{home.status}</code>
            </dd>
            <dt>OpenCode 登录文件</dt>
            <dd>
              <code className="path-cell">{openCodeAuthFile.file}</code>
              <span
                className={
                  openCodeAuthFile.exists
                    ? 'file-present-hint'
                    : 'file-missing-hint'
                }
              >
                {openCodeAuthFile.exists ? '（已存在）' : '（不存在）'}
              </span>
            </dd>
            <dt>OMO 配置文件</dt>
            <dd>
              <code className="path-cell">{omo.file}</code>
              <span
                className={
                  omo.exists ? 'file-present-hint' : 'file-missing-hint'
                }
              >
                {omo.exists ? '（已存在）' : '（不存在）'}
              </span>
            </dd>
          </dl>
        </div>
      </section>
      <NotificationsSection />
    </>
  );
}
