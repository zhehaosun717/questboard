import type { VerificationDraft, VerificationHookDraft } from '../../lib/settingsForm';

interface SettingsVerificationSectionProps {
  draft: VerificationDraft;
  onChange: (patch: Partial<VerificationDraft>) => void;
}

function commandText(command: string[]): string {
  return JSON.stringify(command);
}

export function SettingsVerificationSection({ draft, onChange }: SettingsVerificationSectionProps) {
  const updateHook = (index: number, patch: Partial<VerificationHookDraft>) => {
    onChange({ hooks: draft.hooks.map((hook, current) => (current === index ? { ...hook, ...patch } : hook)) });
  };

  return (
    <section className="settings-section verification-settings" aria-labelledby="verification-hooks-title">
      <div>
        <h3 id="verification-hooks-title" className="settings-sec-title">交付后验证钩子</h3>
        <p className="settings-group-caption">只在项目配置中启用；任务简报、远程请求和任务内容不能添加或修改钩子。</p>
      </div>
      {draft.hooks.length === 0 ? (
        <div className="settings-card verification-empty">项目没有配置验证钩子。默认不会运行任何项目命令。</div>
      ) : (
        <div className="verification-hook-list">
          {draft.hooks.map((hook, index) => (
            <article className="settings-card verification-hook-card" key={`${hook.id}-${index}`}>
              <div className="verification-hook-heading">
                <div>
                  <h4>{hook.id}</h4>
                  <p>触发：交付完成 · 适用：{hook.kinds.join('、') || '未设置'}</p>
                </div>
                <label className="checkbox-row verification-hook-toggle">
                  <input
                    type="checkbox"
                    aria-label={`启用验证钩子 ${hook.id}`}
                    checked={hook.enabled}
                    onChange={(event) => updateHook(index, { enabled: event.target.checked })}
                  />
                  启用
                </label>
              </div>
              <dl className="settings-grid-dl verification-hook-details">
                <dt>精确 argv</dt><dd><code className="lane-cmd">{commandText(hook.command)}</code></dd>
                <dt>工作目录</dt><dd><code className="path-cell">{hook.cwd}</code></dd>
                <dt>超时</dt><dd>{hook.timeoutSeconds || '未设置'} 秒</dd>
                <dt>可继承环境名</dt><dd><code className="lane-cmd">{hook.envKeys.join(', ') || '无'}</code></dd>
              </dl>
            </article>
          ))}
        </div>
      )}
      <p className="config-policy-footnote">保存后需要重启看板才会生效。钩子结果只作为证据，不会自动改变任务状态。</p>
      <p className="config-policy-footnote">argv 第一项写 node 会被替换成看板自己的 Node；每一项都不能是空字符串。Windows 上大多数命令还需要在可继承环境名里加上 PATH 和 SystemRoot，否则子进程可能启动不了。</p>
    </section>
  );
}

export default SettingsVerificationSection;
