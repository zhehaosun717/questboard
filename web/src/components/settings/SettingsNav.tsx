export type SettingsGroupId = 'project-files' | 'execution' | 'policy' | 'local';

interface SettingsNavProps {
  activeGroup: SettingsGroupId;
  groupErrors: Record<SettingsGroupId, boolean>;
  onSelect: (group: SettingsGroupId) => void;
}

const groups: Array<{ id: SettingsGroupId; label: string; hint: string }> = [
  { id: 'project-files', label: '项目与文件', hint: '项目、简报、评审页' },
  { id: 'execution', label: '接入方式', hint: '接入方式与运行参数' },
  { id: 'policy', label: '派出禁令', hint: '规则与限制' },
  { id: 'local', label: '本机与连接', hint: '只读检查' },
];

export function SettingsNav({ activeGroup, groupErrors, onSelect }: SettingsNavProps) {
  return (
    <aside className="settings-nav" aria-label="设置分组">
      <div className="settings-nav-heading">设置分组</div>
      <nav>
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            className={`settings-nav-item ${activeGroup === group.id ? 'active' : ''}`}
            aria-current={activeGroup === group.id ? 'page' : undefined}
            onClick={() => onSelect(group.id)}
          >
            <span className="settings-nav-label">
              {group.label}
              {groupErrors[group.id] ? <span className="settings-nav-error">!</span> : null}
            </span>
            <span className="settings-nav-hint">{group.hint}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
