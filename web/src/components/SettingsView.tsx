import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { SettingsReport } from '../api/types';

export function SettingsView() {
  const [settings, setSettings] = useState<SettingsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    api
      .settings()
      .then((data) => {
        if (mounted) {
          setSettings(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) {
    return <div className="hint settings-loading">正在读取系统配置…</div>;
  }

  if (error) {
    return <div className="warn-tape settings-error">读取系统设置失败：{error}</div>;
  }

  if (!settings) {
    return <div className="empty">未能获取系统配置</div>;
  }

  const { project, home, usageKeys, openCodeAuthFile, omo } = settings;

  return (
    <div className="settings-view-container">
      <header className="settings-view-header">
        <div>
          <span className="eyebrow">SYSTEM CONFIGURATION</span>
          <h2>系统设置</h2>
          <p className="settings-top-notice">
            这里只显示，修改请改项目里的 questboard.config.json 或 ~/.questboard 下的文件.
          </p>
        </div>
      </header>

      {/* 1. 项目 */}
      <section className="settings-section">
        <h3 className="settings-sec-title">项目 (Project)</h3>
        <div className="settings-card">
          <dl className="settings-grid-dl">
            <dt>项目名称</dt>
            <dd><strong>{project.name}</strong></dd>
            <dt>项目根目录</dt>
            <dd><code className="path-cell">{project.root}</code></dd>
            <dt>服务端口</dt>
            <dd><code>{project.port}</code></dd>
            <dt>数据路径</dt>
            <dd><code className="path-cell">{project.paths.data}</code></dd>
            <dt>事件日志</dt>
            <dd><code className="path-cell">{project.paths.events}</code></dd>
            <dt>注册表</dt>
            <dd><code className="path-cell">{project.paths.registry}</code></dd>
            <dt>文件锁</dt>
            <dd><code className="path-cell">{project.paths.lock}</code></dd>
            <dt>需求简报</dt>
            <dd className="wrap-dd">
              <span>派遣目录：{project.briefs.dispatchDirs.join(', ') || '无'}</span>
              <span>负责人目录：{project.briefs.ownerDirs.join(', ') || '无'}</span>
              <span>天数窗口：最近 {project.briefs.recentDays} 天</span>
            </dd>
            <dt>评审页面目录</dt>
            <dd>
              {project.reviewPagesDir ? (
                <code className="path-cell">{project.reviewPagesDir}</code>
              ) : (
                <span className="muted">未设置</span>
              )}
            </dd>
          </dl>
        </div>
      </section>

      {/* 2. 通道 */}
      <section className="settings-section">
        <h3 className="settings-sec-title">通道 (Lanes)</h3>
        <div className="roster-table-wrap">
          <table className="roster-table settings-lanes-table">
            <thead>
              <tr>
                <th style={{ width: '120px' }}>通道 ID</th>
                <th>执行命令 (Run)</th>
                <th>输出 / 接口</th>
                <th style={{ width: '100px' }}>并发策略</th>
                <th style={{ width: '140px' }}>默认模型</th>
              </tr>
            </thead>
            <tbody>
              {project.lanes.map((lane) => (
                <tr key={lane.id}>
                  <td><strong>{lane.id}</strong></td>
                  <td>
                    <code className="lane-cmd">
                      {lane.run.length > 0 ? lane.run.join(' ') : '无'}
                    </code>
                  </td>
                  <td>
                    {lane.outputDir ? (
                      <div>输出目录：<code className="path-cell">{lane.outputDir}</code></div>
                    ) : null}
                    {lane.api ? (
                      <div>接口：<code>{lane.api}</code></div>
                    ) : null}
                    {!lane.outputDir && !lane.api ? <span className="muted">-</span> : null}
                  </td>
                  <td>
                    <span className={`policy-tag ${lane.serialize ? 'serialize' : 'parallel'}`}>
                      {lane.serialize ? '排队' : '并行'}
                    </span>
                  </td>
                  <td>
                    {lane.defaultModel ? <code>{lane.defaultModel}</code> : <span className="muted">-</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 3. 规则 */}
      <section className="settings-section">
        <h3 className="settings-sec-title">规则 (Policy)</h3>
        <div className="settings-card">
          <dl className="settings-grid-dl">
            <dt>禁止模型模式</dt>
            <dd>
              {project.policy.bannedModelPatterns?.length > 0 ? (
                <div className="chips-list">
                  {project.policy.bannedModelPatterns.map((pat, idx) => (
                    <code key={idx} className="banned-pattern">{pat}</code>
                  ))}
                </div>
              ) : <span className="muted">无</span>}
            </dd>
            <dt>禁止代理</dt>
            <dd>
              {project.policy.bannedAgents?.length > 0 ? (
                <div className="chips-list">
                  {project.policy.bannedAgents.map((ag, idx) => (
                    <span key={idx} className="tag-strength">{ag}</span>
                  ))}
                </div>
              ) : <span className="muted">无</span>}
            </dd>
          </dl>
        </div>
      </section>

      {/* 4. 本机 */}
      <section className="settings-section">
        <h3 className="settings-sec-title">本机 (Local Environment)</h3>
        <div className="settings-card">
          <dl className="settings-grid-dl">
            <dt>Questboard 主目录</dt>
            <dd><code className="path-cell">{home.dir}</code></dd>
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
            <dd><code className="path-cell">{home.status}</code></dd>
            <dt>OpenCode 登录文件</dt>
            <dd>
              <code className="path-cell">{openCodeAuthFile.file}</code>
              <span className={openCodeAuthFile.exists ? 'file-present-hint' : 'file-missing-hint'}>
                {openCodeAuthFile.exists ? '（已存在）' : '（不存在）'}
              </span>
            </dd>
            <dt>OMO 配置文件</dt>
            <dd>
              <code className="path-cell">{omo.file}</code>
              <span className={omo.exists ? 'file-present-hint' : 'file-missing-hint'}>
                {omo.exists ? '（已存在）' : '（不存在）'}
              </span>
            </dd>
          </dl>
        </div>
      </section>

      {/* 5. 用量 key */}
      <section className="settings-section">
        <h3 className="settings-sec-title">用量密钥 (Usage Keys)</h3>
        <p className="hint">key 只在服务器内存里用，不会显示也不会保存.</p>
        <div className="settings-card">
          <div className="usage-keys-list">
            {usageKeys.map((item) => (
              <div key={item.id} className="usage-key-row">
                <div className="usage-key-provider">
                  <strong>{item.name}</strong>
                  <code className="muted">{item.id}</code>
                </div>
                <div className="usage-key-sources">
                  {item.sources.map((src, idx) => {
                    const label = src.kind === 'env' ? `环境变量 ${src.name}` : `OpenCode 登录 ${src.name}`;
                    return (
                      <span key={idx} className={`chip ${src.present ? 'ok' : 'dim'}`}>
                        <i className={`led ${src.present ? 'ok' : ''}`} />
                        {label}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
